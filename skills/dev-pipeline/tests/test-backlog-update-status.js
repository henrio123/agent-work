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

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `_test_bus_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function makeProject(projectsDir, projectId, backlogItems = []) {
  const projectDir = path.join(projectsDir, projectId);
  const backlogDir = path.join(projectDir, 'backlog');
  fs.mkdirSync(backlogDir, { recursive: true });

  const project = {
    project_id: projectId,
    title: `Test project ${projectId}`,
    description: `Description for ${projectId}`,
    repo_path: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
  fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify(project, null, 2), 'utf8');

  for (const item of backlogItems) {
    const defaults = {
      project_id: projectId,
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
}

function readItem(projectsDir, projectId, itemId) {
  const filePath = path.join(projectsDir, projectId, 'backlog', `${itemId}.json`);
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
  const projectsDir = makeTempDir();
  makeProject(projectsDir, 'proj-guard', [
    { id: 'EPIC-1', type: 'epic', status: 'in_progress' },
    { id: 'CHILD-1', parent_id: 'EPIC-1', status: 'todo' },
    { id: 'CHILD-2', parent_id: 'EPIC-1', status: 'done' },
  ]);

  const result = updateBacklogStatus('proj-guard', 'EPIC-1', 'done', { projectsDir });
  assert(result.ok === false, 'expected ok: false');
  assert(result.error.includes('Cannot mark epic'), `unexpected error: ${result.error}`);
  assert(result.incomplete_children.length === 1, 'expected 1 incomplete child');
  assert(result.incomplete_children[0].id === 'CHILD-1', 'expected CHILD-1');

  // Verify the file was NOT modified
  const item = readItem(projectsDir, 'proj-guard', 'EPIC-1');
  assert(item.status === 'in_progress', 'status should remain in_progress');
});

test('epic done blocked when multiple children not done', () => {
  const projectsDir = makeTempDir();
  makeProject(projectsDir, 'proj-guard2', [
    { id: 'E-1', type: 'epic', status: 'in_progress' },
    { id: 'C-1', parent_id: 'E-1', status: 'in_progress' },
    { id: 'C-2', parent_id: 'E-1', status: 'blocked' },
    { id: 'C-3', parent_id: 'E-1', status: 'done' },
  ]);

  const result = updateBacklogStatus('proj-guard2', 'E-1', 'done', { projectsDir });
  assert(result.ok === false, 'expected ok: false');
  assert(result.incomplete_children.length === 2, 'expected 2 incomplete children');
});

test('epic done allowed when all children are done', () => {
  const projectsDir = makeTempDir();
  makeProject(projectsDir, 'proj-ok', [
    { id: 'EPIC-2', type: 'epic', status: 'in_progress' },
    { id: 'CHILD-A', parent_id: 'EPIC-2', status: 'done' },
    { id: 'CHILD-B', parent_id: 'EPIC-2', status: 'done' },
  ]);

  const result = updateBacklogStatus('proj-ok', 'EPIC-2', 'done', { projectsDir });
  assert(result.ok === true, `expected ok: true, got error: ${result.error}`);
  assert(result.new_status === 'done', 'expected new_status: done');

  const item = readItem(projectsDir, 'proj-ok', 'EPIC-2');
  assert(item.status === 'done', 'status should be done on disk');
});

test('epic done allowed when epic has no children', () => {
  const projectsDir = makeTempDir();
  makeProject(projectsDir, 'proj-no-kids', [
    { id: 'EPIC-SOLO', type: 'epic', status: 'in_progress' },
  ]);

  const result = updateBacklogStatus('proj-no-kids', 'EPIC-SOLO', 'done', { projectsDir });
  assert(result.ok === true, 'expected ok: true');
  assert(result.new_status === 'done', 'expected done');
});

// ---------------------------------------------------------------
// Non-epic transitions unaffected
// ---------------------------------------------------------------
console.log('\n--- non-epic transitions ---');

test('task can be marked done without guard', () => {
  const projectsDir = makeTempDir();
  makeProject(projectsDir, 'proj-task', [
    { id: 'TASK-1', type: 'task', status: 'in_progress' },
  ]);

  const result = updateBacklogStatus('proj-task', 'TASK-1', 'done', { projectsDir });
  assert(result.ok === true, 'expected ok: true');
  assert(result.old_status === 'in_progress', 'expected old_status: in_progress');
  assert(result.new_status === 'done', 'expected new_status: done');
});

test('task status transitions from todo to blocked', () => {
  const projectsDir = makeTempDir();
  makeProject(projectsDir, 'proj-block', [
    { id: 'TASK-B', type: 'task', status: 'todo' },
  ]);

  const result = updateBacklogStatus('proj-block', 'TASK-B', 'blocked', { projectsDir });
  assert(result.ok === true, 'expected ok: true');
  assert(result.new_status === 'blocked', 'expected blocked');
});

test('dev type can be marked done', () => {
  const projectsDir = makeTempDir();
  makeProject(projectsDir, 'proj-dev', [
    { id: 'DEV-1', type: 'dev', status: 'in_progress' },
  ]);

  const result = updateBacklogStatus('proj-dev', 'DEV-1', 'done', { projectsDir });
  assert(result.ok === true, 'expected ok: true');
});

// ---------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------
console.log('\n--- error cases ---');

test('invalid status returns error', () => {
  const projectsDir = makeTempDir();
  makeProject(projectsDir, 'proj-err', [
    { id: 'T-ERR', status: 'todo' },
  ]);

  const result = updateBacklogStatus('proj-err', 'T-ERR', 'invalid', { projectsDir });
  assert(result.ok === false, 'expected ok: false');
  assert(result.error.includes('Invalid status'), 'expected invalid status error');
});

test('non-existent project returns error', () => {
  const projectsDir = makeTempDir();
  const result = updateBacklogStatus('no-proj', 'T-1', 'done', { projectsDir });
  assert(result.ok === false, 'expected ok: false');
});

test('non-existent item returns error', () => {
  const projectsDir = makeTempDir();
  makeProject(projectsDir, 'proj-miss', [
    { id: 'T-EXISTS', status: 'todo' },
  ]);

  const result = updateBacklogStatus('proj-miss', 'T-MISSING', 'done', { projectsDir });
  assert(result.ok === false, 'expected ok: false');
  assert(result.error.includes('not found'), 'expected not found error');
});

test('updated_at is refreshed on transition', () => {
  const projectsDir = makeTempDir();
  makeProject(projectsDir, 'proj-ts', [
    { id: 'T-TS', status: 'todo' },
  ]);

  const before = readItem(projectsDir, 'proj-ts', 'T-TS').updated_at;
  updateBacklogStatus('proj-ts', 'T-TS', 'in_progress', { projectsDir });
  const after = readItem(projectsDir, 'proj-ts', 'T-TS').updated_at;
  assert(after !== before, 'expected updated_at to change');
});

// ---------------------------------------------------------------
// Summary
// ---------------------------------------------------------------
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
