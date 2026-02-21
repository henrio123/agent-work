#!/usr/bin/env node
'use strict';

/**
 * Tests for post-run-hooks.js (Phase 5, Epic 1).
 *
 * Run: node skills/dev-pipeline/tests/test-post-run-hooks.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { runPostRunHooks } = require(path.resolve(__dirname, '..', 'scripts', 'post-run-hooks.js'));
const { readMemory } = require(path.resolve(__dirname, '..', 'scripts', 'agent-memory.js'));
const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));

const schema = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'post-run-hooks.output.schema.json'), 'utf8')
);

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'post-run-hooks-'));
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

function makeWorkspace(projectId) {
  const ws = fs.mkdtempSync(path.join(TMP, 'ws-'));
  const clawDir = path.join(ws, '.claw');
  fs.mkdirSync(path.join(clawDir, 'backlog'), { recursive: true });
  fs.mkdirSync(path.join(clawDir, 'runs'), { recursive: true });
  fs.mkdirSync(path.join(clawDir, 'task-packs'), { recursive: true });
  fs.mkdirSync(path.join(clawDir, 'agents'), { recursive: true });

  fs.writeFileSync(path.join(clawDir, 'project.json'), JSON.stringify({
    project_id: projectId,
    title: `Test ${projectId}`,
    description: 'test',
    repo_path: ws,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }), 'utf8');

  return ws;
}

function addRun(ws, runName, project, opts = {}) {
  const runDir = path.join(ws, '.claw', 'runs', runName);
  fs.mkdirSync(runDir, { recursive: true });

  fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify({
    ticket_id: opts.ticket_id || runName.split('_').pop(),
    title: 'test',
    project: project,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    current_stage: opts.current_stage || 'done',
    blocked: false,
    blocked_reason: null,
    responsible_agent: opts.responsible_agent || null,
    required_user_input: [],
    stage_history: opts.stage_history || [],
    next_actions: [],
    last_autonomous_summary: opts.last_autonomous_summary || null,
  }), 'utf8');

  if (opts.qa) {
    fs.writeFileSync(path.join(runDir, '50-qa-report.json'), JSON.stringify(opts.qa), 'utf8');
  }
  if (opts.review) {
    fs.writeFileSync(path.join(runDir, '60-review-report.json'), JSON.stringify(opts.review), 'utf8');
  }

  return `.claw/runs/${runName}`;
}

function makeBaselinedWorkspace(projectId) {
  const ws = makeWorkspace(projectId);

  addRun(ws, '20260101_000000_T-1', projectId, {
    current_stage: 'done',
    stage_history: [
      { stage: 'implement', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:10:00Z', artifact_paths: [], agent_id: null },
    ],
    qa: { ticket_id: 'T-1', tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
    review: { ticket_id: 'T-1', stage_compliance: true, artifact_validation: true, verdict: 'approved' },
  });

  addRun(ws, '20260102_000000_T-2', projectId, {
    current_stage: 'done',
    stage_history: [
      { stage: 'implement', started_at: '2026-01-02T00:00:00Z', finished_at: '2026-01-02T00:12:00Z', artifact_paths: [], agent_id: null },
    ],
    qa: { ticket_id: 'T-2', tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
    review: { ticket_id: 'T-2', stage_compliance: true, artifact_validation: true, verdict: 'approved' },
  });

  return ws;
}

// =========================================================================
// Missing parameters
// =========================================================================
console.log('\n--- Missing parameters ---');

test('missing runFolder returns error', () => {
  const result = runPostRunHooks({ projectId: 'x' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.action, 'post_run_hooks_skipped');
});

test('missing projectId returns error', () => {
  const result = runPostRunHooks({ runFolder: '.claw/runs/fake' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.action, 'post_run_hooks_skipped');
});

// =========================================================================
// In-progress run (should skip)
// =========================================================================
console.log('\n--- In-progress run ---');

test('skips when run is in-progress (needs_artifacts)', () => {
  const ws = makeWorkspace('proj-skip');
  const rf = addRun(ws, '20260101_000000_T-1', 'proj-skip', {
    current_stage: 'implement',
    last_autonomous_summary: { final_action: 'needs_artifacts', steps_run: 1, agent_calls: 0, artifacts_written: [] },
  });

  const result = runPostRunHooks({ workspaceRoot: ws, runFolder: rf, projectId: 'proj-skip' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.action, 'post_run_hooks_skipped');
  assert.ok(result.skip_reason.includes('not in a terminal state'));
});

// =========================================================================
// Completed run triggers both hooks
// =========================================================================
console.log('\n--- Completed run ---');

test('completed run triggers self-evaluation and gap scanning', () => {
  const ws = makeBaselinedWorkspace('proj-done');
  const rf = addRun(ws, '20260103_000000_T-3', 'proj-done', {
    current_stage: 'done',
    stage_history: [
      { stage: 'implement', started_at: '2026-01-03T00:00:00Z', finished_at: '2026-01-03T00:11:00Z', artifact_paths: [], agent_id: null },
    ],
    qa: { ticket_id: 'T-3', tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
    review: { ticket_id: 'T-3', stage_compliance: true, artifact_validation: true, verdict: 'approved' },
  });

  const result = runPostRunHooks({ workspaceRoot: ws, runFolder: rf, projectId: 'proj-done' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.action, 'post_run_hooks_complete');
  assert.ok(result.self_evaluation, 'should have self_evaluation');
  assert.ok(result.gaps, 'should have gaps');
  assert.ok(typeof result.self_evaluation.quality_score === 'number' || result.self_evaluation.quality_score === null);
  assert.ok(typeof result.gaps.total_found === 'number');
});

test('completed run with agent writes memory', () => {
  const ws = makeBaselinedWorkspace('proj-mem');
  const rf = addRun(ws, '20260103_000000_T-3', 'proj-mem', {
    current_stage: 'done',
    stage_history: [
      { stage: 'implement', started_at: '2026-01-03T00:00:00Z', finished_at: '2026-01-03T00:11:00Z', artifact_paths: [], agent_id: null },
    ],
    qa: { ticket_id: 'T-3', tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
    review: { ticket_id: 'T-3', stage_compliance: true, artifact_validation: true, verdict: 'approved' },
  });

  const result = runPostRunHooks({
    workspaceRoot: ws, runFolder: rf, projectId: 'proj-mem', agentId: 'agent-01',
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.self_evaluation.memory_written, true);

  const mem = readMemory({ workspaceRoot: ws, agentId: 'agent-01', filterType: 'evaluation' });
  assert.strictEqual(mem.ok, true);
  assert.ok(mem.total_entries >= 1, 'should have memory entry');
});

// =========================================================================
// Self-eval failure is non-fatal
// =========================================================================
console.log('\n--- Non-fatal failures ---');

test('self-eval failure is non-fatal — gaps still run', () => {
  const ws = makeWorkspace('proj-evalfail');
  // Only one run — selfEvaluate will fail (run not found in analytics)
  const rf = addRun(ws, '20260101_000000_T-1', 'proj-evalfail', {
    current_stage: 'done',
  });

  const result = runPostRunHooks({ workspaceRoot: ws, runFolder: rf, projectId: 'proj-evalfail' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.action, 'post_run_hooks_complete');
  // Self-eval may have error but result should still be ok
  assert.ok(result.self_evaluation !== null, 'self_evaluation should be populated');
  assert.ok(result.gaps !== null, 'gaps should be populated');
});

test('gap-scan failure is non-fatal — self-eval still returned', () => {
  const ws = makeBaselinedWorkspace('proj-gapfail');
  const rf = addRun(ws, '20260103_000000_T-3', 'proj-gapfail', {
    current_stage: 'done',
    stage_history: [
      { stage: 'implement', started_at: '2026-01-03T00:00:00Z', finished_at: '2026-01-03T00:11:00Z', artifact_paths: [], agent_id: null },
    ],
    qa: { ticket_id: 'T-3', tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
    review: { ticket_id: 'T-3', stage_compliance: true, artifact_validation: true, verdict: 'approved' },
  });

  // Result is still ok even if gap scanning produces empty results
  const result = runPostRunHooks({ workspaceRoot: ws, runFolder: rf, projectId: 'proj-gapfail' });
  assert.strictEqual(result.ok, true);
  assert.ok(result.self_evaluation !== null);
  assert.ok(result.gaps !== null);
});

// =========================================================================
// Gap auto-create
// =========================================================================
console.log('\n--- Gap auto-create ---');

test('auto-creates backlog items for detected gaps', () => {
  const ws = makeBaselinedWorkspace('proj-gap');

  // Add a run with QA issues
  const rf = addRun(ws, '20260103_000000_T-3', 'proj-gap', {
    current_stage: 'done',
    stage_history: [
      { stage: 'implement', started_at: '2026-01-03T00:00:00Z', finished_at: '2026-01-03T00:11:00Z', artifact_paths: [], agent_id: null },
    ],
    qa: {
      ticket_id: 'T-3', tests_run: 5, tests_passed: 1, tests_failed: 4, verdict: 'fail',
      issues: [{ description: 'Missing validation', severity: 'high' }],
    },
    review: { ticket_id: 'T-3', stage_compliance: true, artifact_validation: true, verdict: 'approved' },
  });

  const result = runPostRunHooks({ workspaceRoot: ws, runFolder: rf, projectId: 'proj-gap' });
  assert.strictEqual(result.ok, true);
  assert.ok(result.gaps.total_found >= 1, `Expected gaps, got ${result.gaps.total_found}`);
  assert.ok(result.gaps.auto_created_count >= 1, `Expected auto-created, got ${result.gaps.auto_created_count}`);

  // Verify backlog item was created
  const backlogDir = path.join(ws, '.claw', 'backlog');
  const files = fs.readdirSync(backlogDir).filter(f => f.endsWith('.json'));
  assert.ok(files.length >= 1, 'backlog should have auto-created items');
});

// =========================================================================
// Schema validation
// =========================================================================
console.log('\n--- Schema validation ---');

test('completed run result validates against schema', () => {
  const ws = makeBaselinedWorkspace('proj-schema');
  const rf = addRun(ws, '20260103_000000_T-3', 'proj-schema', {
    current_stage: 'done',
    stage_history: [
      { stage: 'implement', started_at: '2026-01-03T00:00:00Z', finished_at: '2026-01-03T00:11:00Z', artifact_paths: [], agent_id: null },
    ],
    qa: { ticket_id: 'T-3', tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
    review: { ticket_id: 'T-3', stage_compliance: true, artifact_validation: true, verdict: 'approved' },
  });

  const result = runPostRunHooks({ workspaceRoot: ws, runFolder: rf, projectId: 'proj-schema' });
  const v = validateAgainstSchema(result, schema);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);
});

test('skipped result validates against schema', () => {
  const ws = makeWorkspace('proj-schema2');
  const rf = addRun(ws, '20260101_000000_T-1', 'proj-schema2', {
    current_stage: 'implement',
    last_autonomous_summary: { final_action: 'needs_artifacts', steps_run: 1, agent_calls: 0, artifacts_written: [] },
  });

  const result = runPostRunHooks({ workspaceRoot: ws, runFolder: rf, projectId: 'proj-schema2' });
  const v = validateAgainstSchema(result, schema);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);
});

// =========================================================================
// Empty project baseline
// =========================================================================
console.log('\n--- Empty project baseline ---');

test('works on project with no prior runs', () => {
  const ws = makeWorkspace('proj-empty');
  const rf = addRun(ws, '20260101_000000_T-1', 'proj-empty', {
    current_stage: 'done',
  });

  const result = runPostRunHooks({ workspaceRoot: ws, runFolder: rf, projectId: 'proj-empty' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.action, 'post_run_hooks_complete');
});

// =========================================================================
// Hook output shape
// =========================================================================
console.log('\n--- Output shape ---');

test('output has correct shape with all expected fields', () => {
  const ws = makeBaselinedWorkspace('proj-shape');
  const rf = addRun(ws, '20260103_000000_T-3', 'proj-shape', {
    current_stage: 'done',
    stage_history: [
      { stage: 'implement', started_at: '2026-01-03T00:00:00Z', finished_at: '2026-01-03T00:11:00Z', artifact_paths: [], agent_id: null },
    ],
    qa: { ticket_id: 'T-3', tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
    review: { ticket_id: 'T-3', stage_compliance: true, artifact_validation: true, verdict: 'approved' },
  });

  const result = runPostRunHooks({ workspaceRoot: ws, runFolder: rf, projectId: 'proj-shape' });
  assert.strictEqual(typeof result.ok, 'boolean');
  assert.strictEqual(typeof result.action, 'string');
  assert.ok(result.self_evaluation !== undefined);
  assert.ok(result.gaps !== undefined);
  if (result.self_evaluation) {
    assert.ok('quality_score' in result.self_evaluation);
    assert.ok('deviations_count' in result.self_evaluation);
    assert.ok('suggestions_count' in result.self_evaluation);
  }
  if (result.gaps) {
    assert.ok('total_found' in result.gaps);
    assert.ok('auto_created_count' in result.gaps);
  }
});

// =========================================================================
// Summary
// =========================================================================
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
