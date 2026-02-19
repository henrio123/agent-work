#!/usr/bin/env node
'use strict';

/**
 * P2-04: Tests for epic completion rule enforcement.
 * Run: node skills/dev-pipeline/tests/test-epic-completion.js
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'validate-backlog-graph.js');
const { validateBacklogGraph, checkEpicCompletion } = require(SCRIPT);

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

function makeTempProjectsDir() {
  const dir = path.join(os.tmpdir(), `_test_epic_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function makeProject(projectsDir, projectId, backlogItems = []) {
  const projectDir = path.join(projectsDir, projectId);
  fs.mkdirSync(projectDir, { recursive: true });

  fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify({
    project_id: projectId, title: `Project ${projectId}`, description: 'test',
    repo_path: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  }), 'utf8');

  if (backlogItems.length > 0) {
    const backlogDir = path.join(projectDir, 'backlog');
    fs.mkdirSync(backlogDir, { recursive: true });
    for (const item of backlogItems) {
      const defaults = {
        project_id: projectId,
        type: 'task',
        title: `Task ${item.id}`,
        description: '',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        status: 'todo',
        priority: 'P2',
        owner_role: 'DEV',
        depends_on: [],
        parent_id: null,
        run_folder: null,
        tags: [],
        artifacts_expected: [],
        ...item,
      };
      fs.writeFileSync(
        path.join(backlogDir, `${defaults.id}.json`),
        JSON.stringify(defaults, null, 2),
        'utf8'
      );
    }
  }
}

function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
process.on('exit', cleanup);

// -------------------------------------------------------------------------
// validateBacklogGraph: epic completion rule
// -------------------------------------------------------------------------
console.log('\n--- validateBacklogGraph: epic completion ---');

test('done epic with all done children is valid', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-ok', [
    { id: 'EPIC-1', type: 'epic', status: 'done' },
    { id: 'CHILD-1', parent_id: 'EPIC-1', status: 'done' },
    { id: 'CHILD-2', parent_id: 'EPIC-1', status: 'done' },
  ]);
  const result = validateBacklogGraph('proj-ok', { projectsDir });
  assert(result.valid === true, 'should be valid');
  assert(result.epic_completion_errors.length === 0, 'no epic completion errors');
});

test('done epic with non-done child is invalid', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-bad', [
    { id: 'EPIC-1', type: 'epic', status: 'done' },
    { id: 'CHILD-1', parent_id: 'EPIC-1', status: 'done' },
    { id: 'CHILD-2', parent_id: 'EPIC-1', status: 'todo' },
  ]);
  const result = validateBacklogGraph('proj-bad', { projectsDir });
  assert(result.valid === false, 'should be invalid');
  assert(result.epic_completion_errors.length === 1, `expected 1 error, got ${result.epic_completion_errors.length}`);
  assert(result.epic_completion_errors[0].includes('EPIC-1'), 'error should mention epic');
  assert(result.epic_completion_errors[0].includes('CHILD-2'), 'error should mention incomplete child');
});

test('done epic with in_progress child is invalid', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-ip', [
    { id: 'EPIC-2', type: 'epic', status: 'done' },
    { id: 'C-1', parent_id: 'EPIC-2', status: 'in_progress' },
  ]);
  const result = validateBacklogGraph('proj-ip', { projectsDir });
  assert(result.valid === false, 'should be invalid');
  assert(result.epic_completion_errors.length === 1, 'should have 1 error');
});

test('done epic with blocked child is invalid', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-blocked', [
    { id: 'EPIC-3', type: 'epic', status: 'done' },
    { id: 'C-B', parent_id: 'EPIC-3', status: 'blocked' },
  ]);
  const result = validateBacklogGraph('proj-blocked', { projectsDir });
  assert(result.valid === false, 'should be invalid');
  assert(result.epic_completion_errors.length === 1, 'should have 1 error');
});

test('non-done epic with non-done children is valid (no error)', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-nd', [
    { id: 'EPIC-4', type: 'epic', status: 'todo' },
    { id: 'C-ND', parent_id: 'EPIC-4', status: 'todo' },
  ]);
  const result = validateBacklogGraph('proj-nd', { projectsDir });
  assert(result.epic_completion_errors.length === 0, 'no epic completion errors for non-done epic');
});

test('done epic with no children is valid', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-nochildren', [
    { id: 'EPIC-5', type: 'epic', status: 'done' },
  ]);
  const result = validateBacklogGraph('proj-nochildren', { projectsDir });
  assert(result.valid === true, 'should be valid');
  assert(result.epic_completion_errors.length === 0, 'no errors');
});

test('multiple done epics with mixed children', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-multi', [
    { id: 'EP-A', type: 'epic', status: 'done' },
    { id: 'CA-1', parent_id: 'EP-A', status: 'done' },
    { id: 'EP-B', type: 'epic', status: 'done' },
    { id: 'CB-1', parent_id: 'EP-B', status: 'todo' },
    { id: 'CB-2', parent_id: 'EP-B', status: 'done' },
  ]);
  const result = validateBacklogGraph('proj-multi', { projectsDir });
  assert(result.valid === false, 'should be invalid');
  assert(result.epic_completion_errors.length === 1, `expected 1 error (EP-B), got ${result.epic_completion_errors.length}`);
  assert(result.epic_completion_errors[0].includes('EP-B'), 'should mention EP-B');
  assert(result.epic_completion_errors[0].includes('CB-1'), 'should mention CB-1');
});

test('epic_completion_errors in output schema', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-schema', [
    { id: 'EP-S', type: 'epic', status: 'done' },
    { id: 'CS-1', parent_id: 'EP-S', status: 'todo' },
  ]);
  const result = validateBacklogGraph('proj-schema', { projectsDir });
  assert(Array.isArray(result.epic_completion_errors), 'epic_completion_errors should be an array');
});

// -------------------------------------------------------------------------
// checkEpicCompletion: standalone function
// -------------------------------------------------------------------------
console.log('\n--- checkEpicCompletion ---');

test('returns can_complete: true when all children done', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-cec-ok', [
    { id: 'EP-1', type: 'epic', status: 'todo' },
    { id: 'C-1', parent_id: 'EP-1', status: 'done' },
    { id: 'C-2', parent_id: 'EP-1', status: 'done' },
  ]);
  const result = checkEpicCompletion('proj-cec-ok', 'EP-1', { projectsDir });
  assert(result.ok === true, 'should succeed');
  assert(result.can_complete === true, 'should be completable');
  assert(result.incomplete_children.length === 0, 'no incomplete children');
  assert(result.epic_id === 'EP-1', 'should return epic_id');
  assert(result.project_id === 'proj-cec-ok', 'should return project_id');
});

test('returns can_complete: false with incomplete children', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-cec-bad', [
    { id: 'EP-2', type: 'epic', status: 'todo' },
    { id: 'C-3', parent_id: 'EP-2', status: 'done' },
    { id: 'C-4', parent_id: 'EP-2', status: 'in_progress' },
    { id: 'C-5', parent_id: 'EP-2', status: 'todo' },
  ]);
  const result = checkEpicCompletion('proj-cec-bad', 'EP-2', { projectsDir });
  assert(result.ok === true, 'should succeed');
  assert(result.can_complete === false, 'should not be completable');
  assert(result.incomplete_children.length === 2, `expected 2 incomplete, got ${result.incomplete_children.length}`);
  const ids = result.incomplete_children.map(c => c.id).sort();
  assert(ids[0] === 'C-4' && ids[1] === 'C-5', `wrong incomplete ids: ${ids}`);
});

test('returns can_complete: true for epic with no children', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-cec-empty', [
    { id: 'EP-3', type: 'epic', status: 'todo' },
  ]);
  const result = checkEpicCompletion('proj-cec-empty', 'EP-3', { projectsDir });
  assert(result.ok === true, 'should succeed');
  assert(result.can_complete === true, 'epic with no children can complete');
});

test('returns ok: false for non-existent epic', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-cec-missing', [
    { id: 'OTHER', type: 'task', status: 'todo' },
  ]);
  const result = checkEpicCompletion('proj-cec-missing', 'GHOST', { projectsDir });
  assert(result.ok === false, 'should fail');
  assert(result.error.includes('GHOST'), 'error should mention epic id');
});

test('returns ok: false for non-existent project', () => {
  const projectsDir = makeTempProjectsDir();
  const result = checkEpicCompletion('proj-nope', 'EP-1', { projectsDir });
  assert(result.ok === false, 'should fail');
});

// -------------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------------
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
