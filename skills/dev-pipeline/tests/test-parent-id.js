#!/usr/bin/env node
'use strict';

/**
 * P2-01: Tests for parent_id field in backlog item data model.
 * Run: node skills/dev-pipeline/tests/test-parent-id.js
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = path.resolve(os.homedir(), 'dev', 'agent-work');

const { buildProjectIndex } = require(path.resolve(__dirname, '..', 'scripts', 'project-index.js'));
const { buildDashboard } = require(path.resolve(__dirname, '..', 'scripts', 'project-dashboard.js'));
const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));

const indexSchema = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'project-index.output.schema.json'), 'utf8'));
const dashboardSchema = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'project-dashboard.output.schema.json'), 'utf8'));

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
  const dir = path.join(os.tmpdir(), `_test_parent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function makeProject(projectsDir, projectId, backlogItems = []) {
  const projectDir = path.join(projectsDir, projectId);
  fs.mkdirSync(projectDir, { recursive: true });

  const project = {
    project_id: projectId,
    title: `Test project ${projectId}`,
    description: `Description for ${projectId}`,
    repo_path: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
  fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify(project, null, 2), 'utf8');

  if (backlogItems.length > 0) {
    const backlogDir = path.join(projectDir, 'backlog');
    fs.mkdirSync(backlogDir, { recursive: true });
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
        path.join(backlogDir, `${defaults.id}.json`),
        JSON.stringify(defaults, null, 2),
        'utf8'
      );
    }
  }

  return projectDir;
}

function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
process.on('exit', cleanup);

// -------------------------------------------------------------------------
// project-index: parent_id passthrough
// -------------------------------------------------------------------------
console.log('\n--- project-index: parent_id ---');

test('item with parent_id set appears in project-index output', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-pi', [
    { id: 'EPIC-1', type: 'epic', parent_id: null },
    { id: 'CHILD-1', parent_id: 'EPIC-1' },
  ]);
  const result = buildProjectIndex({ projectsDir });
  assert(result.ok === true, 'should succeed');
  const proj = result.projects.find(p => p.project_id === 'proj-pi');
  const child = proj.backlog.find(b => b.id === 'CHILD-1');
  assert(child.parent_id === 'EPIC-1', `parent_id should be EPIC-1, got: ${child.parent_id}`);
});

test('item without parent_id defaults to null in project-index', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-pi2', [
    { id: 'T-NOPARENT' },
  ]);
  const result = buildProjectIndex({ projectsDir });
  const proj = result.projects.find(p => p.project_id === 'proj-pi2');
  const item = proj.backlog.find(b => b.id === 'T-NOPARENT');
  assert(item.parent_id === null, `parent_id should be null, got: ${item.parent_id}`);
});

test('epic with null parent_id appears correctly', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-pi3', [
    { id: 'EPIC-2', type: 'epic', parent_id: null },
  ]);
  const result = buildProjectIndex({ projectsDir });
  const proj = result.projects.find(p => p.project_id === 'proj-pi3');
  const epic = proj.backlog.find(b => b.id === 'EPIC-2');
  assert(epic.parent_id === null, 'epic parent_id should be null');
  assert(epic.type === 'epic', 'type should be epic');
});

// -------------------------------------------------------------------------
// project-dashboard: parent_id passthrough
// -------------------------------------------------------------------------
console.log('\n--- project-dashboard: parent_id ---');

test('item with parent_id set appears in project-dashboard output', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-pd', [
    { id: 'EPIC-D1', type: 'epic', parent_id: null },
    { id: 'CHILD-D1', parent_id: 'EPIC-D1' },
  ]);
  const result = buildDashboard({ projectsDir });
  assert(result.ok === true, 'should succeed');
  const proj = result.projects.find(p => p.project_id === 'proj-pd');
  const child = proj.backlog.find(b => b.id === 'CHILD-D1');
  assert(child.parent_id === 'EPIC-D1', `parent_id should be EPIC-D1, got: ${child.parent_id}`);
});

test('item without parent_id defaults to null in project-dashboard', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-pd2', [
    { id: 'T-NOPD' },
  ]);
  const result = buildDashboard({ projectsDir });
  const proj = result.projects.find(p => p.project_id === 'proj-pd2');
  const item = proj.backlog.find(b => b.id === 'T-NOPD');
  assert(item.parent_id === null, `parent_id should be null, got: ${item.parent_id}`);
});

// -------------------------------------------------------------------------
// Schema validation
// -------------------------------------------------------------------------
console.log('\n--- schema validation ---');

test('project-index output with parent_id validates against schema', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-sv1', [
    { id: 'EPIC-S1', type: 'epic', parent_id: null },
    { id: 'CHILD-S1', parent_id: 'EPIC-S1' },
    { id: 'T-SOLO' },
  ]);
  const result = buildProjectIndex({ projectsDir });
  const v = validateAgainstSchema(result, indexSchema);
  assert(v.ok, `schema validation failed: ${(v.details || []).join('; ')}`);
});

test('project-dashboard output with parent_id validates against schema', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-sv2', [
    { id: 'EPIC-S2', type: 'epic', parent_id: null },
    { id: 'CHILD-S2', parent_id: 'EPIC-S2' },
    { id: 'T-SOLO2' },
  ]);
  const result = buildDashboard({ projectsDir });
  const v = validateAgainstSchema(result, dashboardSchema);
  assert(v.ok, `schema validation failed: ${(v.details || []).join('; ')}`);
});

// -------------------------------------------------------------------------
// Backward compatibility
// -------------------------------------------------------------------------
console.log('\n--- backward compatibility ---');

test('existing backlog items without parent_id field work in project-index', () => {
  const projectsDir = makeTempProjectsDir();
  const projectDir = path.join(projectsDir, 'proj-bc');
  fs.mkdirSync(path.join(projectDir, 'backlog'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify({
    project_id: 'proj-bc', title: 'BC test', description: 'test',
    repo_path: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  }), 'utf8');
  // Write a backlog item that has NO parent_id key at all
  fs.writeFileSync(path.join(projectDir, 'backlog', 'T-OLD.json'), JSON.stringify({
    id: 'T-OLD', project_id: 'proj-bc', type: 'task', title: 'Old task',
    description: '', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    status: 'todo', priority: 'P2', owner_role: 'DEV', depends_on: [],
    run_folder: null, tags: [], artifacts_expected: [],
  }), 'utf8');

  const result = buildProjectIndex({ projectsDir });
  assert(result.ok === true, 'should succeed');
  const proj = result.projects.find(p => p.project_id === 'proj-bc');
  const item = proj.backlog.find(b => b.id === 'T-OLD');
  assert(item.parent_id === null, `parent_id should default to null, got: ${item.parent_id}`);
});

test('existing backlog items without parent_id field work in project-dashboard', () => {
  const projectsDir = makeTempProjectsDir();
  const projectDir = path.join(projectsDir, 'proj-bc2');
  fs.mkdirSync(path.join(projectDir, 'backlog'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify({
    project_id: 'proj-bc2', title: 'BC test 2', description: 'test',
    repo_path: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  }), 'utf8');
  fs.writeFileSync(path.join(projectDir, 'backlog', 'T-OLD2.json'), JSON.stringify({
    id: 'T-OLD2', project_id: 'proj-bc2', type: 'task', title: 'Old task 2',
    description: '', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    status: 'todo', priority: 'P2', owner_role: 'DEV', depends_on: [],
    run_folder: null, tags: [], artifacts_expected: [],
  }), 'utf8');

  const result = buildDashboard({ projectsDir });
  assert(result.ok === true, 'should succeed');
  const proj = result.projects.find(p => p.project_id === 'proj-bc2');
  const item = proj.backlog.find(b => b.id === 'T-OLD2');
  assert(item.parent_id === null, `parent_id should default to null, got: ${item.parent_id}`);
});

// -------------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------------
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
