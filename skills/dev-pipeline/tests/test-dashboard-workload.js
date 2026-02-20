#!/usr/bin/env node
'use strict';

/**
 * Tests for agent workload statistics in project dashboard output.
 * Run: node skills/dev-pipeline/tests/test-dashboard-workload.js
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DASHBOARD_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'project-dashboard.js');
const { buildDashboard } = require(DASHBOARD_SCRIPT);
const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));
const dashboardSchema = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '..', 'schemas', 'project-dashboard.output.schema.json'), 'utf8'));

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

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `_test_dw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function makeTempWorkspace(projectId, backlogItems = []) {
  const wsRoot = path.join(os.tmpdir(), `_test_dw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const clawRoot = path.join(wsRoot, '.claw');
  const backlogDir = path.join(clawRoot, 'backlog');
  fs.mkdirSync(backlogDir, { recursive: true });
  tmpDirs.push(wsRoot);

  fs.writeFileSync(path.join(clawRoot, 'project.json'), JSON.stringify({
    project_id: projectId,
    title: `Test ${projectId}`,
    description: `Desc ${projectId}`,
    repo_path: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }, null, 2), 'utf8');

  for (const item of backlogItems) {
    const defaults = {
      project_id: projectId, type: 'task', title: `Task ${item.id}`,
      description: '', created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z', status: 'todo',
      priority: 'P2', owner_role: 'DEV', depends_on: [], run_folder: null,
      tags: [], artifacts_expected: [], last_summary: null,
      ...item,
    };
    fs.writeFileSync(
      path.join(backlogDir, `${defaults.id}.json`),
      JSON.stringify(defaults, null, 2), 'utf8');
  }
  return { wsRoot, backlogDir };
}

function makeRunFolder(statusData) {
  const runDir = makeTempDir();
  fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify(statusData, null, 2), 'utf8');
  return runDir;
}

function makeAgentsDir(agents) {
  const dir = makeTempDir();
  for (const a of agents) {
    const agentDir = path.join(dir, a.agent_id);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'state.json'), JSON.stringify({
      agent_id: a.agent_id,
      role: a.role,
      current_task: null,
      workload: { runs_started: 0, stages_completed: 0 },
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      last_active_at: '2026-01-01T00:00:00.000Z',
    }, null, 2), 'utf8');
  }
  return dir;
}

function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}
process.on('exit', cleanup);

// ---------------------------------------------------------------------------
console.log('\n--- workload_by_agent ---');
// ---------------------------------------------------------------------------

test('no runs -> workload_by_agent empty array', () => {
  const { wsRoot } = makeTempWorkspace('proj-empty', [{ id: 'T-1', status: 'todo' }]);
  const result = buildDashboard({ workspaceRoot: wsRoot });
  assert(result.ok, 'should be ok');
  const proj = result.projects[0];
  assert(Array.isArray(proj.workload_by_agent), 'should be array');
  assert(proj.workload_by_agent.length === 0, `should be empty, got ${proj.workload_by_agent.length}`);
});

test('no runs -> workload_summary exists with empty objects', () => {
  const { wsRoot } = makeTempWorkspace('proj-empty2', [{ id: 'T-1', status: 'todo' }]);
  const result = buildDashboard({ workspaceRoot: wsRoot });
  assert(result.summary.workload_summary, 'should have workload_summary');
  assert(typeof result.summary.workload_summary.runs_per_role === 'object', 'runs_per_role should be object');
  assert(typeof result.summary.workload_summary.stages_per_role === 'object', 'stages_per_role should be object');
  assert(Object.keys(result.summary.workload_summary.runs_per_role).length === 0, 'runs_per_role should be empty');
  assert(Object.keys(result.summary.workload_summary.stages_per_role).length === 0, 'stages_per_role should be empty');
});

test('responsible_agent counts runs_responsible', () => {
  const runDir = makeRunFolder({
    current_stage: 'analyze', blocked: false,
    responsible_agent: 'agent-pm-1',
    stage_history: [],
  });
  const agentsDir = makeAgentsDir([{ agent_id: 'agent-pm-1', role: 'PM' }]);
  const { wsRoot } = makeTempWorkspace('proj-rr', [
    { id: 'T-RR', status: 'in_progress', run_folder: runDir },
  ]);
  const result = buildDashboard({ workspaceRoot: wsRoot, agentsDir, _roleCache: {} });
  const wl = result.projects[0].workload_by_agent;
  assert(wl.length === 1, `expected 1 agent, got ${wl.length}`);
  assert(wl[0].agent_id === 'agent-pm-1', 'wrong agent_id');
  assert(wl[0].runs_responsible === 1, `expected 1 run, got ${wl[0].runs_responsible}`);
});

test('stage_history counts stages_driven', () => {
  const runDir = makeRunFolder({
    current_stage: 'plan', blocked: false,
    responsible_agent: 'agent-a',
    stage_history: [
      { stage: 'intake', agent_id: 'agent-a' },
      { stage: 'analyze', agent_id: 'agent-a' },
      { stage: 'plan', agent_id: 'agent-b' },
    ],
  });
  const agentsDir = makeAgentsDir([
    { agent_id: 'agent-a', role: 'PM' },
    { agent_id: 'agent-b', role: 'Architect' },
  ]);
  const { wsRoot } = makeTempWorkspace('proj-sd', [
    { id: 'T-SD', status: 'in_progress', run_folder: runDir },
  ]);
  const result = buildDashboard({ workspaceRoot: wsRoot, agentsDir, _roleCache: {} });
  const wl = result.projects[0].workload_by_agent;
  const a = wl.find(w => w.agent_id === 'agent-a');
  const b = wl.find(w => w.agent_id === 'agent-b');
  assert(a, 'agent-a should be in workload');
  assert(b, 'agent-b should be in workload');
  assert(a.stages_driven === 2, `agent-a stages_driven should be 2, got ${a.stages_driven}`);
  assert(b.stages_driven === 1, `agent-b stages_driven should be 1, got ${b.stages_driven}`);
});

test('active_runs counts only when current_stage != done', () => {
  const runActive = makeRunFolder({
    current_stage: 'analyze', blocked: false,
    responsible_agent: 'agent-x',
    stage_history: [],
  });
  const runDone = makeRunFolder({
    current_stage: 'done', blocked: false,
    responsible_agent: 'agent-x',
    stage_history: [],
  });
  const agentsDir = makeAgentsDir([{ agent_id: 'agent-x', role: 'Dev' }]);
  const { wsRoot } = makeTempWorkspace('proj-ar', [
    { id: 'T-AR1', status: 'in_progress', run_folder: runActive },
    { id: 'T-AR2', status: 'done', run_folder: runDone },
  ]);
  const result = buildDashboard({ workspaceRoot: wsRoot, agentsDir, _roleCache: {} });
  const wl = result.projects[0].workload_by_agent;
  assert(wl.length === 1, `expected 1 agent, got ${wl.length}`);
  assert(wl[0].runs_responsible === 2, `expected 2 runs_responsible, got ${wl[0].runs_responsible}`);
  assert(wl[0].active_runs === 1, `expected 1 active_run, got ${wl[0].active_runs}`);
});

test('null agent_id excluded from all counts', () => {
  const runDir = makeRunFolder({
    current_stage: 'analyze', blocked: false,
    responsible_agent: null,
    stage_history: [
      { stage: 'intake', agent_id: null },
      { stage: 'analyze', agent_id: null },
    ],
  });
  const { wsRoot } = makeTempWorkspace('proj-null', [
    { id: 'T-NULL', status: 'in_progress', run_folder: runDir },
  ]);
  const result = buildDashboard({ workspaceRoot: wsRoot });
  assert(result.projects[0].workload_by_agent.length === 0,
    `expected empty workload, got ${result.projects[0].workload_by_agent.length}`);
});

test('role resolved from agent-state', () => {
  const runDir = makeRunFolder({
    current_stage: 'analyze', blocked: false,
    responsible_agent: 'agent-role-test',
    stage_history: [{ stage: 'intake', agent_id: 'agent-role-test' }],
  });
  const agentsDir = makeAgentsDir([{ agent_id: 'agent-role-test', role: 'QA' }]);
  const { wsRoot } = makeTempWorkspace('proj-role', [
    { id: 'T-ROLE', status: 'in_progress', run_folder: runDir },
  ]);
  const result = buildDashboard({ workspaceRoot: wsRoot, agentsDir, _roleCache: {} });
  const wl = result.projects[0].workload_by_agent;
  assert(wl[0].role === 'QA', `expected QA, got ${wl[0].role}`);
});

test('unknown role when agent state missing', () => {
  const runDir = makeRunFolder({
    current_stage: 'analyze', blocked: false,
    responsible_agent: 'ghost-agent',
    stage_history: [],
  });
  const agentsDir = makeAgentsDir([]); // no agents registered
  const { wsRoot } = makeTempWorkspace('proj-ghost', [
    { id: 'T-GHOST', status: 'in_progress', run_folder: runDir },
  ]);
  const result = buildDashboard({ workspaceRoot: wsRoot, agentsDir, _roleCache: {} });
  const wl = result.projects[0].workload_by_agent;
  assert(wl[0].role === 'unknown', `expected unknown, got ${wl[0].role}`);
});

// ---------------------------------------------------------------------------
console.log('\n--- workload_summary ---');
// ---------------------------------------------------------------------------

test('workload_summary aggregates runs_per_role across multiple runs', () => {
  const run1 = makeRunFolder({
    current_stage: 'analyze', blocked: false,
    responsible_agent: 'pm-1',
    stage_history: [],
  });
  const run2 = makeRunFolder({
    current_stage: 'implement', blocked: false,
    responsible_agent: 'dev-1',
    stage_history: [],
  });
  const run3 = makeRunFolder({
    current_stage: 'analyze', blocked: false,
    responsible_agent: 'pm-2',
    stage_history: [],
  });
  const agentsDir = makeAgentsDir([
    { agent_id: 'pm-1', role: 'PM' },
    { agent_id: 'pm-2', role: 'PM' },
    { agent_id: 'dev-1', role: 'Dev' },
  ]);
  const { wsRoot } = makeTempWorkspace('proj-s1', [
    { id: 'T-S1', status: 'in_progress', run_folder: run1 },
    { id: 'T-S2', status: 'in_progress', run_folder: run2 },
    { id: 'T-S3', status: 'in_progress', run_folder: run3 },
  ]);
  const result = buildDashboard({ workspaceRoot: wsRoot, agentsDir, _roleCache: {} });
  const rpr = result.summary.workload_summary.runs_per_role;
  assert(rpr.PM === 2, `expected PM=2, got ${rpr.PM}`);
  assert(rpr.Dev === 1, `expected Dev=1, got ${rpr.Dev}`);
});

test('workload_summary aggregates stages_per_role', () => {
  const run1 = makeRunFolder({
    current_stage: 'plan', blocked: false,
    responsible_agent: null,
    stage_history: [
      { stage: 'intake', agent_id: 'pm-1' },
      { stage: 'analyze', agent_id: 'pm-1' },
      { stage: 'plan', agent_id: 'arch-1' },
    ],
  });
  const agentsDir = makeAgentsDir([
    { agent_id: 'pm-1', role: 'PM' },
    { agent_id: 'arch-1', role: 'Architect' },
  ]);
  const { wsRoot } = makeTempWorkspace('proj-spr', [
    { id: 'T-SPR', status: 'in_progress', run_folder: run1 },
  ]);
  const result = buildDashboard({ workspaceRoot: wsRoot, agentsDir, _roleCache: {} });
  const spr = result.summary.workload_summary.stages_per_role;
  assert(spr.PM === 2, `expected PM=2, got ${spr.PM}`);
  assert(spr.Architect === 1, `expected Architect=1, got ${spr.Architect}`);
});

// ---------------------------------------------------------------------------
console.log('\n--- determinism ---');
// ---------------------------------------------------------------------------

test('workload_by_agent sorted by agent_id', () => {
  const runDir = makeRunFolder({
    current_stage: 'analyze', blocked: false,
    responsible_agent: 'zzz-agent',
    stage_history: [
      { stage: 'intake', agent_id: 'aaa-agent' },
      { stage: 'analyze', agent_id: 'mmm-agent' },
    ],
  });
  const agentsDir = makeAgentsDir([]);
  const { wsRoot } = makeTempWorkspace('proj-det', [
    { id: 'T-DET', status: 'in_progress', run_folder: runDir },
  ]);
  const result = buildDashboard({ workspaceRoot: wsRoot, agentsDir, _roleCache: {} });
  const ids = result.projects[0].workload_by_agent.map(w => w.agent_id);
  assert(ids[0] === 'aaa-agent', `first should be aaa-agent, got ${ids[0]}`);
  assert(ids[1] === 'mmm-agent', `second should be mmm-agent, got ${ids[1]}`);
  assert(ids[2] === 'zzz-agent', `third should be zzz-agent, got ${ids[2]}`);
});

// ---------------------------------------------------------------------------
console.log('\n--- schema validation ---');
// ---------------------------------------------------------------------------

test('full output validates against updated schema', () => {
  const run1 = makeRunFolder({
    current_stage: 'analyze', blocked: false,
    responsible_agent: 'agent-sv',
    stage_history: [{ stage: 'intake', agent_id: 'agent-sv' }],
  });
  const agentsDir = makeAgentsDir([{ agent_id: 'agent-sv', role: 'PM' }]);
  const { wsRoot } = makeTempWorkspace('proj-sv', [
    { id: 'T-SV1', status: 'in_progress', run_folder: run1 },
    { id: 'T-SV2', status: 'done' },
  ]);
  const result = buildDashboard({ workspaceRoot: wsRoot, agentsDir, _roleCache: {} });
  const v = validateAgainstSchema(result, dashboardSchema);
  assert(v.ok, `schema validation failed: ${v.ok ? '' : v.details.join('; ')}`);
});

test('empty dashboard validates against schema', () => {
  const { wsRoot } = makeTempWorkspace('proj-empty-sv', []);
  const result = buildDashboard({ workspaceRoot: wsRoot });
  const v = validateAgainstSchema(result, dashboardSchema);
  assert(v.ok, `schema validation failed: ${v.ok ? '' : v.details.join('; ')}`);
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
cleanup();

console.log(`\n========================================`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`========================================`);

process.exit(failed > 0 ? 1 : 0);
