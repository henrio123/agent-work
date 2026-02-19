#!/usr/bin/env node
'use strict';

/**
 * Tests for owner_role enforcement in project-next-pick.js.
 * Run: node skills/dev-pipeline/tests/test-picker-owner-role.js
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

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

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `_test_por_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function makeProject(projectsDir, projectId, backlogItems = []) {
  const projectDir = path.join(projectsDir, projectId);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify({
    project_id: projectId, title: `Test ${projectId}`, description: '',
    repo_path: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  }, null, 2), 'utf8');

  if (backlogItems.length > 0) {
    const backlogDir = path.join(projectDir, 'backlog');
    fs.mkdirSync(backlogDir, { recursive: true });
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
  }
  return projectDir;
}

function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}
process.on('exit', cleanup);

// ---------------------------------------------------------------------------
console.log('\n--- classifyTask ---');
// ---------------------------------------------------------------------------

test('classifyTask returns null for missing owner_role', () => {
  const wsRoot = makeTempDir();
  const result = classifyTask({ id: 'T-1', status: 'todo' }, wsRoot, 'proj');
  assert(result === null, `expected null, got ${result}`);
});

test('classifyTask returns null for empty string owner_role', () => {
  const wsRoot = makeTempDir();
  const result = classifyTask({ id: 'T-2', status: 'todo', owner_role: '' }, wsRoot, 'proj');
  assert(result === null, `expected null, got ${result}`);
});

test('classifyTask returns null for whitespace-only owner_role', () => {
  const wsRoot = makeTempDir();
  const result = classifyTask({ id: 'T-3', status: 'todo', owner_role: '   ' }, wsRoot, 'proj');
  assert(result === null, `expected null, got ${result}`);
});

test('classifyTask does not skip item with valid owner_role', () => {
  const wsRoot = makeTempDir();
  const result = classifyTask({ id: 'T-4', status: 'todo', owner_role: 'PM' }, wsRoot, 'proj');
  assert(result !== null, 'should not be null');
  assert(result === 'needs_task_pack', `expected needs_task_pack, got ${result}`);
});

// ---------------------------------------------------------------------------
console.log('\n--- pickNextTask ---');
// ---------------------------------------------------------------------------

test('picker skips items without owner_role', () => {
  const projectsDir = makeTempDir();
  makeProject(projectsDir, 'proj-skip', [
    { id: 'T-NO-ROLE', status: 'todo', owner_role: undefined },
  ]);
  // Remove owner_role from JSON to simulate missing field
  const bp = path.join(projectsDir, 'proj-skip', 'backlog', 'T-NO-ROLE.json');
  const data = JSON.parse(fs.readFileSync(bp, 'utf8'));
  delete data.owner_role;
  fs.writeFileSync(bp, JSON.stringify(data, null, 2), 'utf8');

  const result = pickNextTask({ projectsDir });
  assert(result.ok === true, 'should be ok');
  assert(result.action === 'no_eligible_tasks', `expected no_eligible_tasks, got ${result.action}`);
});

test('picker picks best candidate when some items lack owner_role', () => {
  const projectsDir = makeTempDir();
  makeProject(projectsDir, 'proj-mix', [
    { id: 'T-BAD', status: 'todo', owner_role: '' },
    { id: 'T-GOOD', status: 'todo', owner_role: 'Dev' },
  ]);

  const result = pickNextTask({ projectsDir });
  assert(result.ok === true, 'should be ok');
  assert(result.action === 'picked_task', `expected picked_task, got ${result.action}`);
  assert(result.task_id === 'T-GOOD', `expected T-GOOD, got ${result.task_id}`);
});

test('no_eligible_tasks when all items lack owner_role', () => {
  const projectsDir = makeTempDir();
  makeProject(projectsDir, 'proj-all-bad', [
    { id: 'T-BAD1', status: 'todo', owner_role: '' },
    { id: 'T-BAD2', status: 'todo', owner_role: '  ' },
  ]);

  const result = pickNextTask({ projectsDir });
  assert(result.ok === true, 'should be ok');
  assert(result.action === 'no_eligible_tasks', `expected no_eligible_tasks, got ${result.action}`);
});

// ---------------------------------------------------------------------------
console.log('\n--- CLI stderr warning ---');
// ---------------------------------------------------------------------------

test('picker emits stderr warning for skipped item', () => {
  const projectsDir = makeTempDir();
  makeProject(projectsDir, 'proj-warn', [
    { id: 'T-WARN', status: 'todo', owner_role: '' },
    { id: 'T-OK', status: 'todo', owner_role: 'PM' },
  ]);

  let stderr = '';
  try {
    execFileSync('node', [PICK_SCRIPT], {
      encoding: 'utf8', stdio: 'pipe',
      env: { ...process.env, _TEST_PROJECTS_DIR: projectsDir },
    });
  } catch (e) {
    stderr = e.stderr || '';
  }

  // The CLI uses default projectsDir (real workspace), so run via programmatic test instead
  // and capture stderr from the classifyTask call
  const wsRoot = makeTempDir();
  const origWrite = process.stderr.write;
  let captured = '';
  process.stderr.write = (chunk) => { captured += chunk; };
  try {
    classifyTask({ id: 'T-WARN-TEST', status: 'todo', owner_role: '' }, wsRoot, 'proj-warn');
  } finally {
    process.stderr.write = origWrite;
  }

  assert(captured.includes('skipped_no_owner_role'), `stderr should contain warning, got: ${captured}`);
  assert(captured.includes('T-WARN-TEST'), `stderr should contain task_id, got: ${captured}`);
  assert(captured.includes('proj-warn'), `stderr should contain project_id, got: ${captured}`);

  const parsed = JSON.parse(captured.trim());
  assert(parsed.warning === 'skipped_no_owner_role', 'warning field mismatch');
  assert(parsed.task_id === 'T-WARN-TEST', 'task_id mismatch');
  assert(parsed.project_id === 'proj-warn', 'project_id mismatch');
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
cleanup();

console.log(`\n========================================`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`========================================`);

process.exit(failed > 0 ? 1 : 0);
