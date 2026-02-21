#!/usr/bin/env node
'use strict';

/**
 * Tests for self-evaluate.js (Phase 4, Epic 2).
 *
 * Run: node skills/dev-pipeline/tests/test-self-evaluate.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { selfEvaluate, selfEvaluateAndRecord } = require(path.resolve(__dirname, '..', 'scripts', 'self-evaluate.js'));
const { readMemory } = require(path.resolve(__dirname, '..', 'scripts', 'agent-memory.js'));
const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));

const schema = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'self-evaluation.output.schema.json'), 'utf8')
);

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'self-evaluate.js');
const SHELL = path.resolve(__dirname, '..', '..', '..', 'tools', 'self-evaluate.sh');

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'self-eval-'));
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
  }), 'utf8');

  if (opts.qa) {
    fs.writeFileSync(path.join(runDir, '50-qa-report.json'), JSON.stringify(opts.qa), 'utf8');
  }
  if (opts.review) {
    fs.writeFileSync(path.join(runDir, '60-review-report.json'), JSON.stringify(opts.review), 'utf8');
  }
  if (opts.audit_lines) {
    const lines = opts.audit_lines.map((_, i) => JSON.stringify({ step: i }));
    fs.writeFileSync(path.join(runDir, 'autonomous-audit.jsonl'), lines.join('\n'), 'utf8');
  }

  return `.claw/runs/${runName}`;
}

// Helper: workspace with multiple baseline runs
function makeBaselinedWorkspace(projectId) {
  const ws = makeWorkspace(projectId);

  // Run 1: pass/approved, 10 min
  addRun(ws, '20260101_000000_T-1', projectId, {
    current_stage: 'done',
    stage_history: [
      { stage: 'implement', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:10:00Z', artifact_paths: [], agent_id: null },
    ],
    qa: { ticket_id: 'T-1', tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
    review: { ticket_id: 'T-1', stage_compliance: true, artifact_validation: true, verdict: 'approved' },
    audit_lines: [1, 2],
  });

  // Run 2: pass/approved, 12 min
  addRun(ws, '20260102_000000_T-2', projectId, {
    current_stage: 'done',
    stage_history: [
      { stage: 'implement', started_at: '2026-01-02T00:00:00Z', finished_at: '2026-01-02T00:12:00Z', artifact_paths: [], agent_id: null },
    ],
    qa: { ticket_id: 'T-2', tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
    review: { ticket_id: 'T-2', stage_compliance: true, artifact_validation: true, verdict: 'approved' },
    audit_lines: [1, 2, 3, 4],
  });

  return ws;
}

// =========================================================================
// Empty baseline
// =========================================================================
console.log('\n--- Empty baseline ---');

test('with <2 prior runs, quality_score is null', () => {
  const ws = makeWorkspace('proj-empty');
  const rf = addRun(ws, '20260101_000000_T-1', 'proj-empty', {
    current_stage: 'done',
    qa: { ticket_id: 'T-1', tests_run: 3, tests_passed: 3, tests_failed: 0, verdict: 'pass' },
  });

  const result = selfEvaluate({ workspaceRoot: ws, runFolder: rf, projectId: 'proj-empty' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.quality_score, null);
  // Deviations may still be computed (comparing run to its own baseline),
  // but quality_score is null since <2 prior runs
  assert.ok(Array.isArray(result.deviations));
});

test('empty baseline validates against schema', () => {
  const ws = makeWorkspace('proj-val');
  const rf = addRun(ws, '20260101_000000_T-1', 'proj-val', { current_stage: 'done' });

  const result = selfEvaluate({ workspaceRoot: ws, runFolder: rf, projectId: 'proj-val' });
  const v = validateAgainstSchema(result, schema);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);
});

// =========================================================================
// Perfect run
// =========================================================================
console.log('\n--- Perfect run ---');

test('perfect run against good baseline has high quality score', () => {
  const ws = makeBaselinedWorkspace('proj-perfect');

  // Run 3: also pass/approved, similar duration
  const rf = addRun(ws, '20260103_000000_T-3', 'proj-perfect', {
    current_stage: 'done',
    stage_history: [
      { stage: 'implement', started_at: '2026-01-03T00:00:00Z', finished_at: '2026-01-03T00:11:00Z', artifact_paths: [], agent_id: null },
    ],
    qa: { ticket_id: 'T-3', tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
    review: { ticket_id: 'T-3', stage_compliance: true, artifact_validation: true, verdict: 'approved' },
    audit_lines: [1, 2, 3],
  });

  const result = selfEvaluate({ workspaceRoot: ws, runFolder: rf, projectId: 'proj-perfect' });
  assert.strictEqual(result.ok, true);
  assert.ok(result.quality_score >= 0.8, `Expected high score, got ${result.quality_score}`);
});

// =========================================================================
// Failed run
// =========================================================================
console.log('\n--- Failed run ---');

test('failed QA run produces low quality score and suggestions', () => {
  const ws = makeBaselinedWorkspace('proj-fail');

  const rf = addRun(ws, '20260103_000000_T-3', 'proj-fail', {
    current_stage: 'done',
    stage_history: [
      { stage: 'implement', started_at: '2026-01-03T00:00:00Z', finished_at: '2026-01-03T00:30:00Z', artifact_paths: [], agent_id: null },
    ],
    qa: { ticket_id: 'T-3', tests_run: 5, tests_passed: 1, tests_failed: 4, verdict: 'fail',
      issues: [{ description: 'A', severity: 'high' }, { description: 'B', severity: 'critical' }] },
    review: { ticket_id: 'T-3', stage_compliance: true, artifact_validation: true, verdict: 'rejected' },
    audit_lines: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  });

  const result = selfEvaluate({ workspaceRoot: ws, runFolder: rf, projectId: 'proj-fail' });
  assert.strictEqual(result.ok, true);
  assert.ok(result.quality_score <= 0.3, `Expected low score, got ${result.quality_score}`);
  assert.ok(result.suggestions.length > 0, 'Should have suggestions');
  assert.ok(result.suggestions.some(s => s.title.includes('QA failure')));
  assert.ok(result.suggestions.some(s => s.title.includes('Review rejected')));
});

// =========================================================================
// Score boundaries
// =========================================================================
console.log('\n--- Score boundaries ---');

test('quality_score is between 0 and 1', () => {
  const ws = makeBaselinedWorkspace('proj-bounds');
  const rf = addRun(ws, '20260103_000000_T-3', 'proj-bounds', {
    current_stage: 'done',
    stage_history: [
      { stage: 'implement', started_at: '2026-01-03T00:00:00Z', finished_at: '2026-01-03T00:11:00Z', artifact_paths: [], agent_id: null },
    ],
    qa: { ticket_id: 'T-3', tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
    review: { ticket_id: 'T-3', stage_compliance: true, artifact_validation: true, verdict: 'approved' },
  });

  const result = selfEvaluate({ workspaceRoot: ws, runFolder: rf, projectId: 'proj-bounds' });
  assert.ok(result.quality_score >= 0.0 && result.quality_score <= 1.0,
    `Score out of range: ${result.quality_score}`);
});

// =========================================================================
// Deviations
// =========================================================================
console.log('\n--- Deviations ---');

test('detects worse deviation for slow run', () => {
  const ws = makeBaselinedWorkspace('proj-slow');

  // Run 3: 3x slower
  const rf = addRun(ws, '20260103_000000_T-3', 'proj-slow', {
    current_stage: 'done',
    stage_history: [
      { stage: 'implement', started_at: '2026-01-03T00:00:00Z', finished_at: '2026-01-03T01:00:00Z', artifact_paths: [], agent_id: null },
    ],
    qa: { ticket_id: 'T-3', tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
    review: { ticket_id: 'T-3', stage_compliance: true, artifact_validation: true, verdict: 'approved' },
  });

  const result = selfEvaluate({ workspaceRoot: ws, runFolder: rf, projectId: 'proj-slow' });
  const durDev = result.deviations.find(d => d.metric === 'total_duration_ms');
  assert.ok(durDev, 'Should have duration deviation');
  assert.strictEqual(durDev.direction, 'worse');
  assert.strictEqual(durDev.severity, 'significant');
});

test('detects better deviation for fast run', () => {
  const ws = makeBaselinedWorkspace('proj-fast');

  // Run 3: much faster
  const rf = addRun(ws, '20260103_000000_T-3', 'proj-fast', {
    current_stage: 'done',
    stage_history: [
      { stage: 'implement', started_at: '2026-01-03T00:00:00Z', finished_at: '2026-01-03T00:03:00Z', artifact_paths: [], agent_id: null },
    ],
    qa: { ticket_id: 'T-3', tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
    review: { ticket_id: 'T-3', stage_compliance: true, artifact_validation: true, verdict: 'approved' },
  });

  const result = selfEvaluate({ workspaceRoot: ws, runFolder: rf, projectId: 'proj-fast' });
  const durDev = result.deviations.find(d => d.metric === 'total_duration_ms');
  assert.ok(durDev, 'Should have duration deviation');
  assert.strictEqual(durDev.direction, 'better');
});

// =========================================================================
// Memory write
// =========================================================================
console.log('\n--- Memory write ---');

test('selfEvaluateAndRecord writes to agent memory', () => {
  const ws = makeBaselinedWorkspace('proj-mem');
  const rf = addRun(ws, '20260103_000000_T-3', 'proj-mem', {
    current_stage: 'done',
    stage_history: [
      { stage: 'implement', started_at: '2026-01-03T00:00:00Z', finished_at: '2026-01-03T00:11:00Z', artifact_paths: [], agent_id: null },
    ],
    qa: { ticket_id: 'T-3', tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
    review: { ticket_id: 'T-3', stage_compliance: true, artifact_validation: true, verdict: 'approved' },
  });

  const result = selfEvaluateAndRecord({
    workspaceRoot: ws, runFolder: rf, projectId: 'proj-mem', agentId: 'test-agent',
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.memory_written, true);

  const mem = readMemory({ workspaceRoot: ws, agentId: 'test-agent', filterType: 'evaluation' });
  assert.strictEqual(mem.ok, true);
  assert.strictEqual(mem.total_entries, 1);
  assert.ok(mem.entries[0].content.includes('Self-evaluation'));
});

// =========================================================================
// Missing run
// =========================================================================
console.log('\n--- Missing reports ---');

test('returns error for non-existent run folder', () => {
  const ws = makeWorkspace('proj-miss');
  const result = selfEvaluate({ workspaceRoot: ws, runFolder: '.claw/runs/fake', projectId: 'proj-miss' });
  assert.strictEqual(result.ok, false);
});

test('missing runFolder param returns error', () => {
  const result = selfEvaluate({ projectId: 'x' });
  assert.strictEqual(result.ok, false);
});

// =========================================================================
// Schema validation with data
// =========================================================================
console.log('\n--- Schema validation ---');

test('full evaluation validates against schema', () => {
  const ws = makeBaselinedWorkspace('proj-sv');
  const rf = addRun(ws, '20260103_000000_T-3', 'proj-sv', {
    current_stage: 'done',
    stage_history: [
      { stage: 'implement', started_at: '2026-01-03T00:00:00Z', finished_at: '2026-01-03T00:30:00Z', artifact_paths: [], agent_id: null },
    ],
    qa: { ticket_id: 'T-3', tests_run: 5, tests_passed: 2, tests_failed: 3, verdict: 'fail',
      issues: [{ description: 'X', severity: 'high' }] },
    review: { ticket_id: 'T-3', stage_compliance: true, artifact_validation: true, verdict: 'rejected' },
  });

  const result = selfEvaluate({ workspaceRoot: ws, runFolder: rf, projectId: 'proj-sv' });
  const v = validateAgainstSchema(result, schema);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);
});

// =========================================================================
// CLI
// =========================================================================
console.log('\n--- CLI ---');

test('CLI outputs valid JSON', () => {
  const ws = makeBaselinedWorkspace('proj-cli');
  const rf = addRun(ws, '20260103_000000_T-3', 'proj-cli', {
    current_stage: 'done',
    qa: { ticket_id: 'T-3', tests_run: 3, tests_passed: 3, tests_failed: 0, verdict: 'pass' },
  });

  const stdout = execFileSync('node', [SCRIPT, '--run_folder', rf, '--project', 'proj-cli'], {
    encoding: 'utf8', timeout: 10000,
    env: { ...process.env, WORKSPACE_ROOT: ws },
  });
  const parsed = JSON.parse(stdout);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.action, 'self_evaluation_complete');
});

// =========================================================================
// Summary
// =========================================================================
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
