#!/usr/bin/env node
'use strict';

/**
 * Tests for run-analytics.js (Phase 4, Epic 1).
 *
 * Run: node skills/dev-pipeline/tests/test-run-analytics.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { buildRunAnalytics } = require(path.resolve(__dirname, '..', 'scripts', 'run-analytics.js'));
const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));

const schema = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'run-analytics.output.schema.json'), 'utf8')
);

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'run-analytics.js');
const SHELL = path.resolve(__dirname, '..', '..', '..', 'tools', 'run-analytics.sh');

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'run-analytics-'));
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

function makeWorkspace(projectId) {
  const ws = fs.mkdtempSync(path.join(TMP, 'ws-'));
  const clawDir = path.join(ws, '.claw');
  fs.mkdirSync(path.join(clawDir, 'backlog'), { recursive: true });
  fs.mkdirSync(path.join(clawDir, 'runs'), { recursive: true });
  fs.mkdirSync(path.join(clawDir, 'task-packs'), { recursive: true });

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

  const stageHistory = opts.stage_history || [];
  const currentStage = opts.current_stage || 'done';

  fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify({
    ticket_id: opts.ticket_id || runName.split('_').pop(),
    title: 'test',
    project: project,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    current_stage: currentStage,
    blocked: false,
    blocked_reason: null,
    responsible_agent: opts.responsible_agent || null,
    required_user_input: [],
    stage_history: stageHistory,
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
  if (opts.extra_files) {
    for (const [name, content] of Object.entries(opts.extra_files)) {
      fs.writeFileSync(path.join(runDir, name), content, 'utf8');
    }
  }

  return runDir;
}

// =========================================================================
// Empty project
// =========================================================================
console.log('\n--- Empty project ---');

test('empty project returns zero runs and null aggregates', () => {
  const ws = makeWorkspace('proj-empty');
  const result = buildRunAnalytics({ workspaceRoot: ws, projectId: 'proj-empty' });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.action, 'analytics_computed');
  assert.strictEqual(result.project_id, 'proj-empty');
  assert.strictEqual(result.runs.length, 0);
  assert.strictEqual(result.aggregates.total_runs, 0);
  assert.strictEqual(result.aggregates.completed_runs, 0);
  assert.strictEqual(result.aggregates.qa_pass_rate, null);
  assert.strictEqual(result.aggregates.avg_autonomous_steps, null);
});

test('empty project validates against schema', () => {
  const ws = makeWorkspace('proj-val');
  const result = buildRunAnalytics({ workspaceRoot: ws, projectId: 'proj-val' });
  const v = validateAgainstSchema(result, schema);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);
});

test('missing projectId returns error', () => {
  const ws = makeWorkspace('proj-err');
  const result = buildRunAnalytics({ workspaceRoot: ws });
  assert.strictEqual(result.ok, false);
});

// =========================================================================
// Single run
// =========================================================================
console.log('\n--- Single run ---');

test('single completed run with QA and review', () => {
  const ws = makeWorkspace('proj-single');
  addRun(ws, '20260101_000000_T-1', 'proj-single', {
    current_stage: 'done',
    responsible_agent: 'agent-1',
    stage_history: [
      { stage: 'intake', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:05:00Z', artifact_paths: [], agent_id: 'agent-1' },
      { stage: 'implement', started_at: '2026-01-01T00:05:00Z', finished_at: '2026-01-01T00:30:00Z', artifact_paths: [], agent_id: 'agent-1' },
      { stage: 'validate', started_at: '2026-01-01T00:30:00Z', finished_at: '2026-01-01T00:35:00Z', artifact_paths: [], agent_id: null },
    ],
    qa: {
      ticket_id: 'T-1',
      tests_run: 5, tests_passed: 4, tests_failed: 1,
      verdict: 'fail',
      issues: [
        { description: 'Bug A', severity: 'high' },
        { description: 'Bug B', severity: 'low' },
      ],
    },
    review: {
      ticket_id: 'T-1',
      stage_compliance: true,
      artifact_validation: true,
      verdict: 'approved',
      policy_violations: [],
      comments: ['LGTM'],
    },
    audit_lines: [1, 2, 3],
    extra_files: { '10-pm-brief.json': '{}', '20-arch-design.json': '{}' },
  });

  const result = buildRunAnalytics({ workspaceRoot: ws, projectId: 'proj-single' });

  assert.strictEqual(result.runs.length, 1);
  const run = result.runs[0];

  // Stage durations
  assert.strictEqual(run.stage_durations.length, 3);
  assert.strictEqual(run.stage_durations[0].stage, 'intake');
  assert.strictEqual(run.stage_durations[0].duration_ms, 5 * 60 * 1000);
  assert.strictEqual(run.total_duration_ms, (5 + 25 + 5) * 60 * 1000);

  // QA
  assert.strictEqual(run.qa_verdict, 'fail');
  assert.strictEqual(run.qa_issues_count, 2);
  assert.strictEqual(run.qa_issue_severities.high, 1);
  assert.strictEqual(run.qa_issue_severities.low, 1);

  // Review
  assert.strictEqual(run.review_verdict, 'approved');
  assert.strictEqual(run.review_policy_violations_count, 0);
  assert.strictEqual(run.review_comments_count, 1);

  // Artifacts (50-qa-report + 60-review-report + 10-pm-brief + 20-arch-design = 4)
  assert.strictEqual(run.artifact_count, 4);

  // Autonomous steps
  assert.strictEqual(run.autonomous_steps, 3);

  // Responsible agent
  assert.strictEqual(run.responsible_agent, 'agent-1');
});

// =========================================================================
// Duration calculation
// =========================================================================
console.log('\n--- Duration calculation ---');

test('null duration for stages without finished_at', () => {
  const ws = makeWorkspace('proj-dur');
  addRun(ws, '20260101_000000_T-1', 'proj-dur', {
    current_stage: 'implement',
    stage_history: [
      { stage: 'intake', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:05:00Z', artifact_paths: [], agent_id: null },
      { stage: 'implement', started_at: '2026-01-01T00:05:00Z', finished_at: null, artifact_paths: [], agent_id: null },
    ],
  });

  const result = buildRunAnalytics({ workspaceRoot: ws, projectId: 'proj-dur' });
  const run = result.runs[0];

  assert.strictEqual(run.stage_durations[0].duration_ms, 5 * 60 * 1000);
  assert.strictEqual(run.stage_durations[1].duration_ms, null);
  assert.strictEqual(run.total_duration_ms, 5 * 60 * 1000);
});

// =========================================================================
// Multiple runs
// =========================================================================
console.log('\n--- Multiple runs ---');

test('multiple runs produce correct aggregates', () => {
  const ws = makeWorkspace('proj-multi');

  addRun(ws, '20260101_000000_T-1', 'proj-multi', {
    current_stage: 'done',
    stage_history: [
      { stage: 'implement', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:10:00Z', artifact_paths: [], agent_id: null },
    ],
    qa: { ticket_id: 'T-1', tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
    review: { ticket_id: 'T-1', stage_compliance: true, artifact_validation: true, verdict: 'approved' },
    audit_lines: [1, 2],
    extra_files: { 'file1.json': '{}' },
  });

  addRun(ws, '20260102_000000_T-2', 'proj-multi', {
    current_stage: 'done',
    stage_history: [
      { stage: 'implement', started_at: '2026-01-02T00:00:00Z', finished_at: '2026-01-02T00:20:00Z', artifact_paths: [], agent_id: null },
    ],
    qa: { ticket_id: 'T-2', tests_run: 3, tests_passed: 1, tests_failed: 2, verdict: 'fail',
      issues: [{ description: 'Bug', severity: 'critical' }] },
    review: { ticket_id: 'T-2', stage_compliance: true, artifact_validation: true, verdict: 'rejected', policy_violations: ['lint'] },
    audit_lines: [1, 2, 3, 4],
    extra_files: { 'file1.json': '{}', 'file2.json': '{}' },
  });

  const result = buildRunAnalytics({ workspaceRoot: ws, projectId: 'proj-multi' });

  assert.strictEqual(result.runs.length, 2);
  const agg = result.aggregates;

  assert.strictEqual(agg.total_runs, 2);
  assert.strictEqual(agg.completed_runs, 2);

  // avg implement duration: (10+20)/2 = 15 min = 900000ms
  assert.strictEqual(agg.avg_duration_per_stage.implement, 900000);

  // QA: 1 pass, 1 fail out of 2
  assert.strictEqual(agg.qa_pass_rate, 0.5);
  assert.strictEqual(agg.qa_fail_rate, 0.5);

  // Review: 1 approved, 1 rejected out of 2
  assert.strictEqual(agg.review_approval_rate, 0.5);
  assert.strictEqual(agg.review_rejection_rate, 0.5);

  // Severity distribution
  assert.strictEqual(agg.issue_severity_distribution.critical, 1);

  // Avg autonomous steps: (2+4)/2 = 3
  assert.strictEqual(agg.avg_autonomous_steps, 3);

  // Avg artifact count: run1 has 3 (qa+review+file1), run2 has 4 (qa+review+file1+file2) → (3+4)/2=3.5
  assert.strictEqual(agg.avg_artifact_count, 3.5);
});

// =========================================================================
// QA extraction edge cases
// =========================================================================
console.log('\n--- QA extraction ---');

test('run without QA report has null verdict and zero issues', () => {
  const ws = makeWorkspace('proj-noqa');
  addRun(ws, '20260101_000000_T-1', 'proj-noqa', { current_stage: 'done' });

  const result = buildRunAnalytics({ workspaceRoot: ws, projectId: 'proj-noqa' });
  const run = result.runs[0];

  assert.strictEqual(run.qa_verdict, null);
  assert.strictEqual(run.qa_issues_count, 0);
  assert.deepStrictEqual(run.qa_issue_severities, {});
});

// =========================================================================
// Review extraction edge cases
// =========================================================================
console.log('\n--- Review extraction ---');

test('review with policy violations and comments counts correctly', () => {
  const ws = makeWorkspace('proj-rev');
  addRun(ws, '20260101_000000_T-1', 'proj-rev', {
    current_stage: 'done',
    review: {
      ticket_id: 'T-1', stage_compliance: false, artifact_validation: false,
      verdict: 'changes_requested',
      policy_violations: ['missing-tests', 'lint-error', 'no-docs'],
      comments: ['Fix tests', 'Run linter'],
    },
  });

  const result = buildRunAnalytics({ workspaceRoot: ws, projectId: 'proj-rev' });
  const run = result.runs[0];

  assert.strictEqual(run.review_verdict, 'changes_requested');
  assert.strictEqual(run.review_policy_violations_count, 3);
  assert.strictEqual(run.review_comments_count, 2);
});

// =========================================================================
// Aggregates with no QA/review data
// =========================================================================
console.log('\n--- Aggregates edge cases ---');

test('aggregates with no QA or review data have null rates', () => {
  const ws = makeWorkspace('proj-bare');
  addRun(ws, '20260101_000000_T-1', 'proj-bare', { current_stage: 'done' });

  const result = buildRunAnalytics({ workspaceRoot: ws, projectId: 'proj-bare' });
  const agg = result.aggregates;

  assert.strictEqual(agg.qa_pass_rate, null);
  assert.strictEqual(agg.qa_fail_rate, null);
  assert.strictEqual(agg.review_approval_rate, null);
  assert.strictEqual(agg.review_rejection_rate, null);
});

// =========================================================================
// Project isolation
// =========================================================================
console.log('\n--- Project isolation ---');

test('ignores runs from other projects', () => {
  const ws = makeWorkspace('proj-iso');
  addRun(ws, '20260101_000000_T-1', 'proj-iso', { current_stage: 'done' });
  addRun(ws, '20260102_000000_T-OTHER', 'other-project', { current_stage: 'done' });

  const result = buildRunAnalytics({ workspaceRoot: ws, projectId: 'proj-iso' });
  assert.strictEqual(result.runs.length, 1);
});

// =========================================================================
// Missing reports
// =========================================================================
console.log('\n--- Missing reports ---');

test('graceful with corrupted status.json', () => {
  const ws = makeWorkspace('proj-corrupt');
  const runDir = path.join(ws, '.claw', 'runs', '20260101_000000_T-BAD');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'status.json'), 'NOT JSON', 'utf8');

  const result = buildRunAnalytics({ workspaceRoot: ws, projectId: 'proj-corrupt' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.runs.length, 0);
});

// =========================================================================
// Schema validation with data
// =========================================================================
console.log('\n--- Schema validation ---');

test('full result validates against schema', () => {
  const ws = makeWorkspace('proj-schema');
  addRun(ws, '20260101_000000_T-1', 'proj-schema', {
    current_stage: 'done',
    stage_history: [
      { stage: 'implement', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:10:00Z', artifact_paths: [], agent_id: 'a1' },
    ],
    qa: { ticket_id: 'T-1', tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
    review: { ticket_id: 'T-1', stage_compliance: true, artifact_validation: true, verdict: 'approved' },
  });

  const result = buildRunAnalytics({ workspaceRoot: ws, projectId: 'proj-schema' });
  const v = validateAgainstSchema(result, schema);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);
});

// =========================================================================
// Determinism
// =========================================================================
console.log('\n--- Determinism ---');

test('two calls return identical results', () => {
  const ws = makeWorkspace('proj-det');
  addRun(ws, '20260101_000000_T-1', 'proj-det', {
    current_stage: 'done',
    stage_history: [
      { stage: 'implement', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:10:00Z', artifact_paths: [], agent_id: null },
    ],
    qa: { ticket_id: 'T-1', tests_run: 3, tests_passed: 2, tests_failed: 1, verdict: 'fail',
      issues: [{ description: 'X', severity: 'medium' }] },
  });

  const r1 = buildRunAnalytics({ workspaceRoot: ws, projectId: 'proj-det' });
  const r2 = buildRunAnalytics({ workspaceRoot: ws, projectId: 'proj-det' });
  assert.deepStrictEqual(r1, r2);
});

// =========================================================================
// CLI
// =========================================================================
console.log('\n--- CLI ---');

test('CLI outputs valid JSON', () => {
  const ws = makeWorkspace('proj-cli');
  const stdout = execFileSync('node', [SCRIPT, '--project', 'proj-cli'], {
    encoding: 'utf8', timeout: 10000,
    env: { ...process.env, WORKSPACE_ROOT: ws },
  });
  const parsed = JSON.parse(stdout);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.action, 'analytics_computed');
});

test('shell wrapper outputs valid JSON', () => {
  const ws = makeWorkspace('proj-shell');
  const stdout = execFileSync('bash', [SHELL, '--workspace', ws, '--project', 'proj-shell'], {
    encoding: 'utf8', timeout: 10000,
  });
  const parsed = JSON.parse(stdout);
  assert.strictEqual(parsed.ok, true);
});

// =========================================================================
// Workspace without .claw/runs
// =========================================================================
console.log('\n--- No runs dir ---');

test('workspace without .claw/runs returns empty', () => {
  const ws = fs.mkdtempSync(path.join(TMP, 'ws-nodir-'));
  const result = buildRunAnalytics({ workspaceRoot: ws, projectId: 'any' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.runs.length, 0);
  assert.strictEqual(result.aggregates.total_runs, 0);
});

// =========================================================================
// Summary
// =========================================================================
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
