#!/usr/bin/env node
'use strict';

/**
 * End-to-end tests for the security_audit capability.
 *
 * Validates that when security_audit is activated via .claw/capabilities.json,
 * the pipeline correctly:
 *   1. Injects security-audit stage into the chain (analyze → security-audit → plan)
 *   2. Resolves template and schema from capability dir
 *   3. Full pipeline run through security-audit with artifact gating
 *   4. Scaffold generates minimal valid artifact
 *   5. record_artifact validates against capability schema
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');

const ENGINE_ROOT = path.resolve(__dirname, '..', '..', '..');
const DP_SCRIPT = path.join(ENGINE_ROOT, 'skills', 'dev-pipeline', 'scripts', 'dev-pipeline.js');

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${label}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${label}`);
    console.log(`         ${e.message}`);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-e2e-'));
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

function makeWorkspace() {
  const ws = fs.mkdtempSync(path.join(TMP, 'ws-'));
  fs.mkdirSync(path.join(ws, '.claw', 'runs'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.claw', 'tickets'), { recursive: true });
  fs.writeFileSync(
    path.join(ws, '.claw', 'capabilities.json'),
    JSON.stringify({ capabilities: ['security_audit'] }),
    'utf8'
  );
  return ws;
}

function dp(ws, command) {
  const cmd = `node "${DP_SCRIPT}" ${command}`;
  const env = { ...process.env, WORKSPACE_ROOT: ws };
  return JSON.parse(execSync(cmd, { encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] }));
}

function writePmBrief(rf, ticketId) {
  fs.writeFileSync(path.join(rf, '10-pm-brief.json'), JSON.stringify({
    ticket_id: ticketId, title: 't', project: 'p',
    problem_statement: 'x', scope: 'y', acceptance_criteria: [],
  }), 'utf8');
}

function validSecurityAudit(ticketId) {
  return {
    ticket_id: ticketId,
    findings: [{
      id: 'SEC-001', severity: 'high', category: 'auth',
      description: 'Missing rate limiting on login', evidence: ['src/api/login.ts'],
      recommendation: 'Add rate limiting middleware',
    }],
    summary: { total_findings: 1, by_severity: { critical: 0, high: 1, medium: 0, low: 0 } },
  };
}

// =========================================================================
// Stage chain injection
// =========================================================================
console.log('\n--- Stage chain injection (security_audit) ---');

test('loadCapabilities returns security-audit stage', () => {
  const { loadCapabilities } = require('../scripts/capability-registry.js');
  const { DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP } = require('../scripts/dev-pipeline.js');

  const ws = makeWorkspace();
  const result = loadCapabilities(ws, ENGINE_ROOT, DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP);

  assert.ok(result.stageConfig['security-audit']);
  assert.strictEqual(result.stageConfig['analyze'].next, 'security-audit');
  assert.strictEqual(result.stageConfig['security-audit'].next, 'plan');
  assert.strictEqual(result.stageConfig['security-audit'].role, 'Security Analyst');
  assert.deepStrictEqual(result.stageConfig['security-audit'].requiredArtifacts, ['16-security-audit.json']);
});

test('chain: analyze → security-audit → plan → implement → validate → review → done', () => {
  const { loadCapabilities } = require('../scripts/capability-registry.js');
  const { DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP } = require('../scripts/dev-pipeline.js');

  const ws = makeWorkspace();
  const config = loadCapabilities(ws, ENGINE_ROOT, DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP).stageConfig;

  const visited = [];
  let stage = 'analyze';
  while (stage !== 'done') { visited.push(stage); stage = config[stage].next; }
  assert.deepStrictEqual(visited, ['analyze', 'security-audit', 'plan', 'implement', 'validate', 'review']);
});

// =========================================================================
// Template and schema resolution
// =========================================================================
console.log('\n--- Template and schema resolution ---');

test('resolveTemplatePath finds claude-security-pack.txt in capability', () => {
  const { resolveTemplatePath } = require('../scripts/capability-registry.js');
  const capDir = path.join(ENGINE_ROOT, 'skills', 'capabilities', 'security_audit');
  const resolved = resolveTemplatePath('claude-security-pack.txt', [capDir], ENGINE_ROOT);
  assert.ok(resolved.includes('capabilities/security_audit/templates/'));
});

test('template contains expected placeholders', () => {
  const tpl = fs.readFileSync(
    path.join(ENGINE_ROOT, 'skills', 'capabilities', 'security_audit', 'templates', 'claude-security-pack.txt'), 'utf8');
  assert.ok(tpl.includes('{{TICKET_ID}}'));
  assert.ok(tpl.includes('Security Analyst'));
  assert.ok(tpl.includes('16-security-audit.json'));
});

test('resolveSchemaPath finds security-audit.schema.json in capability', () => {
  const { resolveSchemaPath } = require('../scripts/capability-registry.js');
  const capDir = path.join(ENGINE_ROOT, 'skills', 'capabilities', 'security_audit');
  const resolved = resolveSchemaPath('security-audit.schema.json', [capDir], ENGINE_ROOT);
  assert.ok(resolved);
  assert.ok(resolved.includes('capabilities/security_audit/references/'));
});

test('artifactSchemaMap includes 16-security-audit.json mapping', () => {
  const { loadCapabilities } = require('../scripts/capability-registry.js');
  const { DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP } = require('../scripts/dev-pipeline.js');
  const ws = makeWorkspace();
  const result = loadCapabilities(ws, ENGINE_ROOT, DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP);
  assert.strictEqual(result.artifactSchemaMap['16-security-audit.json'], 'security-audit.schema.json');
});

// =========================================================================
// Full pipeline run
// =========================================================================
console.log('\n--- Full pipeline run ---');

const _ctx = {};

test('create_run → task_pack → analyze', () => {
  _ctx.ws = makeWorkspace();
  const cr = dp(_ctx.ws, 'create_run TEST-SEC-1 "Security audit test" test-proj');
  _ctx.rf = cr.run_folder;
  dp(_ctx.ws, `generate_task_pack ${_ctx.rf}`);
  const r = dp(_ctx.ws, `run_next_safe ${_ctx.rf}`);
  assert.strictEqual(r.advanced_to, 'analyze');
});

test('analyze → security-audit after PM brief', () => {
  writePmBrief(_ctx.rf, 'TEST-SEC-1');
  const r = dp(_ctx.ws, `run_next_safe ${_ctx.rf}`);
  assert.strictEqual(r.advanced_to, 'security-audit');
  assert.strictEqual(r.role, 'Security Analyst');
});

test('security-audit generates task file from capability template', () => {
  const taskPath = path.join(_ctx.rf, '37-security-audit-task.txt');
  assert.ok(fs.existsSync(taskPath));
  const content = fs.readFileSync(taskPath, 'utf8');
  assert.ok(content.includes('TEST-SEC-1'));
  assert.ok(content.includes('Security Analyst'));
});

test('security-audit waits for 16-security-audit.json', () => {
  const r = dp(_ctx.ws, `next_stage ${_ctx.rf}`);
  assert.strictEqual(r.gates_pass, false);
  assert.ok(r.missing_artifacts.includes('16-security-audit.json'));
});

test('valid artifact advances security-audit → plan', () => {
  fs.writeFileSync(path.join(_ctx.rf, '16-security-audit.json'),
    JSON.stringify(validSecurityAudit('TEST-SEC-1')), 'utf8');
  const r = dp(_ctx.ws, `run_next_safe ${_ctx.rf}`);
  assert.strictEqual(r.advanced_to, 'plan');
});

test('pipeline completes through to done', () => {
  const rf = _ctx.rf;
  const ws = _ctx.ws;
  fs.writeFileSync(path.join(rf, '20-arch-design.json'),
    JSON.stringify({ ticket_id: 'TEST-SEC-1', approach: 'a', components: [], file_changes: [] }), 'utf8');
  dp(ws, `run_next_safe ${rf}`); // → implement
  fs.writeFileSync(path.join(rf, '40-dev-patch.diff'), 'diff --git a/f b/f\n+x\n', 'utf8');
  fs.writeFileSync(path.join(rf, '41-dev-notes.json'),
    JSON.stringify({ ticket_id: 'TEST-SEC-1', files_changed: [], summary: 's' }), 'utf8');
  dp(ws, `run_next_safe ${rf}`); // → validate
  fs.writeFileSync(path.join(rf, '50-qa-report.json'),
    JSON.stringify({ ticket_id: 'TEST-SEC-1', tests_run: 1, tests_passed: 1, tests_failed: 0, verdict: 'pass' }), 'utf8');
  dp(ws, `run_next_safe ${rf}`); // → review
  fs.writeFileSync(path.join(rf, '60-review-report.json'),
    JSON.stringify({ ticket_id: 'TEST-SEC-1', stage_compliance: true, artifact_validation: true, verdict: 'approved' }), 'utf8');
  const r = dp(ws, `run_next_safe ${rf}`);
  assert.strictEqual(r.advanced_to, 'done');
});

test('stage_history records security-audit', () => {
  const status = dp(_ctx.ws, `status ${_ctx.rf}`);
  const stages = status.run.stage_history.map(h => h.stage);
  assert.ok(stages.includes('security-audit'));
});

// =========================================================================
// Scaffold
// =========================================================================
console.log('\n--- Scaffold ---');

test('scaffold_artifacts creates minimal valid 16-security-audit.json', () => {
  const ws = makeWorkspace();
  const cr = dp(ws, 'create_run TEST-SCAF-S1 "Scaffold test" proj');
  const rf = cr.run_folder;
  dp(ws, `generate_task_pack ${rf}`);
  dp(ws, `run_next_safe ${rf}`); // → analyze
  writePmBrief(rf, 'TEST-SCAF-S1');
  dp(ws, `run_next_safe ${rf}`); // → security-audit

  const sr = dp(ws, `scaffold_artifacts ${rf}`);
  assert.ok(sr.scaffolded.includes('16-security-audit.json'));
  const artifact = JSON.parse(fs.readFileSync(path.join(rf, '16-security-audit.json'), 'utf8'));
  assert.strictEqual(artifact.ticket_id, 'TEST-SCAF-S1');
  assert.ok(Array.isArray(artifact.findings));
  assert.ok(artifact.summary);
});

// =========================================================================
// Artifact validation
// =========================================================================
console.log('\n--- Artifact validation ---');

test('record_artifact validates valid 16-security-audit.json', () => {
  const ws = makeWorkspace();
  const cr = dp(ws, 'create_run TEST-VAL-S1 "Val test" proj');
  const rf = cr.run_folder;
  dp(ws, `generate_task_pack ${rf}`);
  dp(ws, `run_next_safe ${rf}`);
  writePmBrief(rf, 'TEST-VAL-S1');
  dp(ws, `run_next_safe ${rf}`);

  fs.writeFileSync(path.join(rf, '16-security-audit.json'),
    JSON.stringify(validSecurityAudit('TEST-VAL-S1')), 'utf8');
  const r = dp(ws, `record_artifact ${rf} ${path.join(rf, '16-security-audit.json')}`);
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.gates_pass, true);
});

test('record_artifact rejects invalid 16-security-audit.json', () => {
  const ws = makeWorkspace();
  const cr = dp(ws, 'create_run TEST-INV-S1 "Inv test" proj');
  const rf = cr.run_folder;
  dp(ws, `generate_task_pack ${rf}`);
  dp(ws, `run_next_safe ${rf}`);
  writePmBrief(rf, 'TEST-INV-S1');
  dp(ws, `run_next_safe ${rf}`);

  fs.writeFileSync(path.join(rf, '16-security-audit.json'),
    JSON.stringify({ ticket_id: 'TEST-INV-S1' }), 'utf8');
  const r = dp(ws, `record_artifact ${rf} ${path.join(rf, '16-security-audit.json')}`);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.length > 0);
});

// =========================================================================
// Summary
// =========================================================================
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
