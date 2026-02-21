#!/usr/bin/env node
'use strict';

/**
 * End-to-end tests for the research capability.
 *
 * Validates that when research is activated via .claw/capabilities.json,
 * the pipeline correctly:
 *   1. Injects research stage into the chain (analyze → research → plan)
 *   2. Resolves the research template from capability dir (not core)
 *   3. Resolves the research artifact schema from capability dir
 *   4. Full pipeline run: create_run → task_pack → advance through research → done
 *   5. Scaffold generates minimal research-findings artifact that passes schema validation
 *   6. record_artifact validates against research-findings.schema.json
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
// Helpers: create a temp workspace with research capability enabled
// ---------------------------------------------------------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'research-e2e-'));
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

function makeWorkspace() {
  const ws = fs.mkdtempSync(path.join(TMP, 'ws-'));
  fs.mkdirSync(path.join(ws, '.claw', 'runs'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.claw', 'tickets'), { recursive: true });
  // Activate research capability
  fs.writeFileSync(
    path.join(ws, '.claw', 'capabilities.json'),
    JSON.stringify({ capabilities: ['research'] }),
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
console.log('\n--- Stage chain injection (real research capability) ---');

test('loadCapabilities with real research capability returns research stage', () => {
  const { loadCapabilities } = require('../scripts/capability-registry.js');
  const { DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP } = require('../scripts/dev-pipeline.js');

  const ws = makeWorkspace();
  const result = loadCapabilities(ws, ENGINE_ROOT, DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP);

  assert.ok(result.stageConfig['research'], 'research stage should be in stageConfig');
  assert.strictEqual(result.stageConfig['analyze'].next, 'research');
  assert.strictEqual(result.stageConfig['research'].next, 'plan');
  assert.strictEqual(result.stageConfig['research'].role, 'Researcher');
  assert.deepStrictEqual(result.stageConfig['research'].requiredArtifacts, ['18-research-findings.json']);
});

test('chain with research: analyze → research → plan → implement → validate → review → done', () => {
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
  assert.deepStrictEqual(visited, ['analyze', 'research', 'plan', 'implement', 'validate', 'review']);
});

test('capabilityDirs includes the real research directory', () => {
  const { loadCapabilities } = require('../scripts/capability-registry.js');
  const { DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP } = require('../scripts/dev-pipeline.js');

  const ws = makeWorkspace();
  const result = loadCapabilities(ws, ENGINE_ROOT, DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP);

  assert.strictEqual(result.capabilityDirs.length, 1);
  assert.ok(result.capabilityDirs[0].endsWith('research'));
});

// =========================================================================
// Test group 2: Template resolution from capability
// =========================================================================
console.log('\n--- Template resolution ---');

test('resolveTemplatePath finds claude-research-pack.txt in capability, not core', () => {
  const { resolveTemplatePath } = require('../scripts/capability-registry.js');

  const researchCapDir = path.join(ENGINE_ROOT, 'skills', 'capabilities', 'research');
  const resolved = resolveTemplatePath('claude-research-pack.txt', [researchCapDir], ENGINE_ROOT);

  assert.ok(resolved.includes('skills/capabilities/research/templates/claude-research-pack.txt'),
    `Expected capability path, got: ${resolved}`);
  // Verify the core templates/ does NOT have it
  assert.ok(!fs.existsSync(path.join(ENGINE_ROOT, 'templates', 'claude-research-pack.txt')),
    'claude-research-pack.txt should NOT exist in core templates/');
});

test('resolved research template contains expected placeholders', () => {
  const templatePath = path.join(ENGINE_ROOT, 'skills', 'capabilities', 'research', 'templates', 'claude-research-pack.txt');
  const content = fs.readFileSync(templatePath, 'utf8');

  assert.ok(content.includes('{{TICKET_ID}}'));
  assert.ok(content.includes('{{TITLE}}'));
  assert.ok(content.includes('{{PROJECT_NAME}}'));
  assert.ok(content.includes('{{RUN_FOLDER}}'));
  assert.ok(content.includes('Researcher'));
  assert.ok(content.includes('18-research-findings.json'));
});

// =========================================================================
// Test group 3: Schema resolution from capability
// =========================================================================
console.log('\n--- Schema resolution ---');

test('resolveSchemaPath finds research-findings.schema.json in capability', () => {
  const { resolveSchemaPath } = require('../scripts/capability-registry.js');

  const researchCapDir = path.join(ENGINE_ROOT, 'skills', 'capabilities', 'research');
  const resolved = resolveSchemaPath('research-findings.schema.json', [researchCapDir], ENGINE_ROOT);

  assert.ok(resolved, 'should find research-findings.schema.json');
  assert.ok(resolved.includes('skills/capabilities/research/references/research-findings.schema.json'),
    `Expected capability path, got: ${resolved}`);
});

test('artifactSchemaMap includes 18-research-findings.json mapping', () => {
  const { loadCapabilities } = require('../scripts/capability-registry.js');
  const { DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP } = require('../scripts/dev-pipeline.js');

  const ws = makeWorkspace();
  const result = loadCapabilities(ws, ENGINE_ROOT, DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP);

  assert.strictEqual(result.artifactSchemaMap['18-research-findings.json'], 'research-findings.schema.json');
});

// =========================================================================
// Test group 4: Full pipeline run with research stage
// =========================================================================
console.log('\n--- Full pipeline run ---');

let runFolder;

test('create_run succeeds with research capability active', () => {
  const ws = makeWorkspace();
  const result = dp(ws, 'create_run TEST-RES-1 "Research caching strategies" test-project');
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

test('analyze → research (not plan) when research capability is active', () => {
  const ws = test._ws;
  const rf = test._runFolder;

  // Write valid PM brief artifact
  const brief = {
    ticket_id: 'TEST-RES-1', title: 'Research caching strategies', project: 'test-project',
    problem_statement: 'Need to evaluate caching approaches', scope: 'API layer caching', acceptance_criteria: [],
  };
  fs.writeFileSync(path.join(rf, '10-pm-brief.json'), JSON.stringify(brief, null, 2), 'utf8');

  // run_next_safe should now advance analyze → research (not plan!)
  const result = dp(ws, `run_next_safe ${rf}`);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.advanced_to, 'research', 'Should advance to research, not plan');
  assert.strictEqual(result.role, 'Researcher');
});

test('research stage generates task file from capability template', () => {
  const ws = test._ws;
  const rf = test._runFolder;

  // The advance should have generated the task file
  const taskFilePath = path.join(rf, '38-research-task.txt');
  assert.ok(fs.existsSync(taskFilePath), '38-research-task.txt should exist');

  const content = fs.readFileSync(taskFilePath, 'utf8');
  assert.ok(content.includes('TEST-RES-1'), 'Task file should contain ticket ID');
  assert.ok(content.includes('Researcher'), 'Task file should reference Researcher role');
  assert.ok(content.includes('18-research-findings.json'), 'Task file should reference output artifact');
});

test('research stage waits for 18-research-findings.json artifact', () => {
  const ws = test._ws;
  const rf = test._runFolder;

  const result = dp(ws, `next_stage ${rf}`);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.gates_pass, false, 'Gates should not pass without artifact');
  assert.ok(result.missing_artifacts.includes('18-research-findings.json'));
});

test('valid research-findings artifact passes gates and advances to plan', () => {
  const ws = test._ws;
  const rf = test._runFolder;

  // Write valid research findings artifact
  const findings = {
    ticket_id: 'TEST-RES-1',
    hypotheses: [{
      id: 'H-001',
      statement: 'Redis caching will reduce API latency by 50%',
      status: 'confirmed',
    }],
    methods: [{
      id: 'M-001',
      description: 'Benchmarked Redis vs in-memory cache with realistic load',
      tools_used: ['redis-benchmark', 'wrk'],
    }],
    findings: [{
      id: 'F-001',
      hypothesis_id: 'H-001',
      description: 'Redis reduced p95 latency from 200ms to 85ms under 1000 RPS',
      evidence: ['benchmark-results/redis-1000rps.log', 'src/lib/cache.ts:42'],
      confidence: 'high',
    }],
    conclusion: 'Redis caching is the recommended approach for the API layer.',
    open_questions: ['How will cache invalidation work for real-time data?'],
  };
  fs.writeFileSync(path.join(rf, '18-research-findings.json'), JSON.stringify(findings, null, 2), 'utf8');

  // run_next_safe should advance research → plan
  const result = dp(ws, `run_next_safe ${rf}`);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.advanced_to, 'plan', 'Should advance to plan after research');
  assert.strictEqual(result.role, 'Architect');
});

test('pipeline continues normally after research: plan → implement → ... → done', () => {
  const ws = test._ws;
  const rf = test._runFolder;

  // Write remaining artifacts to complete the pipeline
  fs.writeFileSync(path.join(rf, '20-arch-design.json'),
    JSON.stringify({ ticket_id: 'TEST-RES-1', approach: 'a', components: [], file_changes: [] }), 'utf8');
  const r1 = dp(ws, `run_next_safe ${rf}`);
  assert.strictEqual(r1.advanced_to, 'implement');

  fs.writeFileSync(path.join(rf, '40-dev-patch.diff'), 'diff --git a/f b/f\n+x\n', 'utf8');
  fs.writeFileSync(path.join(rf, '41-dev-notes.json'),
    JSON.stringify({ ticket_id: 'TEST-RES-1', files_changed: [], summary: 's' }), 'utf8');
  const r2 = dp(ws, `run_next_safe ${rf}`);
  assert.strictEqual(r2.advanced_to, 'validate');

  fs.writeFileSync(path.join(rf, '50-qa-report.json'),
    JSON.stringify({ ticket_id: 'TEST-RES-1', tests_run: 1, tests_passed: 1, tests_failed: 0, verdict: 'pass' }), 'utf8');
  const r3 = dp(ws, `run_next_safe ${rf}`);
  assert.strictEqual(r3.advanced_to, 'review');

  fs.writeFileSync(path.join(rf, '60-review-report.json'),
    JSON.stringify({ ticket_id: 'TEST-RES-1', stage_compliance: true, artifact_validation: true, verdict: 'approved' }), 'utf8');
  const r4 = dp(ws, `run_next_safe ${rf}`);
  assert.strictEqual(r4.advanced_to, 'done');
});

test('stage_history records all 7 stages including research', () => {
  const ws = test._ws;
  const rf = test._runFolder;

  const status = dp(ws, `status ${rf}`);
  const stages = status.run.stage_history.map(h => h.stage);

  assert.ok(stages.includes('intake'));
  assert.ok(stages.includes('task-pack-generated'));
  assert.ok(stages.includes('analyze'));
  assert.ok(stages.includes('research'));
  assert.ok(stages.includes('plan'));
  assert.ok(stages.includes('implement'));
  assert.ok(stages.includes('validate'));
  assert.ok(stages.includes('review'));
  assert.ok(stages.includes('done'));
});

// =========================================================================
// Test group 5: Scaffold research-findings artifact
// =========================================================================
console.log('\n--- Scaffold research-findings artifact ---');

test('scaffold_artifacts creates minimal valid 18-research-findings.json at research stage', () => {
  const ws = makeWorkspace();

  // Create a run and advance to research stage
  const createResult = dp(ws, 'create_run TEST-SCAF-R1 "Scaffold test" test-project');
  const rf = createResult.run_folder;

  dp(ws, `generate_task_pack ${rf}`);
  dp(ws, `run_next_safe ${rf}`); // → analyze

  // Write PM brief to pass analyze gates
  fs.writeFileSync(path.join(rf, '10-pm-brief.json'),
    JSON.stringify({ ticket_id: 'TEST-SCAF-R1', title: 't', project: 'p',
      problem_statement: 'x', scope: 'y', acceptance_criteria: [] }), 'utf8');

  dp(ws, `run_next_safe ${rf}`); // → research

  // Verify we're at research
  const status = dp(ws, `status ${rf}`);
  assert.strictEqual(status.run.current_stage, 'research');

  // Scaffold
  const scaffoldResult = dp(ws, `scaffold_artifacts ${rf}`);
  assert.strictEqual(scaffoldResult.ok, true);
  assert.ok(scaffoldResult.scaffolded.includes('18-research-findings.json'),
    `Expected 18-research-findings.json in scaffolded, got: ${JSON.stringify(scaffoldResult.scaffolded)}`);

  // Verify the scaffolded file exists and is valid JSON
  const artifactPath = path.join(rf, '18-research-findings.json');
  assert.ok(fs.existsSync(artifactPath));
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  assert.strictEqual(artifact.ticket_id, 'TEST-SCAF-R1');
  assert.ok(Array.isArray(artifact.hypotheses));
  assert.ok(Array.isArray(artifact.findings));
  assert.ok(typeof artifact.conclusion === 'string');
});

// =========================================================================
// Test group 6: record_artifact validates against capability schema
// =========================================================================
console.log('\n--- Artifact validation against capability schema ---');

test('record_artifact validates 18-research-findings.json against research-findings.schema.json', () => {
  const ws = makeWorkspace();

  // Create run and advance to research
  const createResult = dp(ws, 'create_run TEST-VAL-R1 "Validation test" test-project');
  const rf = createResult.run_folder;
  dp(ws, `generate_task_pack ${rf}`);
  dp(ws, `run_next_safe ${rf}`); // → analyze

  fs.writeFileSync(path.join(rf, '10-pm-brief.json'),
    JSON.stringify({ ticket_id: 'TEST-VAL-R1', title: 't', project: 'p',
      problem_statement: 'x', scope: 'y', acceptance_criteria: [] }), 'utf8');
  dp(ws, `run_next_safe ${rf}`); // → research

  // Write a valid artifact
  const findings = {
    ticket_id: 'TEST-VAL-R1',
    hypotheses: [{ id: 'H-001', statement: 'test', status: 'inconclusive' }],
    methods: [{ id: 'M-001', description: 'test', tools_used: ['reading'] }],
    findings: [{ id: 'F-001', hypothesis_id: 'H-001', description: 'test', evidence: ['file.ts'], confidence: 'low' }],
    conclusion: 'Needs more investigation.',
    open_questions: [],
  };
  fs.writeFileSync(path.join(rf, '18-research-findings.json'), JSON.stringify(findings), 'utf8');

  // record_artifact should validate and pass
  const result = dp(ws, `record_artifact ${rf} ${path.join(rf, '18-research-findings.json')}`);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.gates_pass, true, 'Gates should pass with valid artifact');
});

test('record_artifact rejects invalid 18-research-findings.json', () => {
  const ws = makeWorkspace();

  const createResult = dp(ws, 'create_run TEST-INV-R1 "Invalid test" test-project');
  const rf = createResult.run_folder;
  dp(ws, `generate_task_pack ${rf}`);
  dp(ws, `run_next_safe ${rf}`);

  fs.writeFileSync(path.join(rf, '10-pm-brief.json'),
    JSON.stringify({ ticket_id: 'TEST-INV-R1', title: 't', project: 'p',
      problem_statement: 'x', scope: 'y', acceptance_criteria: [] }), 'utf8');
  dp(ws, `run_next_safe ${rf}`);

  // Write invalid artifact (missing required fields)
  fs.writeFileSync(path.join(rf, '18-research-findings.json'), JSON.stringify({ ticket_id: 'TEST-INV-R1' }), 'utf8');

  const result = dp(ws, `record_artifact ${rf} ${path.join(rf, '18-research-findings.json')}`);
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
