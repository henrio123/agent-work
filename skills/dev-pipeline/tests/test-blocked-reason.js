#!/usr/bin/env node
'use strict';

/**
 * P2-05: Tests for blocked reason enforcement — dependency identification
 * in validator warnings and picker skip reasons.
 * Run: node skills/dev-pipeline/tests/test-blocked-reason.js
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const GRAPH_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'validate-backlog-graph.js');
const PICK_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'project-next-pick.js');

const { validateBacklogGraph } = require(GRAPH_SCRIPT);
const { classifyTask } = require(PICK_SCRIPT);

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
  const wsRoot = path.join(os.tmpdir(), `_test_blocked_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
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

function makeSiblings(items) {
  return items.map(item => ({
    id: item.id, type: item.type || 'task', status: item.status || 'todo',
    priority: item.priority || 'P2', owner_role: item.owner_role || 'DEV',
    parent_id: item.parent_id || null, depends_on: item.depends_on || [],
    run_folder: item.run_folder || null, stop_signal: false,
    blocked: item.status === 'blocked' || item.blocked || false,
    stalled: false, last_summary: null,
  }));
}

function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
process.on('exit', cleanup);

// -------------------------------------------------------------------------
// Graph validator: dependency satisfaction warnings
// -------------------------------------------------------------------------
console.log('\n--- validator: dependency satisfaction warnings ---');

test('warns for todo task with unfinished dependency', () => {
  const { wsRoot } = makeTempWorkspace('proj-w1', [
    { id: 'DEP-1', status: 'todo' },
    { id: 'T-1', depends_on: ['DEP-1'] },
  ]);
  const result = validateBacklogGraph('proj-w1', { workspaceRoot: wsRoot });
  assert(result.valid === true, 'should still be valid (warnings only)');
  const depWarnings = result.warnings.filter(w => w.includes('unfinished dependencies'));
  assert(depWarnings.length === 1, `expected 1 dep warning, got ${depWarnings.length}`);
  assert(depWarnings[0].includes('T-1'), 'warning should mention T-1');
  assert(depWarnings[0].includes('DEP-1'), 'warning should mention blocking dep DEP-1');
});

test('warns for in_progress task with unfinished dependency', () => {
  const { wsRoot } = makeTempWorkspace('proj-w2', [
    { id: 'DEP-2', status: 'in_progress' },
    { id: 'T-2', status: 'in_progress', depends_on: ['DEP-2'] },
  ]);
  const result = validateBacklogGraph('proj-w2', { workspaceRoot: wsRoot });
  const depWarnings = result.warnings.filter(w => w.includes('unfinished dependencies'));
  assert(depWarnings.length === 1, `expected 1 dep warning, got ${depWarnings.length}`);
  assert(depWarnings[0].includes('DEP-2'), 'should mention blocking dep');
});

test('no warning when dependency is done', () => {
  const { wsRoot } = makeTempWorkspace('proj-w3', [
    { id: 'DEP-3', status: 'done' },
    { id: 'T-3', depends_on: ['DEP-3'] },
  ]);
  const result = validateBacklogGraph('proj-w3', { workspaceRoot: wsRoot });
  const depWarnings = result.warnings.filter(w => w.includes('unfinished dependencies'));
  assert(depWarnings.length === 0, 'no dependency warning when dep is done');
});

test('no warning for done task with unfinished dep', () => {
  const { wsRoot } = makeTempWorkspace('proj-w4', [
    { id: 'DEP-4', status: 'todo' },
    { id: 'T-4', status: 'done', depends_on: ['DEP-4'] },
  ]);
  const result = validateBacklogGraph('proj-w4', { workspaceRoot: wsRoot });
  const depWarnings = result.warnings.filter(w => w.includes('unfinished dependencies'));
  assert(depWarnings.length === 0, 'no warning for done task');
});

test('warns with multiple blocking deps listed', () => {
  const { wsRoot } = makeTempWorkspace('proj-w5', [
    { id: 'D-A', status: 'todo' },
    { id: 'D-B', status: 'in_progress' },
    { id: 'D-C', status: 'done' },
    { id: 'T-5', depends_on: ['D-A', 'D-B', 'D-C'] },
  ]);
  const result = validateBacklogGraph('proj-w5', { workspaceRoot: wsRoot });
  const depWarnings = result.warnings.filter(w => w.includes('unfinished dependencies'));
  assert(depWarnings.length === 1, `expected 1 warning, got ${depWarnings.length}`);
  assert(depWarnings[0].includes('D-A'), 'should mention D-A');
  assert(depWarnings[0].includes('D-B'), 'should mention D-B');
  assert(!depWarnings[0].includes('D-C'), 'should not mention D-C (done)');
});

// -------------------------------------------------------------------------
// Picker: skip warnings include blocking dep IDs
// -------------------------------------------------------------------------
console.log('\n--- picker: skip warnings with blocking dep IDs ---');

test('picker skip warning includes blocking_deps array', () => {
  const siblings = makeSiblings([
    { id: 'DEP-X', status: 'todo' },
    { id: 'DEP-Y', status: 'in_progress' },
    { id: 'T-P', depends_on: ['DEP-X', 'DEP-Y'] },
  ]);

  const origWrite = process.stderr.write;
  let stderrOut = '';
  process.stderr.write = (s) => { stderrOut += s; };
  const result = classifyTask(siblings[2], '/tmp', 'proj', siblings);
  process.stderr.write = origWrite;

  assert(result === null, 'should skip');
  const warning = JSON.parse(stderrOut.trim());
  assert(warning.warning === 'skipped_unsatisfied_deps', `wrong warning type: ${warning.warning}`);
  assert(Array.isArray(warning.blocking_deps), 'should have blocking_deps array');
  assert(warning.blocking_deps.includes('DEP-X'), 'should include DEP-X');
  assert(warning.blocking_deps.includes('DEP-Y'), 'should include DEP-Y');
});

test('picker skip warning for parent_blocked includes parent_id', () => {
  const siblings = makeSiblings([
    { id: 'EPIC-B', type: 'epic', status: 'blocked' },
    { id: 'CHILD-B', parent_id: 'EPIC-B' },
  ]);

  const origWrite = process.stderr.write;
  let stderrOut = '';
  process.stderr.write = (s) => { stderrOut += s; };
  const result = classifyTask(siblings[1], '/tmp', 'proj', siblings);
  process.stderr.write = origWrite;

  assert(result === null, 'should skip');
  const warning = JSON.parse(stderrOut.trim());
  assert(warning.warning === 'skipped_parent_blocked', `wrong warning type: ${warning.warning}`);
  assert(warning.parent_id === 'EPIC-B', 'should include parent_id');
});

test('picker does not emit warning when deps are satisfied', () => {
  const siblings = makeSiblings([
    { id: 'DEP-OK', status: 'done' },
    { id: 'T-OK', depends_on: ['DEP-OK'] },
  ]);

  const origWrite = process.stderr.write;
  let stderrOut = '';
  process.stderr.write = (s) => { stderrOut += s; };
  classifyTask(siblings[1], '/tmp', 'proj', siblings);
  process.stderr.write = origWrite;

  assert(stderrOut === '', 'should not emit any warning');
});

// -------------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------------
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
