#!/usr/bin/env node
'use strict';

/**
 * P2-03: Tests for graph-aware picker — depends_on and parent constraints.
 * Run: node skills/dev-pipeline/tests/test-picker-graph.js
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
const PICK_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'project-next-pick.js');

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

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function makeTempWorkspace(projectId, backlogItems = []) {
  const wsRoot = path.join(os.tmpdir(), `_test_pgraph_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const clawRoot = path.join(wsRoot, '.claw');
  const backlogDir = path.join(clawRoot, 'backlog');
  fs.mkdirSync(backlogDir, { recursive: true });
  tmpDirs.push(wsRoot);

  fs.writeFileSync(path.join(clawRoot, 'project.json'), JSON.stringify({
    project_id: projectId,
    title: `Test ${projectId}`,
    description: 'test',
    repo_path: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }, null, 2), 'utf8');

  for (const item of backlogItems) {
    const defaults = {
      project_id: projectId, type: 'task', title: `Task ${item.id}`,
      description: '', created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z', status: 'todo',
      priority: 'P2', owner_role: 'DEV', depends_on: [],
      parent_id: null, run_folder: null, tags: [],
      artifacts_expected: [], last_summary: null,
      ...item,
    };
    fs.writeFileSync(
      path.join(backlogDir, `${defaults.id}.json`),
      JSON.stringify(defaults, null, 2), 'utf8'
    );
  }
  return { wsRoot, backlogDir };
}

function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
process.on('exit', cleanup);

// Helper: build sibling items array (simulating what project-index provides)
function makeSiblings(items) {
  return items.map(item => ({
    id: item.id,
    type: item.type || 'task',
    status: item.status || 'todo',
    priority: item.priority || 'P2',
    owner_role: item.owner_role || 'DEV',
    parent_id: item.parent_id || null,
    depends_on: item.depends_on || [],
    run_folder: item.run_folder || null,
    stop_signal: false,
    blocked: item.status === 'blocked' || item.blocked || false,
    stalled: false,
    last_summary: null,
  }));
}

// -------------------------------------------------------------------------
// classifyTask: depends_on enforcement
// -------------------------------------------------------------------------
console.log('\n--- classifyTask: depends_on ---');

test('skips task with unsatisfied dependency (dep is todo)', () => {
  const siblings = makeSiblings([
    { id: 'DEP-1', status: 'todo' },
    { id: 'T-1', depends_on: ['DEP-1'] },
  ]);
  // Capture stderr
  const origWrite = process.stderr.write;
  let stderrOut = '';
  process.stderr.write = (s) => { stderrOut += s; };
  const result = classifyTask(siblings[1], '/tmp', 'proj', siblings);
  process.stderr.write = origWrite;

  assert(result === null, `should return null, got ${result}`);
  assert(stderrOut.includes('skipped_unsatisfied_deps'), 'should emit unsatisfied_deps warning');
  assert(stderrOut.includes('DEP-1'), 'warning should mention blocking dep');
});

test('skips task with unsatisfied dependency (dep is in_progress)', () => {
  const siblings = makeSiblings([
    { id: 'DEP-2', status: 'in_progress' },
    { id: 'T-2', depends_on: ['DEP-2'] },
  ]);
  const result = classifyTask(siblings[1], '/tmp', 'proj', siblings);
  assert(result === null, 'should return null');
});

test('allows task when all dependencies are done', () => {
  const siblings = makeSiblings([
    { id: 'DEP-3', status: 'done' },
    { id: 'T-3', depends_on: ['DEP-3'] },
  ]);
  const result = classifyTask(siblings[1], '/tmp', 'proj', siblings);
  assert(result !== null, 'should not be null');
  assert(result === 'needs_task_pack', `expected needs_task_pack, got ${result}`);
});

test('allows task with no dependencies', () => {
  const siblings = makeSiblings([
    { id: 'T-4', depends_on: [] },
  ]);
  const result = classifyTask(siblings[0], '/tmp', 'proj', siblings);
  assert(result !== null, 'should not be null');
});

test('allows task when dependency does not exist in backlog (dangling)', () => {
  const siblings = makeSiblings([
    { id: 'T-5', depends_on: ['GHOST'] },
  ]);
  // Dangling deps are NOT blocking — only existing non-done deps block
  const result = classifyTask(siblings[0], '/tmp', 'proj', siblings);
  assert(result !== null, 'dangling dep should not block');
});

test('skips task when one of multiple deps is not done', () => {
  const siblings = makeSiblings([
    { id: 'DEP-A', status: 'done' },
    { id: 'DEP-B', status: 'todo' },
    { id: 'T-6', depends_on: ['DEP-A', 'DEP-B'] },
  ]);
  const result = classifyTask(siblings[2], '/tmp', 'proj', siblings);
  assert(result === null, 'should return null (DEP-B not done)');
});

// -------------------------------------------------------------------------
// classifyTask: parent_id enforcement
// -------------------------------------------------------------------------
console.log('\n--- classifyTask: parent_id ---');

test('skips child whose parent epic is blocked', () => {
  const siblings = makeSiblings([
    { id: 'EPIC-1', type: 'epic', status: 'blocked' },
    { id: 'CHILD-1', parent_id: 'EPIC-1' },
  ]);
  const origWrite = process.stderr.write;
  let stderrOut = '';
  process.stderr.write = (s) => { stderrOut += s; };
  const result = classifyTask(siblings[1], '/tmp', 'proj', siblings);
  process.stderr.write = origWrite;

  assert(result === null, 'should return null');
  assert(stderrOut.includes('skipped_parent_blocked'), 'should emit parent_blocked warning');
  assert(stderrOut.includes('EPIC-1'), 'warning should mention parent');
});

test('allows child whose parent epic is not blocked', () => {
  const siblings = makeSiblings([
    { id: 'EPIC-2', type: 'epic', status: 'todo' },
    { id: 'CHILD-2', parent_id: 'EPIC-2' },
  ]);
  const result = classifyTask(siblings[1], '/tmp', 'proj', siblings);
  assert(result !== null, 'should not be null');
});

test('allows child whose parent epic is done', () => {
  const siblings = makeSiblings([
    { id: 'EPIC-3', type: 'epic', status: 'done' },
    { id: 'CHILD-3', parent_id: 'EPIC-3' },
  ]);
  const result = classifyTask(siblings[1], '/tmp', 'proj', siblings);
  assert(result !== null, 'should not be null');
});

test('allows item with null parent_id', () => {
  const siblings = makeSiblings([
    { id: 'T-NP', parent_id: null },
  ]);
  const result = classifyTask(siblings[0], '/tmp', 'proj', siblings);
  assert(result !== null, 'should not be null');
});

test('allows child when parent does not exist in backlog (dangling)', () => {
  const siblings = makeSiblings([
    { id: 'CHILD-D', parent_id: 'NONEXIST' },
  ]);
  // Dangling parent_id should not block — validation tool catches this
  const result = classifyTask(siblings[0], '/tmp', 'proj', siblings);
  assert(result !== null, 'dangling parent should not block');
});

// -------------------------------------------------------------------------
// classifyTask: backward compat (no siblingItems)
// -------------------------------------------------------------------------
console.log('\n--- classifyTask: backward compat ---');

test('works without siblingItems parameter (skips graph checks)', () => {
  const entry = {
    id: 'T-BC', status: 'todo', owner_role: 'DEV',
    depends_on: ['SOME-DEP'], parent_id: 'SOME-EPIC',
    run_folder: null, blocked: false, stop_signal: false,
  };
  // No siblingItems → graph checks skipped, should classify normally
  const result = classifyTask(entry, '/tmp', 'proj');
  assert(result !== null, 'should classify without siblingItems');
  assert(result === 'needs_task_pack', `expected needs_task_pack, got ${result}`);
});

// -------------------------------------------------------------------------
// pickNextTask: integration with graph constraints
// -------------------------------------------------------------------------
console.log('\n--- pickNextTask: integration ---');

test('picker skips task with unsatisfied deps, picks eligible one', () => {
  const { wsRoot } = makeTempWorkspace('proj-dep', [
    { id: 'T-A', status: 'todo', priority: 'P0', depends_on: ['T-B'] },
    { id: 'T-B', status: 'todo', priority: 'P2' },
  ]);
  const result = pickNextTask({ workspaceRoot: wsRoot });
  assert(result.action === 'picked_task', 'should pick a task');
  assert(result.task_id === 'T-B', `should pick T-B (no deps), got ${result.task_id}`);
});

test('picker skips child of blocked epic, picks other', () => {
  const { wsRoot } = makeTempWorkspace('proj-epic', [
    { id: 'EPIC-P', type: 'epic', status: 'blocked', priority: 'P0' },
    { id: 'CHILD-P', parent_id: 'EPIC-P', priority: 'P0' },
    { id: 'T-FREE', priority: 'P2' },
  ]);
  const result = pickNextTask({ workspaceRoot: wsRoot });
  assert(result.action === 'picked_task', 'should pick a task');
  assert(result.task_id === 'T-FREE', `should pick T-FREE, got ${result.task_id}`);
});

test('picker returns no_eligible when all tasks have unsatisfied deps', () => {
  const { wsRoot } = makeTempWorkspace('proj-all-dep', [
    { id: 'T-X', depends_on: ['T-Y'] },
    { id: 'T-Y', depends_on: ['T-X'] },
  ]);
  const result = pickNextTask({ workspaceRoot: wsRoot });
  assert(result.action === 'no_eligible_tasks', `should have no eligible, got ${result.action}`);
});

test('picker picks task once dep is done', () => {
  const { wsRoot } = makeTempWorkspace('proj-dep-done', [
    { id: 'T-DONE', status: 'done' },
    { id: 'T-READY', depends_on: ['T-DONE'] },
  ]);
  const result = pickNextTask({ workspaceRoot: wsRoot });
  assert(result.action === 'picked_task', 'should pick a task');
  assert(result.task_id === 'T-READY', `should pick T-READY, got ${result.task_id}`);
});

test('picker respects both deps and parent constraints together', () => {
  const { wsRoot } = makeTempWorkspace('proj-combo', [
    { id: 'EPIC-C', type: 'epic', status: 'blocked' },
    { id: 'T-1', parent_id: 'EPIC-C', priority: 'P0' },
    { id: 'T-2', depends_on: ['T-3'], priority: 'P0' },
    { id: 'T-3', status: 'todo', priority: 'P1' },
    { id: 'T-4', status: 'todo', priority: 'P2' },
  ]);
  const result = pickNextTask({ workspaceRoot: wsRoot });
  assert(result.action === 'picked_task', 'should pick a task');
  // T-1 blocked by parent, T-2 blocked by dep T-3 (not done), T-3 and T-4 eligible
  assert(result.task_id === 'T-3', `should pick T-3 (P1, eligible), got ${result.task_id}`);
});

// -------------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------------
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
