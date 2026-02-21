#!/usr/bin/env node
'use strict';

/**
 * Tests for dashboard Phase 4 integration (Epic 6).
 *
 * Validates that project-dashboard.js includes performance_summary,
 * workflow_suggestions_count, and pending_gaps_count in the summary.
 *
 * Run: node skills/dev-pipeline/tests/test-dashboard-phase4.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { buildDashboard } = require(path.resolve(__dirname, '..', 'scripts', 'project-dashboard.js'));
const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));

const dashboardSchema = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'project-dashboard.output.schema.json'), 'utf8')
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-p4-'));
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

function makeWorkspace(projectId, backlogItems) {
  const ws = fs.mkdtempSync(path.join(TMP, 'ws-'));
  const clawDir = path.join(ws, '.claw');
  fs.mkdirSync(path.join(clawDir, 'backlog'), { recursive: true });
  fs.mkdirSync(path.join(clawDir, 'runs'), { recursive: true });
  fs.mkdirSync(path.join(clawDir, 'task-packs'), { recursive: true });
  fs.mkdirSync(path.join(clawDir, 'agents'), { recursive: true });

  fs.writeFileSync(path.join(clawDir, 'project.json'), JSON.stringify({
    project_id: projectId, title: `Test ${projectId}`, description: 'test',
    repo_path: ws, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  }), 'utf8');

  for (const item of (backlogItems || [])) {
    const defaults = {
      project_id: projectId, type: 'task', title: `Task ${item.id}`,
      description: 'test', created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z', status: 'todo',
      priority: 'P2', owner_role: 'DEV', depends_on: [], run_folder: null,
      tags: [], artifacts_expected: [], last_summary: null, ...item,
    };
    fs.writeFileSync(
      path.join(clawDir, 'backlog', `${defaults.id}.json`),
      JSON.stringify(defaults), 'utf8'
    );
  }

  return ws;
}

function addRun(ws, runName, project, opts = {}) {
  const runDir = path.join(ws, '.claw', 'runs', runName);
  fs.mkdirSync(runDir, { recursive: true });

  fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify({
    ticket_id: opts.ticket_id || runName.split('_').pop(),
    title: 'test', project: project,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    current_stage: opts.current_stage || 'done',
    blocked: false, blocked_reason: null,
    responsible_agent: opts.responsible_agent || null,
    required_user_input: [], stage_history: opts.stage_history || [], next_actions: [],
  }), 'utf8');

  if (opts.qa) fs.writeFileSync(path.join(runDir, '50-qa-report.json'), JSON.stringify(opts.qa), 'utf8');
  if (opts.review) fs.writeFileSync(path.join(runDir, '60-review-report.json'), JSON.stringify(opts.review), 'utf8');
}

// =========================================================================
// Empty project (Phase 4 fields present with defaults)
// =========================================================================
console.log('\n--- Empty project Phase 4 fields ---');

test('empty project has Phase 4 summary fields', () => {
  const ws = makeWorkspace('proj-empty', [{ id: 'T-1' }]);
  const result = buildDashboard({ workspaceRoot: ws });

  assert.strictEqual(result.ok, true);
  const s = result.summary;

  assert.ok('performance_summary' in s, 'performance_summary should be present');
  assert.ok('workflow_suggestions_count' in s, 'workflow_suggestions_count should be present');
  assert.ok('pending_gaps_count' in s, 'pending_gaps_count should be present');

  assert.strictEqual(s.performance_summary.agents_tracked, 0);
  assert.strictEqual(s.performance_summary.top_agent, null);
  assert.strictEqual(s.performance_summary.avg_performance_score, null);
  assert.strictEqual(s.workflow_suggestions_count, 0);
  assert.strictEqual(s.pending_gaps_count, 0);
});

test('empty project Phase 4 fields validate against schema', () => {
  const ws = makeWorkspace('proj-val', [{ id: 'T-1' }]);
  const result = buildDashboard({ workspaceRoot: ws });
  const v = validateAgainstSchema(result, dashboardSchema);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);
});

// =========================================================================
// Performance summary
// =========================================================================
console.log('\n--- Performance summary ---');

test('performance_summary reflects agent performance data', () => {
  const ws = makeWorkspace('proj-perf', [{ id: 'T-1' }]);
  addRun(ws, '20260101_000000_T-1', 'proj-perf', {
    current_stage: 'done', responsible_agent: 'agent-a',
    stage_history: [{ stage: 'implement', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:10:00Z', artifact_paths: [], agent_id: 'agent-a' }],
    qa: { ticket_id: 'T-1', tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
    review: { ticket_id: 'T-1', stage_compliance: true, artifact_validation: true, verdict: 'approved' },
  });

  const result = buildDashboard({ workspaceRoot: ws });
  const ps = result.summary.performance_summary;

  assert.strictEqual(ps.agents_tracked, 1);
  assert.strictEqual(ps.top_agent, 'agent-a');
  assert.ok(ps.avg_performance_score !== null);
  assert.ok(ps.avg_performance_score > 0);
});

// =========================================================================
// Workflow suggestions count
// =========================================================================
console.log('\n--- Workflow suggestions count ---');

test('workflow_suggestions_count reflects detected issues', () => {
  const ws = makeWorkspace('proj-wf', [{ id: 'T-1' }]);

  // Create 5 runs with QA failures to trigger recurring_qa_failure suggestion
  for (let i = 1; i <= 5; i++) {
    addRun(ws, `2026010${i}_000000_T-${i}`, 'proj-wf', {
      current_stage: 'done',
      qa: { ticket_id: `T-${i}`, tests_run: 5, tests_passed: 1, tests_failed: 4, verdict: 'fail',
        issues: [{ description: 'Bug', severity: 'high' }] },
      review: { ticket_id: `T-${i}`, stage_compliance: true, artifact_validation: true, verdict: 'rejected' },
    });
  }

  const result = buildDashboard({ workspaceRoot: ws });
  assert.ok(result.summary.workflow_suggestions_count > 0,
    `Expected >0 suggestions, got ${result.summary.workflow_suggestions_count}`);
});

// =========================================================================
// Pending gaps count
// =========================================================================
console.log('\n--- Pending gaps count ---');

test('pending_gaps_count reflects unresolved gaps', () => {
  const ws = makeWorkspace('proj-gap', [{ id: 'T-1' }]);
  addRun(ws, '20260101_000000_T-1', 'proj-gap', {
    current_stage: 'done',
    qa: {
      ticket_id: 'T-1', tests_run: 5, tests_passed: 2, tests_failed: 3, verdict: 'fail',
      issues: [{ description: 'Critical bug', severity: 'critical' }],
    },
  });

  const result = buildDashboard({ workspaceRoot: ws });
  assert.ok(result.summary.pending_gaps_count > 0,
    `Expected >0 gaps, got ${result.summary.pending_gaps_count}`);
});

// =========================================================================
// Schema validation with populated Phase 4 data
// =========================================================================
console.log('\n--- Full schema validation ---');

test('dashboard with Phase 4 data validates against schema', () => {
  const ws = makeWorkspace('proj-full', [{ id: 'T-1' }]);
  addRun(ws, '20260101_000000_T-1', 'proj-full', {
    current_stage: 'done', responsible_agent: 'agent-a',
    stage_history: [{ stage: 'implement', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:10:00Z', artifact_paths: [], agent_id: 'agent-a' }],
    qa: { ticket_id: 'T-1', tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
    review: { ticket_id: 'T-1', stage_compliance: true, artifact_validation: true, verdict: 'approved' },
  });

  const result = buildDashboard({ workspaceRoot: ws });
  const v = validateAgainstSchema(result, dashboardSchema);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);
});

// =========================================================================
// Backward compat
// =========================================================================
console.log('\n--- Backward compat ---');

test('empty workspace (no project.json) still validates with Phase 4 fields', () => {
  const ws = fs.mkdtempSync(path.join(TMP, 'ws-empty-'));
  const result = buildDashboard({ workspaceRoot: ws });
  const v = validateAgainstSchema(result, dashboardSchema);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);
});

test('workspace without .claw returns Phase 4 defaults', () => {
  const ws = fs.mkdtempSync(path.join(TMP, 'ws-noclaw-'));
  const result = buildDashboard({ workspaceRoot: ws });
  assert.strictEqual(result.summary.performance_summary.agents_tracked, 0);
  assert.strictEqual(result.summary.workflow_suggestions_count, 0);
  assert.strictEqual(result.summary.pending_gaps_count, 0);
});

// =========================================================================
// Summary
// =========================================================================
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
