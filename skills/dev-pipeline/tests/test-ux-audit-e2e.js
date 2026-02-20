#!/usr/bin/env node
'use strict';

/**
 * End-to-end tests for the ux_audit capability.
 *
 * Validates that when ux_audit is activated via .claw/capabilities.json,
 * the pipeline correctly:
 *   1. Injects ux-audit stage into the chain (analyze → ux-audit → plan)
 *   2. Resolves the UX template from capability dir (not core)
 *   3. Resolves the UX artifact schema from capability dir
 *   4. Full pipeline run: create_run → task_pack → advance through ux-audit → done
 *   5. Stage migration: ux-ready normalizes to ux-audit
 *   6. Scaffold generates minimal ux-audit artifact that passes schema validation
 *
 * These tests spawn subprocesses with WORKSPACE_ROOT pointed at a temp dir,
 * so the _initRegistry() IIFE in dev-pipeline.js picks up the capability.
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

// ---------------------------------------------------------------------------
// Helpers: create a temp workspace with ux_audit capability enabled
// ---------------------------------------------------------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-e2e-'));
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

function makeWorkspace() {
  const ws = fs.mkdtempSync(path.join(TMP, 'ws-'));
  fs.mkdirSync(path.join(ws, '.claw', 'runs'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.claw', 'tickets'), { recursive: true });
  // Activate ux_audit capability
  fs.writeFileSync(
    path.join(ws, '.claw', 'capabilities.json'),
    JSON.stringify({ capabilities: ['ux_audit'] }),
    'utf8'
  );
  return ws;
}

function dp(ws, command) {
  const cmd = `node "${DP_SCRIPT}" ${command}`;
  const env = { ...process.env, WORKSPACE_ROOT: ws };
  const output = execSync(cmd, { encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] });
  return JSON.parse(output);
}

// =========================================================================
// Test group 1: Stage chain injection via real capability
// =========================================================================
console.log('\n--- Stage chain injection (real ux_audit capability) ---');

test('loadCapabilities with real ux_audit capability returns ux-audit stage', () => {
  const { loadCapabilities } = require('../scripts/capability-registry.js');
  const { DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP } = require('../scripts/dev-pipeline.js');

  const ws = makeWorkspace();
  const result = loadCapabilities(ws, ENGINE_ROOT, DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP);

  assert.ok(result.stageConfig['ux-audit'], 'ux-audit stage should be in stageConfig');
  assert.strictEqual(result.stageConfig['analyze'].next, 'ux-audit');
  assert.strictEqual(result.stageConfig['ux-audit'].next, 'plan');
  assert.strictEqual(result.stageConfig['ux-audit'].role, 'UX Analyst');
  assert.deepStrictEqual(result.stageConfig['ux-audit'].requiredArtifacts, ['15-ux-audit.json']);
});

test('chain with ux_audit: analyze → ux-audit → plan → implement → validate → review → done', () => {
  const { loadCapabilities } = require('../scripts/capability-registry.js');
  const { DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP } = require('../scripts/dev-pipeline.js');

  const ws = makeWorkspace();
  const result = loadCapabilities(ws, ENGINE_ROOT, DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP);
  const config = result.stageConfig;

  const visited = [];
  let stage = 'analyze';
  let safety = 0;
  while (stage !== 'done' && safety < 20) {
    visited.push(stage);
    stage = config[stage].next;
    safety++;
  }
  assert.strictEqual(stage, 'done');
  assert.deepStrictEqual(visited, ['analyze', 'ux-audit', 'plan', 'implement', 'validate', 'review']);
});

test('capabilityDirs includes the real ux_audit directory', () => {
  const { loadCapabilities } = require('../scripts/capability-registry.js');
  const { DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP } = require('../scripts/dev-pipeline.js');

  const ws = makeWorkspace();
  const result = loadCapabilities(ws, ENGINE_ROOT, DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP);

  assert.strictEqual(result.capabilityDirs.length, 1);
  assert.ok(result.capabilityDirs[0].endsWith('ux_audit'));
});

// =========================================================================
// Test group 2: Template resolution from capability
// =========================================================================
console.log('\n--- Template resolution ---');

test('resolveTemplatePath finds claude-ux-pack.txt in capability, not core', () => {
  const { resolveTemplatePath } = require('../scripts/capability-registry.js');

  const uxCapDir = path.join(ENGINE_ROOT, 'skills', 'capabilities', 'ux_audit');
  const resolved = resolveTemplatePath('claude-ux-pack.txt', [uxCapDir], ENGINE_ROOT);

  assert.ok(resolved.includes('skills/capabilities/ux_audit/templates/claude-ux-pack.txt'),
    `Expected capability path, got: ${resolved}`);
  // Verify the core templates/ does NOT have it anymore
  assert.ok(!fs.existsSync(path.join(ENGINE_ROOT, 'templates', 'claude-ux-pack.txt')),
    'claude-ux-pack.txt should NOT exist in core templates/');
});

test('resolved UX template contains expected placeholders', () => {
  const templatePath = path.join(ENGINE_ROOT, 'skills', 'capabilities', 'ux_audit', 'templates', 'claude-ux-pack.txt');
  const content = fs.readFileSync(templatePath, 'utf8');

  assert.ok(content.includes('{{TICKET_ID}}'));
  assert.ok(content.includes('{{TITLE}}'));
  assert.ok(content.includes('{{PROJECT_NAME}}'));
  assert.ok(content.includes('{{RUN_FOLDER}}'));
  assert.ok(content.includes('UX Analyst'));
  assert.ok(content.includes('15-ux-audit.json'));
});

// =========================================================================
// Test group 3: Schema resolution from capability
// =========================================================================
console.log('\n--- Schema resolution ---');

test('resolveSchemaPath finds ux-audit.schema.json in capability', () => {
  const { resolveSchemaPath } = require('../scripts/capability-registry.js');

  const uxCapDir = path.join(ENGINE_ROOT, 'skills', 'capabilities', 'ux_audit');
  const resolved = resolveSchemaPath('ux-audit.schema.json', [uxCapDir], ENGINE_ROOT);

  assert.ok(resolved, 'should find ux-audit.schema.json');
  assert.ok(resolved.includes('skills/capabilities/ux_audit/references/ux-audit.schema.json'),
    `Expected capability path, got: ${resolved}`);
});

test('ux-audit.schema.json is NOT in core references anymore', () => {
  const corePath = path.join(ENGINE_ROOT, 'skills', 'dev-pipeline', 'references', 'ux-audit.schema.json');
  assert.ok(!fs.existsSync(corePath), 'ux-audit.schema.json should NOT exist in core references/');
});

test('artifactSchemaMap includes 15-ux-audit.json mapping', () => {
  const { loadCapabilities } = require('../scripts/capability-registry.js');
  const { DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP } = require('../scripts/dev-pipeline.js');

  const ws = makeWorkspace();
  const result = loadCapabilities(ws, ENGINE_ROOT, DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP);

  assert.strictEqual(result.artifactSchemaMap['15-ux-audit.json'], 'ux-audit.schema.json');
});

// =========================================================================
// Test group 4: Full pipeline run with ux-audit stage
// =========================================================================
console.log('\n--- Full pipeline run ---');

let runFolder;

test('create_run succeeds with ux_audit capability active', () => {
  const ws = makeWorkspace();
  const result = dp(ws, 'create_run TEST-UX-1 "UX audit test" test-project');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.status, 'intake');
  runFolder = result.run_folder;

  // Store ws for later tests
  test._ws = ws;
  test._runFolder = runFolder;
});

test('generate_task_pack moves to task-pack-generated', () => {
  const ws = test._ws;
  const rf = test._runFolder;
  const result = dp(ws, `generate_task_pack ${rf}`);
  assert.strictEqual(result.ok, true);

  const status = dp(ws, `status ${rf}`);
  assert.strictEqual(status.run.current_stage, 'task-pack-generated');
});

test('run_next_safe advances task-pack-generated → analyze', () => {
  const ws = test._ws;
  const rf = test._runFolder;
  const result = dp(ws, `run_next_safe ${rf}`);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.advanced_to, 'analyze');
  assert.strictEqual(result.role, 'Analyst');
});

test('analyze stage generates role pack and waits for artifact', () => {
  const ws = test._ws;
  const rf = test._runFolder;

  // Write valid PM brief artifact
  const brief = {
    ticket_id: 'TEST-UX-1', title: 'UX audit test', project: 'test-project',
    problem_statement: 'Need UX review', scope: 'checkout flow', acceptance_criteria: [],
  };
  fs.writeFileSync(path.join(rf, '10-pm-brief.json'), JSON.stringify(brief, null, 2), 'utf8');

  // run_next_safe should now advance analyze → ux-audit (not plan!)
  const result = dp(ws, `run_next_safe ${rf}`);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.advanced_to, 'ux-audit', 'Should advance to ux-audit, not plan');
  assert.strictEqual(result.role, 'UX Analyst');
});

test('ux-audit stage generates task file from capability template', () => {
  const ws = test._ws;
  const rf = test._runFolder;

  // The advance should have generated the task file
  const taskFilePath = path.join(rf, '36-ux-audit-task.txt');
  assert.ok(fs.existsSync(taskFilePath), '36-ux-audit-task.txt should exist');

  const content = fs.readFileSync(taskFilePath, 'utf8');
  assert.ok(content.includes('TEST-UX-1'), 'Task file should contain ticket ID');
  assert.ok(content.includes('UX Analyst'), 'Task file should reference UX Analyst role');
  assert.ok(content.includes('15-ux-audit.json'), 'Task file should reference output artifact');
});

test('ux-audit stage waits for 15-ux-audit.json artifact', () => {
  const ws = test._ws;
  const rf = test._runFolder;

  const result = dp(ws, `next_stage ${rf}`);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.gates_pass, false, 'Gates should not pass without artifact');
  assert.ok(result.missing_artifacts.includes('15-ux-audit.json'));
});

test('valid ux-audit artifact passes gates and advances to plan', () => {
  const ws = test._ws;
  const rf = test._runFolder;

  // Write valid UX audit artifact
  const audit = {
    ticket_id: 'TEST-UX-1',
    flow_name: 'checkout',
    routes_audited: ['/checkout', '/checkout/confirm'],
    findings: [{
      id: 'UX-001', route: '/checkout/confirm', severity: 'high',
      category: 'form-friction', description: 'No inline validation',
      evidence: ['src/app/checkout/confirm/page.tsx'],
      recommendation: 'Add inline validation',
    }],
    competitor_notes: [],
    summary: { total_findings: 1, by_severity: { critical: 0, high: 1, medium: 0, low: 0 } },
  };
  fs.writeFileSync(path.join(rf, '15-ux-audit.json'), JSON.stringify(audit, null, 2), 'utf8');

  // run_next_safe should advance ux-audit → plan
  const result = dp(ws, `run_next_safe ${rf}`);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.advanced_to, 'plan', 'Should advance to plan after ux-audit');
  assert.strictEqual(result.role, 'Architect');
});

test('pipeline continues normally after ux-audit: plan → implement → ... → done', () => {
  const ws = test._ws;
  const rf = test._runFolder;

  // Write remaining artifacts to complete the pipeline
  fs.writeFileSync(path.join(rf, '20-arch-design.json'),
    JSON.stringify({ ticket_id: 'TEST-UX-1', approach: 'a', components: [], file_changes: [] }), 'utf8');
  const r1 = dp(ws, `run_next_safe ${rf}`);
  assert.strictEqual(r1.advanced_to, 'implement');

  fs.writeFileSync(path.join(rf, '40-dev-patch.diff'), 'diff --git a/f b/f\n+x\n', 'utf8');
  fs.writeFileSync(path.join(rf, '41-dev-notes.json'),
    JSON.stringify({ ticket_id: 'TEST-UX-1', files_changed: [], summary: 's' }), 'utf8');
  const r2 = dp(ws, `run_next_safe ${rf}`);
  assert.strictEqual(r2.advanced_to, 'validate');

  fs.writeFileSync(path.join(rf, '50-qa-report.json'),
    JSON.stringify({ ticket_id: 'TEST-UX-1', tests_run: 1, tests_passed: 1, tests_failed: 0, verdict: 'pass' }), 'utf8');
  const r3 = dp(ws, `run_next_safe ${rf}`);
  assert.strictEqual(r3.advanced_to, 'review');

  fs.writeFileSync(path.join(rf, '60-review-report.json'),
    JSON.stringify({ ticket_id: 'TEST-UX-1', stage_compliance: true, artifact_validation: true, verdict: 'approved' }), 'utf8');
  const r4 = dp(ws, `run_next_safe ${rf}`);
  assert.strictEqual(r4.advanced_to, 'done');
});

test('stage_history records all 7 stages including ux-audit', () => {
  const ws = test._ws;
  const rf = test._runFolder;

  const status = dp(ws, `status ${rf}`);
  const stages = status.run.stage_history.map(h => h.stage);

  assert.ok(stages.includes('intake'));
  assert.ok(stages.includes('task-pack-generated'));
  assert.ok(stages.includes('analyze'));
  assert.ok(stages.includes('ux-audit'));
  assert.ok(stages.includes('plan'));
  assert.ok(stages.includes('implement'));
  assert.ok(stages.includes('validate'));
  assert.ok(stages.includes('review'));
  assert.ok(stages.includes('done'));
});

// =========================================================================
// Test group 5: Stage migration (ux-ready → ux-audit)
// =========================================================================
console.log('\n--- Stage migration ---');

test('ux-ready stage migrates to ux-audit when capability is active', () => {
  const { loadCapabilities } = require('../scripts/capability-registry.js');
  const { DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP, STAGE_MIGRATION } = require('../scripts/dev-pipeline.js');

  const ws = makeWorkspace();
  const result = loadCapabilities(ws, ENGINE_ROOT, DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP);

  // The capability declares stageMigrations: { "ux-ready": "ux-audit" }
  assert.strictEqual(result.stageMigrations['ux-ready'], 'ux-audit');
});

// =========================================================================
// Test group 6: Scaffold ux-audit artifact
// =========================================================================
console.log('\n--- Scaffold ux-audit artifact ---');

test('scaffold_artifacts creates minimal valid 15-ux-audit.json at ux-audit stage', () => {
  const ws = makeWorkspace();

  // Create a run and advance to ux-audit stage
  const createResult = dp(ws, 'create_run TEST-SCAF-1 "Scaffold test" test-project');
  const rf = createResult.run_folder;

  dp(ws, `generate_task_pack ${rf}`);
  dp(ws, `run_next_safe ${rf}`); // → analyze

  // Write PM brief to pass analyze gates
  fs.writeFileSync(path.join(rf, '10-pm-brief.json'),
    JSON.stringify({ ticket_id: 'TEST-SCAF-1', title: 't', project: 'p',
      problem_statement: 'x', scope: 'y', acceptance_criteria: [] }), 'utf8');

  dp(ws, `run_next_safe ${rf}`); // → ux-audit

  // Verify we're at ux-audit
  const status = dp(ws, `status ${rf}`);
  assert.strictEqual(status.run.current_stage, 'ux-audit');

  // Scaffold
  const scaffoldResult = dp(ws, `scaffold_artifacts ${rf}`);
  assert.strictEqual(scaffoldResult.ok, true);
  assert.ok(scaffoldResult.scaffolded.includes('15-ux-audit.json'),
    `Expected 15-ux-audit.json in scaffolded, got: ${JSON.stringify(scaffoldResult.scaffolded)}`);

  // Verify the scaffolded file exists and is valid JSON
  const artifactPath = path.join(rf, '15-ux-audit.json');
  assert.ok(fs.existsSync(artifactPath));
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  assert.strictEqual(artifact.ticket_id, 'TEST-SCAF-1');
  assert.ok(Array.isArray(artifact.findings));
  assert.ok(artifact.summary);
});

// =========================================================================
// Test group 7: record_artifact validates against capability schema
// =========================================================================
console.log('\n--- Artifact validation against capability schema ---');

test('record_artifact validates 15-ux-audit.json against ux-audit.schema.json', () => {
  const ws = makeWorkspace();

  // Create run and advance to ux-audit
  const createResult = dp(ws, 'create_run TEST-VAL-1 "Validation test" test-project');
  const rf = createResult.run_folder;
  dp(ws, `generate_task_pack ${rf}`);
  dp(ws, `run_next_safe ${rf}`); // → analyze

  fs.writeFileSync(path.join(rf, '10-pm-brief.json'),
    JSON.stringify({ ticket_id: 'TEST-VAL-1', title: 't', project: 'p',
      problem_statement: 'x', scope: 'y', acceptance_criteria: [] }), 'utf8');
  dp(ws, `run_next_safe ${rf}`); // → ux-audit

  // Write a valid artifact
  const audit = {
    ticket_id: 'TEST-VAL-1', flow_name: 'test', routes_audited: ['/test'],
    findings: [], competitor_notes: [],
    summary: { total_findings: 0, by_severity: { critical: 0, high: 0, medium: 0, low: 0 } },
  };
  fs.writeFileSync(path.join(rf, '15-ux-audit.json'), JSON.stringify(audit), 'utf8');

  // record_artifact should validate and pass
  const result = dp(ws, `record_artifact ${rf} ${path.join(rf, '15-ux-audit.json')}`);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.gates_pass, true, 'Gates should pass with valid artifact');
});

test('record_artifact rejects invalid 15-ux-audit.json', () => {
  const ws = makeWorkspace();

  const createResult = dp(ws, 'create_run TEST-INV-1 "Invalid test" test-project');
  const rf = createResult.run_folder;
  dp(ws, `generate_task_pack ${rf}`);
  dp(ws, `run_next_safe ${rf}`);

  fs.writeFileSync(path.join(rf, '10-pm-brief.json'),
    JSON.stringify({ ticket_id: 'TEST-INV-1', title: 't', project: 'p',
      problem_statement: 'x', scope: 'y', acceptance_criteria: [] }), 'utf8');
  dp(ws, `run_next_safe ${rf}`);

  // Write invalid artifact (missing required fields)
  fs.writeFileSync(path.join(rf, '15-ux-audit.json'), JSON.stringify({ ticket_id: 'TEST-INV-1' }), 'utf8');

  const result = dp(ws, `record_artifact ${rf} ${path.join(rf, '15-ux-audit.json')}`);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.valid, false, 'Should fail validation');
  assert.ok(result.errors.length > 0, 'Should have validation errors');
});

// =========================================================================
// Summary
// =========================================================================
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
