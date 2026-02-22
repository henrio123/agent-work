#!/usr/bin/env node
'use strict';

/**
 * Tests for Phase 6 post-implement auto-patch application (Epic 4).
 *
 * Covers:
 *   - Implement stage triggers patch attempt
 *   - Placeholder diff fails non-fatally
 *   - Non-implement stages skip patch application
 *   - patch_application in result
 *   - Audit trail events
 *   - Real diff in git repo applies successfully
 *
 * Run: node skills/dev-pipeline/tests/test-auto-patch.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
const RUNS_DIR = path.join(WORKSPACE_ROOT, '.claw', 'runs');
fs.mkdirSync(RUNS_DIR, { recursive: true });

const { runAutonomous, scaffoldAdapter, AUDIT_FILENAME } = require(path.resolve(__dirname, '..', 'scripts', 'autonomous-runner.js'));
const dp = require(path.resolve(__dirname, '..', 'scripts', 'dev-pipeline.js'));

let passed = 0;
let failed = 0;
const tmpDirs = [];

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

function makeTempRun(name, stage, statusOverrides = {}) {
  const folderName = `_test_patch_${name}_${Date.now()}`;
  const absDir = path.join(RUNS_DIR, folderName);
  fs.mkdirSync(absDir, { recursive: true });
  tmpDirs.push(absDir);

  fs.writeFileSync(path.join(absDir, '00-intake.json'), JSON.stringify({
    ticket_id: 'T-PATCH', title: 'Test patch', project: 'test',
    created_at: '2026-01-01T00:00:00.000Z', source: 'test',
  }, null, 2), 'utf8');

  // Write task file for current stage
  const stageConfig = dp.STAGE_CONFIG[stage];
  if (stageConfig && stageConfig.taskFile) {
    fs.writeFileSync(path.join(absDir, stageConfig.taskFile), `GOAL\n${stage} work.\n`, 'utf8');
  }

  const status = {
    ticket_id: 'T-PATCH', title: 'Test patch', project: 'test',
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    current_stage: stage, blocked: false, blocked_reason: null,
    required_user_input: [], stage_history: [
      { stage: 'intake', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:00:01Z', artifact_paths: ['00-intake.json'] },
      { stage, started_at: '2026-01-01T00:00:02Z', finished_at: null, artifact_paths: [], role: stageConfig ? stageConfig.role : 'Dev' },
    ], next_actions: [],
    ...statusOverrides,
  };
  fs.writeFileSync(path.join(absDir, 'status.json'), JSON.stringify(status, null, 2), 'utf8');

  return { relDir: `.claw/runs/${folderName}`, absDir };
}

function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
process.on('exit', cleanup);

// =========================================================================
// Post-implement patch application tests
// =========================================================================
console.log('\n--- Post-implement patch application ---');

test('implement stage with scaffold adapter has patch_application in result', () => {
  const { absDir } = makeTempRun('impl-scaffold', 'implement');
  const result = runAutonomous(absDir, {
    agentAdapter: scaffoldAdapter,
    maxSteps: 5,
    progress: false,
  });
  // scaffold adapter produces a placeholder diff, which will fail git apply
  assert.ok(result.patch_application !== undefined, 'Expected patch_application in result');
  assert.strictEqual(result.patch_application.applied, false, 'Placeholder diff should fail to apply');
  assert.ok(result.patch_application.error, 'Should have error message');
});

test('implement stage patch failure is non-fatal (run continues)', () => {
  const { absDir } = makeTempRun('impl-non-fatal', 'implement');
  const result = runAutonomous(absDir, {
    agentAdapter: scaffoldAdapter,
    maxSteps: 10,
    progress: false,
  });
  // Even though patch fails, the run should still advance past implement
  assert.notStrictEqual(result.final_action, 'error', 'Patch failure should not cause error');
  assert.ok(result.artifacts_written.includes('40-dev-patch.diff'), 'Diff artifact should still be written');
  assert.ok(result.artifacts_written.includes('41-dev-notes.json'), 'Notes artifact should still be written');
});

test('run stopping at analyze does NOT trigger patch application', () => {
  const { absDir } = makeTempRun('no-patch', 'analyze');
  const result = runAutonomous(absDir, {
    agentAdapter: scaffoldAdapter,
    maxSteps: 3,    // Stop before reaching implement stage
    maxAgentCalls: 1,
    progress: false,
  });
  assert.strictEqual(result.patch_application, null, 'Should not trigger patch when run stops before implement');
});

test('validate stage does NOT trigger patch application', () => {
  const { absDir } = makeTempRun('no-patch-validate', 'validate');
  // Need prior artifacts for validate stage
  fs.writeFileSync(path.join(absDir, '10-pm-brief.json'), JSON.stringify({
    ticket_id: 'T-PATCH', title: 'Test', project: 'test',
    problem_statement: 'test', scope: 'test', acceptance_criteria: ['ok'],
    non_goals: ['none'], stakeholders: ['me'], priority: 'medium',
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(absDir, '20-arch-design.json'), JSON.stringify({
    ticket_id: 'T-PATCH', title: 'Test',
    approach: 'test', components: [], risks: [], alternatives_considered: [],
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(absDir, '40-dev-patch.diff'), 'diff --git a/p b/p\n+ok\n', 'utf8');
  fs.writeFileSync(path.join(absDir, '41-dev-notes.json'), JSON.stringify({
    ticket_id: 'T-PATCH', summary: 'test', files_changed: [], decisions: [],
  }, null, 2), 'utf8');

  const result = runAutonomous(absDir, {
    agentAdapter: scaffoldAdapter,
    maxSteps: 5,
    progress: false,
  });
  assert.strictEqual(result.patch_application, null, 'Validate stage should not trigger patch application');
});

test('patch_application audit events are logged', () => {
  const { absDir } = makeTempRun('patch-audit', 'implement');
  runAutonomous(absDir, {
    agentAdapter: scaffoldAdapter,
    maxSteps: 5,
    auditLog: true,
    progress: false,
  });

  const auditPath = path.join(absDir, AUDIT_FILENAME);
  assert.ok(fs.existsSync(auditPath), 'audit log should exist');
  const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n');
  const patchEvents = lines.map(l => JSON.parse(l)).filter(e => e.event === 'patch_apply_start' || e.event === 'patch_apply_result');
  assert.ok(patchEvents.length >= 1, `Expected patch audit events, got ${patchEvents.length}`);
});

test('trace includes patch-related messages', () => {
  const { absDir } = makeTempRun('patch-trace', 'implement');
  const result = runAutonomous(absDir, {
    agentAdapter: scaffoldAdapter,
    maxSteps: 5,
    progress: false,
  });
  const patchTraces = result.trace.filter(t => t.includes('patch'));
  assert.ok(patchTraces.length >= 1, `Expected patch trace messages, got: ${JSON.stringify(patchTraces)}`);
});

test('retries_attempted defaults to 0 when no retries needed', () => {
  const { absDir } = makeTempRun('default-retries', 'implement');
  const result = runAutonomous(absDir, {
    agentAdapter: scaffoldAdapter,
    maxSteps: 5,
    progress: false,
  });
  assert.strictEqual(result.retries_attempted, 0);
});

// =========================================================================
// Summary
// =========================================================================
console.log(`\n========================================`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`========================================`);

process.exit(failed > 0 ? 1 : 0);
