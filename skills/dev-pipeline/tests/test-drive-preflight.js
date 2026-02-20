#!/usr/bin/env node
'use strict';

/**
 * H-03: Tests for preflight graph validation in project-next-drive.
 * Run: node skills/dev-pipeline/tests/test-drive-preflight.js
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { projectDriveOnce } = require(path.resolve(__dirname, '..', 'scripts', 'project-next-drive.js'));

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
  const wsRoot = path.join(os.tmpdir(), `_test_preflight_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const clawRoot = path.join(wsRoot, '.claw');
  const backlogDir = path.join(clawRoot, 'backlog');
  fs.mkdirSync(backlogDir, { recursive: true });
  fs.mkdirSync(path.join(clawRoot, 'runs'), { recursive: true });
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
      project_id: projectId,
      type: 'task',
      title: `Task ${item.id}`,
      description: 'Test task',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
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

function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
process.on('exit', cleanup);

// Capture stderr for warning verification
let capturedStderr = '';
const origStderrWrite = process.stderr.write.bind(process.stderr);
function captureStderr() {
  capturedStderr = '';
  process.stderr.write = (chunk) => {
    capturedStderr += chunk;
    return true;
  };
}
function restoreStderr() {
  process.stderr.write = origStderrWrite;
}

// ---------------------------------------------------------------
// Test: Invalid graph (cycle) causes skip
// ---------------------------------------------------------------
console.log('\n--- preflight: invalid graph ---');

test('drive_skipped when backlog has dependency cycle (with eligible task)', () => {
  // C is eligible (no deps), but A<->B form a cycle, so graph is invalid
  const { wsRoot } = makeTempWorkspace('proj-cycle', [
    { id: 'A', depends_on: ['B'] },
    { id: 'B', depends_on: ['A'] },
    { id: 'C', status: 'todo', priority: 'P0' },
  ]);

  captureStderr();
  try {
    const result = projectDriveOnce({ workspaceRoot: wsRoot, dryRun: true });
    restoreStderr();
    assert(result.ok === true, 'expected ok: true');
    assert(result.action === 'drive_skipped', `expected drive_skipped, got ${result.action}`);
    assert(result.graph_invalid === true, 'expected graph_invalid: true');
  } catch (e) {
    restoreStderr();
    throw e;
  }
});

test('stderr contains skipped_invalid_graph warning for cycle', () => {
  const { wsRoot } = makeTempWorkspace('proj-cycle2', [
    { id: 'X', depends_on: ['Y'] },
    { id: 'Y', depends_on: ['X'] },
    { id: 'Z', status: 'todo', priority: 'P0' },
  ]);

  captureStderr();
  try {
    projectDriveOnce({ workspaceRoot: wsRoot, dryRun: true });
    restoreStderr();
    const warning = JSON.parse(capturedStderr.split('\n').find(l => l.includes('skipped_invalid_graph')));
    assert(warning.warning === 'skipped_invalid_graph', 'expected warning key');
    assert(warning.project_id === 'proj-cycle2', 'expected project_id');
    assert(warning.cycles.length > 0, 'expected cycles');
  } catch (e) {
    restoreStderr();
    throw e;
  }
});

test('drive_skipped when epic is done but child is not', () => {
  const { wsRoot } = makeTempWorkspace('proj-epic-bad', [
    { id: 'EPIC-1', type: 'epic', status: 'done' },
    { id: 'CHILD-1', parent_id: 'EPIC-1', status: 'todo' },
  ]);

  captureStderr();
  try {
    const result = projectDriveOnce({ workspaceRoot: wsRoot, dryRun: true });
    restoreStderr();
    assert(result.ok === true, 'expected ok: true');
    assert(result.action === 'drive_skipped', `expected drive_skipped, got ${result.action}`);
    assert(result.graph_invalid === true, 'expected graph_invalid: true');
  } catch (e) {
    restoreStderr();
    throw e;
  }
});

test('drive_skipped when parent_id references non-epic', () => {
  const { wsRoot } = makeTempWorkspace('proj-parent-bad', [
    { id: 'TASK-A', type: 'task', status: 'todo' },
    { id: 'TASK-B', parent_id: 'TASK-A', status: 'todo' },
  ]);

  captureStderr();
  try {
    const result = projectDriveOnce({ workspaceRoot: wsRoot, dryRun: true });
    restoreStderr();
    assert(result.ok === true, 'expected ok: true');
    assert(result.action === 'drive_skipped', `expected drive_skipped, got ${result.action}`);
    assert(result.graph_invalid === true, 'expected graph_invalid');
  } catch (e) {
    restoreStderr();
    throw e;
  }
});

// ---------------------------------------------------------------
// Test: Valid graph proceeds normally
// ---------------------------------------------------------------
console.log('\n--- preflight: valid graph ---');

test('valid graph proceeds to drive (dry_run)', () => {
  const { wsRoot } = makeTempWorkspace('proj-valid', [
    { id: 'T-1', status: 'todo', priority: 'P0' },
    { id: 'T-2', status: 'todo', depends_on: ['T-1'] },
  ]);

  captureStderr();
  try {
    const result = projectDriveOnce({ workspaceRoot: wsRoot, dryRun: true });
    restoreStderr();
    assert(result.ok === true, 'expected ok: true');
    assert(result.action === 'drive_skipped', `expected drive_skipped (dry_run), got ${result.action}`);
    assert(!result.graph_invalid, 'should not have graph_invalid');
    assert(result.picked.task_id === 'T-1', `expected T-1, got ${result.picked.task_id}`);
  } catch (e) {
    restoreStderr();
    throw e;
  }
});

test('valid graph with no issues proceeds', () => {
  const { wsRoot } = makeTempWorkspace('proj-clean', [
    { id: 'SOLO', status: 'todo', priority: 'P1' },
  ]);

  captureStderr();
  try {
    const result = projectDriveOnce({ workspaceRoot: wsRoot, dryRun: true });
    restoreStderr();
    assert(result.ok === true, 'expected ok');
    assert(!result.graph_invalid, 'should not have graph_invalid');
  } catch (e) {
    restoreStderr();
    throw e;
  }
});

// ---------------------------------------------------------------
// Summary
// ---------------------------------------------------------------
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
