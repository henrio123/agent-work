#!/usr/bin/env node
'use strict';

/**
 * P2-06: Tests for dashboard dependency chain visualization.
 * Run: node skills/dev-pipeline/tests/test-dashboard-deps.js
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DASHBOARD_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'project-dashboard.js');
const { buildDashboard } = require(DASHBOARD_SCRIPT);
const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));

const outputSchema = JSON.parse(fs.readFileSync(
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

function makeTempWorkspace(projectId, backlogItems = []) {
  const wsRoot = path.join(os.tmpdir(), `_test_ddeps_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const clawRoot = path.join(wsRoot, '.claw');
  const backlogDir = path.join(clawRoot, 'backlog');
  fs.mkdirSync(backlogDir, { recursive: true });
  tmpDirs.push(wsRoot);

  fs.writeFileSync(path.join(clawRoot, 'project.json'), JSON.stringify({
    project_id: projectId,
    title: `Project ${projectId}`,
    description: 'test',
    repo_path: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }, null, 2), 'utf8');

  for (const item of backlogItems) {
    const defaults = {
      project_id: projectId, type: 'task', title: `Task ${item.id}`,
      description: '', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      status: 'todo', priority: 'P2', owner_role: 'DEV', depends_on: [],
      parent_id: null, run_folder: null, tags: [], artifacts_expected: [],
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

function findItem(result, itemId) {
  const proj = result.projects[0];
  return proj ? proj.backlog.find(b => b.id === itemId) : null;
}

// -------------------------------------------------------------------------
// children field
// -------------------------------------------------------------------------
console.log('\n--- children ---');

test('epic has children listed', () => {
  const { wsRoot } = makeTempWorkspace('proj-c', [
    { id: 'EPIC-1', type: 'epic' },
    { id: 'CHILD-1', parent_id: 'EPIC-1' },
    { id: 'CHILD-2', parent_id: 'EPIC-1' },
    { id: 'OTHER' },
  ]);
  const result = buildDashboard({ workspaceRoot: wsRoot });
  const epic = findItem(result, 'EPIC-1');
  assert(Array.isArray(epic.children), 'children should be array');
  assert(epic.children.length === 2, `expected 2 children, got ${epic.children.length}`);
  assert(epic.children.includes('CHILD-1'), 'should include CHILD-1');
  assert(epic.children.includes('CHILD-2'), 'should include CHILD-2');

  const other = findItem(result, 'OTHER');
  assert(other.children.length === 0, 'OTHER has no children');
});

// -------------------------------------------------------------------------
// depends_on_status field
// -------------------------------------------------------------------------
console.log('\n--- depends_on_status ---');

test('depends_on_status shows status of each dependency', () => {
  const { wsRoot } = makeTempWorkspace('proj-ds', [
    { id: 'DEP-A', status: 'done' },
    { id: 'DEP-B', status: 'todo' },
    { id: 'T-1', depends_on: ['DEP-A', 'DEP-B'] },
  ]);
  const result = buildDashboard({ workspaceRoot: wsRoot });
  const t1 = findItem(result, 'T-1');
  assert(Array.isArray(t1.depends_on_status), 'should be array');
  assert(t1.depends_on_status.length === 2, `expected 2, got ${t1.depends_on_status.length}`);

  const depA = t1.depends_on_status.find(d => d.id === 'DEP-A');
  assert(depA && depA.status === 'done', 'DEP-A should be done');

  const depB = t1.depends_on_status.find(d => d.id === 'DEP-B');
  assert(depB && depB.status === 'todo', 'DEP-B should be todo');
});

test('depends_on_status shows unknown for dangling dep', () => {
  const { wsRoot } = makeTempWorkspace('proj-dangle', [
    { id: 'T-D', depends_on: ['GHOST'] },
  ]);
  const result = buildDashboard({ workspaceRoot: wsRoot });
  const td = findItem(result, 'T-D');
  assert(td.depends_on_status.length === 1, 'should have 1 entry');
  assert(td.depends_on_status[0].status === 'unknown', `expected unknown, got ${td.depends_on_status[0].status}`);
});

test('empty depends_on_status for task with no deps', () => {
  const { wsRoot } = makeTempWorkspace('proj-nd', [
    { id: 'T-ND' },
  ]);
  const result = buildDashboard({ workspaceRoot: wsRoot });
  const t = findItem(result, 'T-ND');
  assert(t.depends_on_status.length === 0, 'should be empty');
});

// -------------------------------------------------------------------------
// blocked_by_deps field
// -------------------------------------------------------------------------
console.log('\n--- blocked_by_deps ---');

test('blocked_by_deps lists non-done dependencies', () => {
  const { wsRoot } = makeTempWorkspace('proj-bd', [
    { id: 'D-1', status: 'done' },
    { id: 'D-2', status: 'todo' },
    { id: 'D-3', status: 'in_progress' },
    { id: 'T-BD', depends_on: ['D-1', 'D-2', 'D-3'] },
  ]);
  const result = buildDashboard({ workspaceRoot: wsRoot });
  const t = findItem(result, 'T-BD');
  assert(t.blocked_by_deps.length === 2, `expected 2, got ${t.blocked_by_deps.length}`);
  assert(t.blocked_by_deps.includes('D-2'), 'should include D-2');
  assert(t.blocked_by_deps.includes('D-3'), 'should include D-3');
  assert(!t.blocked_by_deps.includes('D-1'), 'should not include D-1 (done)');
});

test('blocked_by_deps empty when all deps done', () => {
  const { wsRoot } = makeTempWorkspace('proj-bde', [
    { id: 'D-OK', status: 'done' },
    { id: 'T-OK', depends_on: ['D-OK'] },
  ]);
  const result = buildDashboard({ workspaceRoot: wsRoot });
  const t = findItem(result, 'T-OK');
  assert(t.blocked_by_deps.length === 0, 'should be empty');
});

test('blocked_by_deps excludes dangling deps', () => {
  const { wsRoot } = makeTempWorkspace('proj-bdg', [
    { id: 'T-G', depends_on: ['GHOST'] },
  ]);
  const result = buildDashboard({ workspaceRoot: wsRoot });
  const t = findItem(result, 'T-G');
  assert(t.blocked_by_deps.length === 0, 'dangling dep should not appear in blocked_by_deps');
});

// -------------------------------------------------------------------------
// is_blocked_by_parent field
// -------------------------------------------------------------------------
console.log('\n--- is_blocked_by_parent ---');

test('is_blocked_by_parent true when parent is blocked', () => {
  const { wsRoot } = makeTempWorkspace('proj-bp', [
    { id: 'EPIC-B', type: 'epic', status: 'blocked' },
    { id: 'CHILD-B', parent_id: 'EPIC-B' },
  ]);
  const result = buildDashboard({ workspaceRoot: wsRoot });
  const child = findItem(result, 'CHILD-B');
  assert(child.is_blocked_by_parent === true, 'should be true');
});

test('is_blocked_by_parent false when parent is not blocked', () => {
  const { wsRoot } = makeTempWorkspace('proj-bnp', [
    { id: 'EPIC-OK', type: 'epic', status: 'todo' },
    { id: 'CHILD-OK', parent_id: 'EPIC-OK' },
  ]);
  const result = buildDashboard({ workspaceRoot: wsRoot });
  const child = findItem(result, 'CHILD-OK');
  assert(child.is_blocked_by_parent === false, 'should be false');
});

test('is_blocked_by_parent false for item with no parent', () => {
  const { wsRoot } = makeTempWorkspace('proj-np', [
    { id: 'T-NP' },
  ]);
  const result = buildDashboard({ workspaceRoot: wsRoot });
  const t = findItem(result, 'T-NP');
  assert(t.is_blocked_by_parent === false, 'should be false');
});

// -------------------------------------------------------------------------
// Schema validation
// -------------------------------------------------------------------------
console.log('\n--- schema validation ---');

test('output with dependency chain fields validates against schema', () => {
  const { wsRoot } = makeTempWorkspace('proj-sv', [
    { id: 'EPIC-S', type: 'epic', status: 'todo' },
    { id: 'C-S1', parent_id: 'EPIC-S', depends_on: ['C-S2'] },
    { id: 'C-S2', parent_id: 'EPIC-S', status: 'done' },
  ]);
  const result = buildDashboard({ workspaceRoot: wsRoot });
  assert(result.ok === true, 'should be ok');
  const v = validateAgainstSchema(result, outputSchema);
  assert(v.ok, `schema validation failed: ${(v.details || []).join('; ')}`);
});

test('CLI output validates against updated schema', () => {
  const result = buildDashboard();
  assert(result.ok === true, 'should be ok');
  const v = validateAgainstSchema(result, outputSchema);
  assert(v.ok, `schema validation failed: ${(v.details || []).join('; ')}`);
});

// -------------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------------
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
