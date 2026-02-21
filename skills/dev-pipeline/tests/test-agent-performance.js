#!/usr/bin/env node
'use strict';

/**
 * Tests for agent-performance.js (Phase 4, Epic 5).
 *
 * Run: node skills/dev-pipeline/tests/test-agent-performance.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { buildAgentPerformance, recommendAgent } = require(path.resolve(__dirname, '..', 'scripts', 'agent-performance.js'));
const { pickNextTask } = require(path.resolve(__dirname, '..', 'scripts', 'project-next-pick.js'));
const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));

const perfSchema = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'agent-performance.output.schema.json'), 'utf8')
);
const pickerSchema = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'project-next-pick.output.schema.json'), 'utf8')
);

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'agent-performance.js');
const SHELL = path.resolve(__dirname, '..', '..', '..', 'tools', 'agent-performance.sh');

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-perf-'));
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
    project_id: projectId, title: `Test ${projectId}`, description: 'test',
    repo_path: ws, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  }), 'utf8');

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
    required_user_input: [],
    stage_history: opts.stage_history || [],
    next_actions: [],
  }), 'utf8');

  if (opts.qa) fs.writeFileSync(path.join(runDir, '50-qa-report.json'), JSON.stringify(opts.qa), 'utf8');
  if (opts.review) fs.writeFileSync(path.join(runDir, '60-review-report.json'), JSON.stringify(opts.review), 'utf8');
}

function addAgentState(ws, agentId, role) {
  const agentDir = path.join(ws, '.claw', 'agents', agentId);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'state.json'), JSON.stringify({
    agent_id: agentId,
    role: role,
    current_task: null,
    workload: { runs_started: 0, stages_completed: 0 },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    last_active_at: '2026-01-01T00:00:00Z',
  }), 'utf8');
}

function addBacklogItem(ws, projectId, item) {
  const defaults = {
    project_id: projectId, type: 'task', title: `Task ${item.id}`,
    description: 'test', created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z', status: 'todo',
    priority: 'P2', owner_role: 'DEV', depends_on: [], run_folder: null,
    tags: [], artifacts_expected: [], last_summary: null, ...item,
  };
  fs.writeFileSync(
    path.join(ws, '.claw', 'backlog', `${defaults.id}.json`),
    JSON.stringify(defaults), 'utf8'
  );
}

// =========================================================================
// No agents
// =========================================================================
console.log('\n--- No agents ---');

test('project with no agent-attributed runs returns empty agents', () => {
  const ws = makeWorkspace('proj-empty');
  addRun(ws, '20260101_000000_T-1', 'proj-empty', { current_stage: 'done' });

  const result = buildAgentPerformance({ workspaceRoot: ws, projectId: 'proj-empty' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.agents.length, 0);
  assert.strictEqual(result.recommended_agent, null);
});

test('empty result validates against schema', () => {
  const ws = makeWorkspace('proj-val');
  const result = buildAgentPerformance({ workspaceRoot: ws, projectId: 'proj-val' });
  const v = validateAgainstSchema(result, perfSchema);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);
});

// =========================================================================
// Single agent
// =========================================================================
console.log('\n--- Single agent ---');

test('single agent gets correct metrics', () => {
  const ws = makeWorkspace('proj-single');
  addRun(ws, '20260101_000000_T-1', 'proj-single', {
    current_stage: 'done',
    responsible_agent: 'agent-a',
    stage_history: [
      { stage: 'implement', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:10:00Z', artifact_paths: [], agent_id: 'agent-a' },
    ],
    qa: { ticket_id: 'T-1', tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
    review: { ticket_id: 'T-1', stage_compliance: true, artifact_validation: true, verdict: 'approved' },
  });

  const result = buildAgentPerformance({ workspaceRoot: ws, projectId: 'proj-single' });
  assert.strictEqual(result.agents.length, 1);
  assert.strictEqual(result.agents[0].agent_id, 'agent-a');
  assert.strictEqual(result.agents[0].runs_count, 1);
  assert.strictEqual(result.agents[0].qa_pass_rate, 1.0);
  assert.strictEqual(result.agents[0].review_approval_rate, 1.0);
  assert.strictEqual(result.recommended_agent, 'agent-a');
});

// =========================================================================
// Ranking
// =========================================================================
console.log('\n--- Ranking ---');

test('recommends agent with highest performance score', () => {
  const ws = makeWorkspace('proj-rank');

  // Agent A: all pass, fast
  addRun(ws, '20260101_000000_T-1', 'proj-rank', {
    current_stage: 'done', responsible_agent: 'agent-a',
    stage_history: [{ stage: 'implement', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:05:00Z', artifact_paths: [], agent_id: 'agent-a' }],
    qa: { ticket_id: 'T-1', tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
    review: { ticket_id: 'T-1', stage_compliance: true, artifact_validation: true, verdict: 'approved' },
  });

  // Agent B: all fail, slow
  addRun(ws, '20260102_000000_T-2', 'proj-rank', {
    current_stage: 'done', responsible_agent: 'agent-b',
    stage_history: [{ stage: 'implement', started_at: '2026-01-02T00:00:00Z', finished_at: '2026-01-02T01:00:00Z', artifact_paths: [], agent_id: 'agent-b' }],
    qa: { ticket_id: 'T-2', tests_run: 5, tests_passed: 1, tests_failed: 4, verdict: 'fail' },
    review: { ticket_id: 'T-2', stage_compliance: true, artifact_validation: true, verdict: 'rejected' },
  });

  const result = buildAgentPerformance({ workspaceRoot: ws, projectId: 'proj-rank' });
  assert.strictEqual(result.agents.length, 2);
  assert.strictEqual(result.recommended_agent, 'agent-a');

  const agentA = result.agents.find(a => a.agent_id === 'agent-a');
  const agentB = result.agents.find(a => a.agent_id === 'agent-b');
  assert.ok(agentA.performance_score > agentB.performance_score);
});

// =========================================================================
// Score calculation
// =========================================================================
console.log('\n--- Score calculation ---');

test('performance score formula is correct', () => {
  const ws = makeWorkspace('proj-score');

  // 2 runs for agent-a: 1 pass, 1 fail; 1 approved, 1 rejected; avg speed = global avg
  addRun(ws, '20260101_000000_T-1', 'proj-score', {
    current_stage: 'done', responsible_agent: 'agent-a',
    stage_history: [{ stage: 'implement', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:10:00Z', artifact_paths: [], agent_id: 'agent-a' }],
    qa: { ticket_id: 'T-1', tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
    review: { ticket_id: 'T-1', stage_compliance: true, artifact_validation: true, verdict: 'approved' },
  });
  addRun(ws, '20260102_000000_T-2', 'proj-score', {
    current_stage: 'done', responsible_agent: 'agent-a',
    stage_history: [{ stage: 'implement', started_at: '2026-01-02T00:00:00Z', finished_at: '2026-01-02T00:10:00Z', artifact_paths: [], agent_id: 'agent-a' }],
    qa: { ticket_id: 'T-2', tests_run: 5, tests_passed: 0, tests_failed: 5, verdict: 'fail' },
    review: { ticket_id: 'T-2', stage_compliance: true, artifact_validation: true, verdict: 'rejected' },
  });

  const result = buildAgentPerformance({ workspaceRoot: ws, projectId: 'proj-score' });
  const agent = result.agents[0];

  // qa_pass_rate = 0.5, review_approval_rate = 0.5, speed_factor = 1.0 (same as global avg)
  // score = 0.4*0.5 + 0.3*0.5 + 0.3*1.0 = 0.2 + 0.15 + 0.3 = 0.65
  assert.strictEqual(agent.qa_pass_rate, 0.5);
  assert.strictEqual(agent.review_approval_rate, 0.5);
  assert.strictEqual(agent.speed_factor, 1.0);
  assert.strictEqual(agent.performance_score, 0.65);
});

// =========================================================================
// Speed factor
// =========================================================================
console.log('\n--- Speed factor ---');

test('faster agent gets higher speed factor', () => {
  const ws = makeWorkspace('proj-speed');

  // Agent A: fast (5 min)
  addRun(ws, '20260101_000000_T-1', 'proj-speed', {
    current_stage: 'done', responsible_agent: 'agent-a',
    stage_history: [{ stage: 'implement', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:05:00Z', artifact_paths: [], agent_id: 'agent-a' }],
    qa: { ticket_id: 'T-1', tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
    review: { ticket_id: 'T-1', stage_compliance: true, artifact_validation: true, verdict: 'approved' },
  });

  // Agent B: slow (30 min)
  addRun(ws, '20260102_000000_T-2', 'proj-speed', {
    current_stage: 'done', responsible_agent: 'agent-b',
    stage_history: [{ stage: 'implement', started_at: '2026-01-02T00:00:00Z', finished_at: '2026-01-02T00:30:00Z', artifact_paths: [], agent_id: 'agent-b' }],
    qa: { ticket_id: 'T-2', tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
    review: { ticket_id: 'T-2', stage_compliance: true, artifact_validation: true, verdict: 'approved' },
  });

  const result = buildAgentPerformance({ workspaceRoot: ws, projectId: 'proj-speed' });
  const agentA = result.agents.find(a => a.agent_id === 'agent-a');
  const agentB = result.agents.find(a => a.agent_id === 'agent-b');

  assert.ok(agentA.speed_factor > agentB.speed_factor, `A=${agentA.speed_factor} should be > B=${agentB.speed_factor}`);
});

// =========================================================================
// Role filter
// =========================================================================
console.log('\n--- Role filter ---');

test('role filter recommends only matching agents', () => {
  const ws = makeWorkspace('proj-role');
  addAgentState(ws, 'dev-1', 'DEV');
  addAgentState(ws, 'qa-1', 'QA');

  addRun(ws, '20260101_000000_T-1', 'proj-role', {
    current_stage: 'done', responsible_agent: 'dev-1',
    stage_history: [{ stage: 'implement', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:10:00Z', artifact_paths: [], agent_id: 'dev-1' }],
    qa: { ticket_id: 'T-1', tests_run: 5, tests_passed: 3, tests_failed: 2, verdict: 'fail' },
    review: { ticket_id: 'T-1', stage_compliance: true, artifact_validation: true, verdict: 'approved' },
  });

  addRun(ws, '20260102_000000_T-2', 'proj-role', {
    current_stage: 'done', responsible_agent: 'qa-1',
    stage_history: [{ stage: 'validate', started_at: '2026-01-02T00:00:00Z', finished_at: '2026-01-02T00:10:00Z', artifact_paths: [], agent_id: 'qa-1' }],
    qa: { ticket_id: 'T-2', tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
    review: { ticket_id: 'T-2', stage_compliance: true, artifact_validation: true, verdict: 'approved' },
  });

  const result = buildAgentPerformance({ workspaceRoot: ws, projectId: 'proj-role', role: 'QA' });
  // Both agents appear in the agents list (unfiltered)
  assert.strictEqual(result.agents.length, 2);
  // But recommendation is filtered to QA role
  assert.strictEqual(result.recommended_agent, 'qa-1');
});

// =========================================================================
// Empty role match
// =========================================================================
console.log('\n--- Empty role match ---');

test('role filter with no matching agents returns null', () => {
  const ws = makeWorkspace('proj-norole');
  addAgentState(ws, 'dev-1', 'DEV');

  addRun(ws, '20260101_000000_T-1', 'proj-norole', {
    current_stage: 'done', responsible_agent: 'dev-1',
    qa: { ticket_id: 'T-1', tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
    review: { ticket_id: 'T-1', stage_compliance: true, artifact_validation: true, verdict: 'approved' },
  });

  const result = buildAgentPerformance({ workspaceRoot: ws, projectId: 'proj-norole', role: 'ARCHITECT' });
  assert.strictEqual(result.recommended_agent, null);
});

// =========================================================================
// Schema validation
// =========================================================================
console.log('\n--- Schema validation ---');

test('full result validates against schema', () => {
  const ws = makeWorkspace('proj-sv');
  addRun(ws, '20260101_000000_T-1', 'proj-sv', {
    current_stage: 'done', responsible_agent: 'agent-a',
    stage_history: [{ stage: 'implement', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:10:00Z', artifact_paths: [], agent_id: 'agent-a' }],
    qa: { ticket_id: 'T-1', tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
    review: { ticket_id: 'T-1', stage_compliance: true, artifact_validation: true, verdict: 'approved' },
  });

  const result = buildAgentPerformance({ workspaceRoot: ws, projectId: 'proj-sv' });
  const v = validateAgainstSchema(result, perfSchema);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);
});

// =========================================================================
// Picker integration
// =========================================================================
console.log('\n--- Picker integration ---');

test('picker output includes recommended_agent field', () => {
  const ws = makeWorkspace('proj-pick');
  addBacklogItem(ws, 'proj-pick', { id: 'T-1', status: 'todo', owner_role: 'DEV' });

  addRun(ws, '20260101_000000_T-0', 'proj-pick', {
    current_stage: 'done', responsible_agent: 'agent-a',
    qa: { ticket_id: 'T-0', tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
    review: { ticket_id: 'T-0', stage_compliance: true, artifact_validation: true, verdict: 'approved' },
  });

  const result = pickNextTask({ workspaceRoot: ws });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.action, 'picked_task');
  assert.ok('recommended_agent' in result, 'should have recommended_agent field');
});

test('picker output validates against updated schema', () => {
  const ws = makeWorkspace('proj-pv');
  addBacklogItem(ws, 'proj-pv', { id: 'T-1', status: 'todo', owner_role: 'DEV' });

  const result = pickNextTask({ workspaceRoot: ws });
  assert.strictEqual(result.ok, true);
  const v = validateAgainstSchema(result, pickerSchema);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);
});

// =========================================================================
// Backward compat
// =========================================================================
console.log('\n--- Backward compat ---');

test('picker with no agent data sets recommended_agent to null', () => {
  const ws = makeWorkspace('proj-compat');
  addBacklogItem(ws, 'proj-compat', { id: 'T-1', status: 'todo', owner_role: 'DEV' });

  const result = pickNextTask({ workspaceRoot: ws });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.recommended_agent, null);
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
  assert.strictEqual(parsed.action, 'performance_computed');
});

// =========================================================================
// Summary
// =========================================================================
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
