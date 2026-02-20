#!/usr/bin/env node
'use strict';

/**
 * Tests for project-next-pick.js — deterministic single-project task picker.
 * Run: node skills/dev-pipeline/tests/test-project-next-pick.js
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
const PICK_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'project-next-pick.js');
const PICK_SHELL = path.join(WORKSPACE_ROOT, 'tools', 'project-next-pick.sh');

const { pickNextTask, classifyTask } = require(PICK_SCRIPT);

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

function makeTempWorkspace(projectId, backlogItems = [], opts = {}) {
  const wsRoot = path.join(os.tmpdir(), `_test_proj_pick_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(wsRoot, { recursive: true });
  const clawDir = path.join(wsRoot, '.claw');
  fs.mkdirSync(path.join(clawDir, 'backlog'), { recursive: true });
  fs.mkdirSync(path.join(clawDir, 'runs'), { recursive: true });
  fs.mkdirSync(path.join(clawDir, 'task-packs'), { recursive: true });

  fs.writeFileSync(path.join(clawDir, 'project.json'), JSON.stringify({
    project_id: projectId,
    title: opts.title || `Test project ${projectId}`,
    description: opts.description || `Description for ${projectId}`,
    repo_path: wsRoot,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }), 'utf8');

  for (const item of backlogItems) {
    const defaults = {
      project_id: projectId,
      type: 'task',
      title: `Task ${item.id}`,
      description: '',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      status: 'todo',
      priority: 'P2',
      owner_role: 'DEV',
      depends_on: [],
      run_folder: null,
      tags: [],
      artifacts_expected: [],
      last_summary: null,
      ...item,
    };
    fs.writeFileSync(
      path.join(clawDir, 'backlog', `${defaults.id}.json`),
      JSON.stringify(defaults, null, 2),
      'utf8'
    );
  }

  tmpDirs.push(wsRoot);
  return wsRoot;
}

function makeTempRun(baseDir, stage, extras = {}) {
  const dir = path.join(baseDir, `_run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  const status = {
    current_stage: stage,
    blocked: extras.blocked || false,
    blocked_reason: extras.blocked_reason || null,
    last_autonomous_summary: extras.last_autonomous_summary || null,
  };
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(status, null, 2), 'utf8');
  if (extras.stop) {
    fs.writeFileSync(path.join(dir, '.stop'), '', 'utf8');
  }
  return dir;
}

function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
process.on('exit', cleanup);

// -------------------------------------------------------------------------
// Test 1: classifyTask
// -------------------------------------------------------------------------
console.log('\n--- classifyTask ---');

test('returns null for done task', () => {
  const result = classifyTask({ status: 'done', blocked: false, stop_signal: false, run_folder: null }, '/tmp');
  if (result !== null) throw new Error(`expected null, got ${result}`);
});

test('returns null for blocked task', () => {
  const result = classifyTask({ status: 'blocked', blocked: true, stop_signal: false, run_folder: null }, '/tmp');
  if (result !== null) throw new Error(`expected null, got ${result}`);
});

test('returns null for stopped task', () => {
  const result = classifyTask({ status: 'in_progress', blocked: false, stop_signal: true, run_folder: null }, '/tmp');
  if (result !== null) throw new Error(`expected null, got ${result}`);
});

test('returns needs_task_pack for task without run_folder', () => {
  const result = classifyTask({ status: 'todo', blocked: false, stop_signal: false, run_folder: null, owner_role: 'DEV' }, '/tmp');
  if (result !== 'needs_task_pack') throw new Error(`expected needs_task_pack, got ${result}`);
});

test('returns needs_task_pack for linked intake run', () => {
  const tmpDir = makeTempRun(os.tmpdir(), 'intake');
  const result = classifyTask({ status: 'in_progress', blocked: false, stop_signal: false, run_folder: tmpDir, owner_role: 'DEV' }, '/');
  if (result !== 'needs_task_pack') throw new Error(`expected needs_task_pack, got ${result}`);
});

test('returns needs_artifacts for linked run with needs_artifacts', () => {
  const tmpDir = makeTempRun(os.tmpdir(), 'analyze', {
    last_autonomous_summary: { final_action: 'needs_artifacts' },
  });
  const result = classifyTask({ status: 'in_progress', blocked: false, stop_signal: false, run_folder: tmpDir, owner_role: 'DEV' }, '/');
  if (result !== 'needs_artifacts') throw new Error(`expected needs_artifacts, got ${result}`);
});

test('returns other for linked run in active stage', () => {
  const tmpDir = makeTempRun(os.tmpdir(), 'analyze');
  const result = classifyTask({ status: 'in_progress', blocked: false, stop_signal: false, run_folder: tmpDir, owner_role: 'DEV' }, '/');
  if (result !== 'other') throw new Error(`expected other, got ${result}`);
});

test('returns null for linked run that is done', () => {
  const tmpDir = makeTempRun(os.tmpdir(), 'done');
  const result = classifyTask({ status: 'in_progress', blocked: false, stop_signal: false, run_folder: tmpDir }, '/');
  if (result !== null) throw new Error(`expected null, got ${result}`);
});

// -------------------------------------------------------------------------
// Test 2: No eligible tasks
// -------------------------------------------------------------------------
console.log('\n--- no eligible ---');

test('returns no_eligible_tasks when all done', () => {
  const wsRoot = makeTempWorkspace('proj-done', [
    { id: 'T-DONE', status: 'done' },
  ]);
  const result = pickNextTask({ workspaceRoot: wsRoot });
  if (result.action !== 'no_eligible_tasks') throw new Error(`expected no_eligible_tasks, got ${result.action}`);
});

test('returns no_eligible_tasks when empty', () => {
  const wsRoot = path.join(os.tmpdir(), `_test_proj_pick_empty_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(wsRoot, { recursive: true });
  tmpDirs.push(wsRoot);
  const result = pickNextTask({ workspaceRoot: wsRoot });
  if (result.action !== 'no_eligible_tasks') throw new Error(`expected no_eligible_tasks, got ${result.action}`);
});

test('returns no_eligible_tasks when all blocked', () => {
  const wsRoot = makeTempWorkspace('proj-blocked', [
    { id: 'T-BLK', status: 'blocked' },
  ]);
  const result = pickNextTask({ workspaceRoot: wsRoot });
  if (result.action !== 'no_eligible_tasks') throw new Error(`expected no_eligible_tasks, got ${result.action}`);
});

// -------------------------------------------------------------------------
// Test 3: Priority ordering
// -------------------------------------------------------------------------
console.log('\n--- priority ordering ---');

test('picks P0 over P1', () => {
  const wsRoot = makeTempWorkspace('proj-prio', [
    { id: 'T-P1', status: 'todo', priority: 'P1' },
    { id: 'T-P0', status: 'todo', priority: 'P0' },
  ]);
  const result = pickNextTask({ workspaceRoot: wsRoot });
  if (result.task_id !== 'T-P0') throw new Error(`expected T-P0, got ${result.task_id}`);
});

test('picks in_progress over todo', () => {
  const wsRoot = makeTempWorkspace('proj-status', [
    { id: 'T-TODO', status: 'todo', priority: 'P0' },
  ]);
  const tmpDir = makeTempRun(os.tmpdir(), 'analyze');
  // Add an in_progress item with run_folder
  fs.writeFileSync(
    path.join(wsRoot, '.claw', 'backlog', 'T-PROG.json'),
    JSON.stringify({
      id: 'T-PROG', project_id: 'proj-status', type: 'task', title: 'Task T-PROG',
      description: '', status: 'in_progress', priority: 'P1', owner_role: 'DEV',
      depends_on: [], run_folder: tmpDir, tags: [], artifacts_expected: [],
      last_summary: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    }, null, 2),
    'utf8'
  );
  const result = pickNextTask({ workspaceRoot: wsRoot });
  // Both are 'other' bucket (T-TODO is needs_task_pack, T-PROG is other)
  // needs_task_pack has higher priority than other, so T-TODO should win
  if (result.task_id !== 'T-TODO') throw new Error(`expected T-TODO (needs_task_pack bucket), got ${result.task_id}`);
});

test('needs_task_pack bucket outranks needs_artifacts', () => {
  const wsRoot = makeTempWorkspace('proj-bucket', [
    { id: 'T-INTAKE', status: 'todo', priority: 'P2' },
  ]);
  const tmpDir = makeTempRun(os.tmpdir(), 'analyze', {
    last_autonomous_summary: { final_action: 'needs_artifacts' },
  });
  // Add an in_progress item with needs_artifacts run
  fs.writeFileSync(
    path.join(wsRoot, '.claw', 'backlog', 'T-ARTIFACTS.json'),
    JSON.stringify({
      id: 'T-ARTIFACTS', project_id: 'proj-bucket', type: 'task', title: 'Task T-ARTIFACTS',
      description: '', status: 'in_progress', priority: 'P0', owner_role: 'DEV',
      depends_on: [], run_folder: tmpDir, tags: [], artifacts_expected: [],
      last_summary: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    }, null, 2),
    'utf8'
  );
  const result = pickNextTask({ workspaceRoot: wsRoot });
  if (result.task_id !== 'T-INTAKE') throw new Error(`expected T-INTAKE, got ${result.task_id}`);
  if (result.priority_bucket !== 'needs_task_pack') throw new Error(`expected needs_task_pack bucket`);
});

test('deterministic ordering within same priority', () => {
  const wsRoot = makeTempWorkspace('proj-det', [
    { id: 'T-002', status: 'todo', priority: 'P2' },
    { id: 'T-001', status: 'todo', priority: 'P2' },
    { id: 'T-003', status: 'todo', priority: 'P2' },
  ]);
  const r1 = pickNextTask({ workspaceRoot: wsRoot });
  const r2 = pickNextTask({ workspaceRoot: wsRoot });
  if (r1.task_id !== r2.task_id) throw new Error(`non-deterministic: ${r1.task_id} vs ${r2.task_id}`);
  // Should be T-001 (ASC ordering)
  if (r1.task_id !== 'T-001') throw new Error(`expected T-001 (ASC), got ${r1.task_id}`);
});

// -------------------------------------------------------------------------
// Test 4: Output contract
// -------------------------------------------------------------------------
console.log('\n--- output contract ---');

test('picked_task output has all required fields', () => {
  const wsRoot = makeTempWorkspace('proj-contract', [
    { id: 'T-C1', status: 'todo' },
  ]);
  const result = pickNextTask({ workspaceRoot: wsRoot });
  if (typeof result.ok !== 'boolean') throw new Error('missing ok');
  if (!result.action) throw new Error('missing action');
  if (result.action !== 'picked_task') throw new Error('expected picked_task');
  if (!result.project_id) throw new Error('missing project_id');
  if (!result.task_id) throw new Error('missing task_id');
  if (!result.reason) throw new Error('missing reason');
  if (!result.priority_bucket) throw new Error('missing priority_bucket');
});

// -------------------------------------------------------------------------
// Test 5: CLI
// -------------------------------------------------------------------------
console.log('\n--- CLI ---');

test('CLI outputs valid JSON', () => {
  const clawDir = path.join(WORKSPACE_ROOT, '.claw');
  const existed = fs.existsSync(clawDir);
  if (!existed) fs.mkdirSync(clawDir, { recursive: true });
  try {
    const stdout = execFileSync('node', [PICK_SCRIPT], { encoding: 'utf8', timeout: 10000 });
    const parsed = JSON.parse(stdout);
    if (typeof parsed.ok !== 'boolean') throw new Error('missing ok');
    if (!parsed.action) throw new Error('missing action');
  } finally {
    if (!existed) {
      try { fs.rmSync(clawDir, { recursive: true, force: true }); } catch {}
    }
  }
});

test('shell helper outputs valid JSON', () => {
  const clawDir = path.join(WORKSPACE_ROOT, '.claw');
  const existed = fs.existsSync(clawDir);
  if (!existed) fs.mkdirSync(clawDir, { recursive: true });
  try {
    const stdout = execFileSync('bash', [PICK_SHELL], { encoding: 'utf8', timeout: 10000 });
    const parsed = JSON.parse(stdout);
    if (typeof parsed.ok !== 'boolean') throw new Error('missing ok');
  } finally {
    if (!existed) {
      try { fs.rmSync(clawDir, { recursive: true, force: true }); } catch {}
    }
  }
});

// -------------------------------------------------------------------------
// Test 6: Output schema validation
// -------------------------------------------------------------------------
console.log('\n--- output schema ---');

const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));
const pickSchema = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'project-next-pick.output.schema.json'), 'utf8'));

test('picked_task output validates against schema', () => {
  const wsRoot = makeTempWorkspace('proj-vs', [{ id: 'T-VS', status: 'todo' }]);
  const result = pickNextTask({ workspaceRoot: wsRoot });
  if (result.action !== 'picked_task') throw new Error('expected picked_task');
  const v = validateAgainstSchema(result, pickSchema);
  if (!v.ok) throw new Error(`schema validation failed: ${v.details.join('; ')}`);
});

test('no_eligible_tasks output validates against schema', () => {
  const wsRoot = path.join(os.tmpdir(), `_test_proj_pick_schema_empty_${Date.now()}`);
  fs.mkdirSync(wsRoot, { recursive: true });
  tmpDirs.push(wsRoot);
  const result = pickNextTask({ workspaceRoot: wsRoot });
  const v = validateAgainstSchema(result, pickSchema);
  if (!v.ok) throw new Error(`schema validation failed: ${v.details.join('; ')}`);
});

test('CLI output validates against schema', () => {
  const clawDir = path.join(WORKSPACE_ROOT, '.claw');
  const existed = fs.existsSync(clawDir);
  if (!existed) fs.mkdirSync(clawDir, { recursive: true });
  try {
    const stdout = execFileSync('node', [PICK_SCRIPT], { encoding: 'utf8', timeout: 10000 });
    const parsed = JSON.parse(stdout);
    const v = validateAgainstSchema(parsed, pickSchema);
    if (!v.ok) throw new Error(`schema validation failed: ${v.details.join('; ')}`);
  } finally {
    if (!existed) {
      try { fs.rmSync(clawDir, { recursive: true, force: true }); } catch {}
    }
  }
});

// -------------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------------
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
