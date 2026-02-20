#!/usr/bin/env node
'use strict';

/**
 * OPS-01: Tests for backlog-update-status.js — write-time epic completion guard.
 * Run: node skills/dev-pipeline/tests/test-backlog-update-status.js
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { updateBacklogStatus } = require(path.resolve(__dirname, '..', 'scripts', 'backlog-update-status.js'));

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

function makeTempWorkspace(backlogItems = []) {
  const wsRoot = path.join(os.tmpdir(), `_test_bus_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const backlogDir = path.join(wsRoot, '.claw', 'backlog');
  fs.mkdirSync(backlogDir, { recursive: true });
  tmpDirs.push(wsRoot);

  // Write project.json at .claw/project.json
  fs.writeFileSync(path.join(wsRoot, '.claw', 'project.json'), JSON.stringify({
    project_id: 'test',
    title: 'Test project',
    description: 'Test project description',
    repo_path: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }, null, 2), 'utf8');

  for (const item of backlogItems) {
    const defaults = {
      project_id: 'test',
      type: 'task',
      title: `Task ${item.id}`,
      description: 'Test task',
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
      parent_id: null,
      phase: 'Test',
      stop_condition: 'Test',
      ...item,
    };
    fs.writeFileSync(
      path.join(backlogDir, `${defaults.id}.json`),
      JSON.stringify(defaults, null, 2),
      'utf8'
    );
  }

  return { wsRoot, backlogDir };
}

function readItem(backlogDir, itemId) {
  const filePath = path.join(backlogDir, `${itemId}.json`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
process.on('exit', cleanup);

// ---------------------------------------------------------------
// Epic completion guard
// ---------------------------------------------------------------
console.log('\n--- epic completion guard ---');

test('epic done blocked when a child is not done', () => {
  const { backlogDir } = makeTempWorkspace([
    { id: 'EPIC-1', type: 'epic', status: 'in_progress' },
    { id: 'CHILD-1', parent_id: 'EPIC-1', status: 'todo' },
    { id: 'CHILD-2', parent_id: 'EPIC-1', status: 'done' },
  ]);

  const result = updateBacklogStatus('test', 'EPIC-1', 'done', { backlogDir });
  assert(result.ok === false, 'expected ok: false');
  assert(result.error.includes('Cannot mark epic'), `unexpected error: ${result.error}`);
  assert(result.incomplete_children.length === 1, 'expected 1 incomplete child');
  assert(result.incomplete_children[0].id === 'CHILD-1', 'expected CHILD-1');

  // Verify the file was NOT modified
  const item = readItem(backlogDir, 'EPIC-1');
  assert(item.status === 'in_progress', 'status should remain in_progress');
});

test('epic done blocked when multiple children not done', () => {
  const { backlogDir } = makeTempWorkspace([
    { id: 'E-1', type: 'epic', status: 'in_progress' },
    { id: 'C-1', parent_id: 'E-1', status: 'in_progress' },
    { id: 'C-2', parent_id: 'E-1', status: 'blocked' },
    { id: 'C-3', parent_id: 'E-1', status: 'done' },
  ]);

  const result = updateBacklogStatus('test', 'E-1', 'done', { backlogDir });
  assert(result.ok === false, 'expected ok: false');
  assert(result.incomplete_children.length === 2, 'expected 2 incomplete children');
});

test('epic done allowed when all children are done', () => {
  const { backlogDir } = makeTempWorkspace([
    { id: 'EPIC-2', type: 'epic', status: 'in_progress' },
    { id: 'CHILD-A', parent_id: 'EPIC-2', status: 'done' },
    { id: 'CHILD-B', parent_id: 'EPIC-2', status: 'done' },
  ]);

  const result = updateBacklogStatus('test', 'EPIC-2', 'done', { backlogDir });
  assert(result.ok === true, `expected ok: true, got error: ${result.error}`);
  assert(result.new_status === 'done', 'expected new_status: done');

  const item = readItem(backlogDir, 'EPIC-2');
  assert(item.status === 'done', 'status should be done on disk');
});

test('epic done allowed when epic has no children', () => {
  const { backlogDir } = makeTempWorkspace([
    { id: 'EPIC-SOLO', type: 'epic', status: 'in_progress' },
  ]);

  const result = updateBacklogStatus('test', 'EPIC-SOLO', 'done', { backlogDir });
  assert(result.ok === true, 'expected ok: true');
  assert(result.new_status === 'done', 'expected done');
});

// ---------------------------------------------------------------
// Non-epic transitions unaffected
// ---------------------------------------------------------------
console.log('\n--- non-epic transitions ---');

test('task can be marked done without guard', () => {
  const { backlogDir } = makeTempWorkspace([
    { id: 'TASK-1', type: 'task', status: 'in_progress' },
  ]);

  const result = updateBacklogStatus('test', 'TASK-1', 'done', { backlogDir });
  assert(result.ok === true, 'expected ok: true');
  assert(result.old_status === 'in_progress', 'expected old_status: in_progress');
  assert(result.new_status === 'done', 'expected new_status: done');
});

test('task status transitions from todo to blocked', () => {
  const { backlogDir } = makeTempWorkspace([
    { id: 'TASK-B', type: 'task', status: 'todo' },
  ]);

  const result = updateBacklogStatus('test', 'TASK-B', 'blocked', { backlogDir });
  assert(result.ok === true, 'expected ok: true');
  assert(result.new_status === 'blocked', 'expected blocked');
});

test('dev type can be marked done', () => {
  const { backlogDir } = makeTempWorkspace([
    { id: 'DEV-1', type: 'dev', status: 'in_progress' },
  ]);

  const result = updateBacklogStatus('test', 'DEV-1', 'done', { backlogDir });
  assert(result.ok === true, 'expected ok: true');
});

// ---------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------
console.log('\n--- error cases ---');

test('invalid status returns error', () => {
  const { backlogDir } = makeTempWorkspace([
    { id: 'T-ERR', status: 'todo' },
  ]);

  const result = updateBacklogStatus('test', 'T-ERR', 'invalid', { backlogDir });
  assert(result.ok === false, 'expected ok: false');
  assert(result.error.includes('Invalid status'), 'expected invalid status error');
});

test('non-existent project returns error', () => {
  const wsRoot = path.join(os.tmpdir(), `_test_bus_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const backlogDir = path.join(wsRoot, '.claw', 'backlog');
  // Do NOT create the directory — simulates non-existent project
  tmpDirs.push(wsRoot);

  const result = updateBacklogStatus('no-proj', 'T-1', 'done', { backlogDir });
  assert(result.ok === false, 'expected ok: false');
});

test('non-existent item returns error', () => {
  const { backlogDir } = makeTempWorkspace([
    { id: 'T-EXISTS', status: 'todo' },
  ]);

  const result = updateBacklogStatus('test', 'T-MISSING', 'done', { backlogDir });
  assert(result.ok === false, 'expected ok: false');
  assert(result.error.includes('not found'), 'expected not found error');
});

test('updated_at is refreshed on transition', () => {
  const { backlogDir } = makeTempWorkspace([
    { id: 'T-TS', status: 'todo' },
  ]);

  const before = readItem(backlogDir, 'T-TS').updated_at;
  updateBacklogStatus('test', 'T-TS', 'in_progress', { backlogDir });
  const after = readItem(backlogDir, 'T-TS').updated_at;
  assert(after !== before, 'expected updated_at to change');
});

// ---------------------------------------------------------------
// Summary
// ---------------------------------------------------------------
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
