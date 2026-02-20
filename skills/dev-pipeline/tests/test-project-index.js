#!/usr/bin/env node
'use strict';

/**
 * Tests for project-index.js — read-only global project index.
 * Run: node skills/dev-pipeline/tests/test-project-index.js
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
const INDEX_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'project-index.js');
const INDEX_SHELL = path.join(WORKSPACE_ROOT, 'tools', 'project-index.sh');

const { buildProjectIndex } = require(INDEX_SCRIPT);

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

function makeTempProjectsDir() {
  const dir = path.join(os.tmpdir(), `_test_proj_idx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
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
// Test 1: Basic output
// -------------------------------------------------------------------------
console.log('\n--- basic output ---');

test('returns ok:true with projects array and summary (empty)', () => {
  const projectsDir = makeTempProjectsDir();
  const result = buildProjectIndex({ projectsDir });
  if (!result.ok) throw new Error('expected ok:true');
  if (!Array.isArray(result.projects)) throw new Error('expected projects array');
  if (!result.summary) throw new Error('expected summary');
  if (typeof result.generated_at !== 'string') throw new Error('expected generated_at');
  if (result.summary.projects !== 0) throw new Error('expected 0 projects');
  if (result.summary.tasks_total !== 0) throw new Error('expected 0 tasks');
});

test('returns error if projects/ does not exist', () => {
  const result = buildProjectIndex({ projectsDir: '/tmp/_nonexistent_proj_dir_xyz' });
  if (result.ok) throw new Error('expected ok:false');
  if (!result.error.includes('does not exist')) throw new Error('wrong error: ' + result.error);
});

// -------------------------------------------------------------------------
// Test 2: Single project, no backlog
// -------------------------------------------------------------------------
console.log('\n--- single project ---');

test('single project with no backlog', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-alpha');
  const result = buildProjectIndex({ projectsDir });
  if (!result.ok) throw new Error('expected ok:true');
  if (result.projects.length !== 1) throw new Error(`expected 1 project, got ${result.projects.length}`);
  if (result.projects[0].project_id !== 'proj-alpha') throw new Error('wrong project_id');
  if (result.projects[0].totals.total !== 0) throw new Error('expected 0 total tasks');
  if (result.projects[0].backlog.length !== 0) throw new Error('expected empty backlog');
});

// -------------------------------------------------------------------------
// Test 3: Single project with backlog items
// -------------------------------------------------------------------------
console.log('\n--- backlog items ---');

test('reads backlog items with correct fields', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-beta', [
    { id: 'TASK-0001', status: 'todo', priority: 'P0', owner_role: 'PM' },
    { id: 'TASK-0002', status: 'in_progress', priority: 'P1', owner_role: 'DEV' },
    { id: 'TASK-0003', status: 'done', priority: 'P2', owner_role: 'QA' },
    { id: 'TASK-0004', status: 'blocked', priority: 'P3', owner_role: 'ARCHITECT' },
  ]);
  const result = buildProjectIndex({ projectsDir });
  if (!result.ok) throw new Error('expected ok:true');
  const proj = result.projects[0];
  if (proj.backlog.length !== 4) throw new Error(`expected 4 items, got ${proj.backlog.length}`);
  if (proj.totals.total !== 4) throw new Error(`expected total 4, got ${proj.totals.total}`);
  if (proj.totals.todo !== 1) throw new Error(`expected todo 1, got ${proj.totals.todo}`);
  if (proj.totals.in_progress !== 1) throw new Error(`expected in_progress 1`);
  if (proj.totals.done !== 1) throw new Error(`expected done 1`);
  if (proj.totals.blocked !== 1) throw new Error(`expected blocked 1`);

  const item1 = proj.backlog.find((b) => b.id === 'TASK-0001');
  if (item1.priority !== 'P0') throw new Error('wrong priority');
  if (item1.owner_role !== 'PM') throw new Error('wrong owner_role');
  if (item1.status !== 'todo') throw new Error('wrong status');
});

// -------------------------------------------------------------------------
// Test 4: Multiple projects, sorted ASC
// -------------------------------------------------------------------------
console.log('\n--- multiple projects ---');

test('projects sorted by project_id ASC', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'zzz-last');
  makeProject(projectsDir, 'aaa-first');
  makeProject(projectsDir, 'mmm-middle');
  const result = buildProjectIndex({ projectsDir });
  const ids = result.projects.map((p) => p.project_id);
  if (ids[0] !== 'aaa-first') throw new Error('wrong first: ' + ids[0]);
  if (ids[1] !== 'mmm-middle') throw new Error('wrong middle: ' + ids[1]);
  if (ids[2] !== 'zzz-last') throw new Error('wrong last: ' + ids[2]);
});

// -------------------------------------------------------------------------
// Test 5: Summary counts
// -------------------------------------------------------------------------
console.log('\n--- summary counts ---');

test('global summary counts are correct', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-a', [
    { id: 'T-1', status: 'todo' },
    { id: 'T-2', status: 'in_progress' },
  ]);
  makeProject(projectsDir, 'proj-b', [
    { id: 'T-3', status: 'blocked' },
    { id: 'T-4', status: 'done' },
    { id: 'T-5', status: 'todo' },
  ]);
  const result = buildProjectIndex({ projectsDir });
  if (result.summary.projects !== 2) throw new Error('wrong projects count');
  if (result.summary.tasks_total !== 5) throw new Error('wrong tasks_total');
  if (result.summary.todo !== 2) throw new Error('wrong todo count');
  if (result.summary.in_progress !== 1) throw new Error('wrong in_progress');
  if (result.summary.blocked !== 1) throw new Error('wrong blocked');
  if (result.summary.done !== 1) throw new Error('wrong done');
});

// -------------------------------------------------------------------------
// Test 6: Stop signal detection via linked run
// -------------------------------------------------------------------------
console.log('\n--- run enrichment ---');

test('detects stop signal from linked run', () => {
  const projectsDir = makeTempProjectsDir();
  // Create a temporary run with .stop
  const tmpRunDir = path.join(os.tmpdir(), `_test_proj_run_stop_${Date.now()}`);
  fs.mkdirSync(tmpRunDir, { recursive: true });
  tmpDirs.push(tmpRunDir);
  fs.writeFileSync(path.join(tmpRunDir, 'status.json'), JSON.stringify({
    current_stage: 'pm-ready', blocked: false,
  }), 'utf8');
  fs.writeFileSync(path.join(tmpRunDir, '.stop'), '', 'utf8');

  makeProject(projectsDir, 'proj-stop', [
    { id: 'T-STOP', status: 'in_progress', run_folder: tmpRunDir },
  ]);

  const result = buildProjectIndex({ projectsDir, workspaceRoot: '/' });
  const item = result.projects[0].backlog[0];
  if (!item.stop_signal) throw new Error('expected stop_signal true');
});

test('detects blocked from linked run', () => {
  const projectsDir = makeTempProjectsDir();
  const tmpRunDir = path.join(os.tmpdir(), `_test_proj_run_block_${Date.now()}`);
  fs.mkdirSync(tmpRunDir, { recursive: true });
  tmpDirs.push(tmpRunDir);
  fs.writeFileSync(path.join(tmpRunDir, 'status.json'), JSON.stringify({
    current_stage: 'blocked', blocked: true, blocked_reason: 'need input',
  }), 'utf8');

  makeProject(projectsDir, 'proj-block', [
    { id: 'T-BLOCK', status: 'in_progress', run_folder: tmpRunDir },
  ]);

  const result = buildProjectIndex({ projectsDir, workspaceRoot: '/' });
  const item = result.projects[0].backlog[0];
  if (!item.blocked) throw new Error('expected blocked true');
});

test('stalled detection from linked run', () => {
  const projectsDir = makeTempProjectsDir();
  const tmpRunDir = path.join(os.tmpdir(), `_test_proj_run_stall_${Date.now()}`);
  fs.mkdirSync(tmpRunDir, { recursive: true });
  tmpDirs.push(tmpRunDir);
  fs.writeFileSync(path.join(tmpRunDir, 'status.json'), JSON.stringify({
    current_stage: 'pm-ready', blocked: false,
    last_autonomous_summary: { final_action: 'needs_artifacts' },
  }), 'utf8');
  const auditPath = path.join(tmpRunDir, 'autonomous-audit.jsonl');
  fs.writeFileSync(auditPath, '{"step":1}\n', 'utf8');
  const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(auditPath, oldTime, oldTime);

  makeProject(projectsDir, 'proj-stall', [
    { id: 'T-STALL', status: 'in_progress', run_folder: tmpRunDir },
  ]);

  const result = buildProjectIndex({ projectsDir, workspaceRoot: '/' });
  const item = result.projects[0].backlog[0];
  if (!item.stalled) throw new Error('expected stalled true');
});

// -------------------------------------------------------------------------
// Test 7: Skips dirs without project.json
// -------------------------------------------------------------------------
console.log('\n--- edge cases ---');

test('skips directories without project.json', () => {
  const projectsDir = makeTempProjectsDir();
  fs.mkdirSync(path.join(projectsDir, 'no-project-json'), { recursive: true });
  makeProject(projectsDir, 'real-project');
  const result = buildProjectIndex({ projectsDir });
  if (result.projects.length !== 1) throw new Error('expected 1 project');
  if (result.projects[0].project_id !== 'real-project') throw new Error('wrong project');
});

test('skips backlog items with invalid JSON', () => {
  const projectsDir = makeTempProjectsDir();
  const projDir = makeProject(projectsDir, 'proj-bad-item', [
    { id: 'T-GOOD', status: 'todo' },
  ]);
  // Write an invalid JSON file
  fs.writeFileSync(path.join(projDir, 'backlog', 'bad.json'), 'NOT JSON', 'utf8');
  const result = buildProjectIndex({ projectsDir });
  const proj = result.projects[0];
  if (proj.backlog.length !== 1) throw new Error('expected 1 valid item');
  if (proj.backlog[0].id !== 'T-GOOD') throw new Error('wrong item');
});

// -------------------------------------------------------------------------
// Test 8: Deterministic ordering
// -------------------------------------------------------------------------
console.log('\n--- deterministic ---');

test('backlog items sorted by filename ASC', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-sort', [
    { id: 'TASK-0003' },
    { id: 'TASK-0001' },
    { id: 'TASK-0002' },
  ]);
  const result = buildProjectIndex({ projectsDir });
  const ids = result.projects[0].backlog.map((b) => b.id);
  if (ids[0] !== 'TASK-0001') throw new Error('wrong first: ' + ids[0]);
  if (ids[1] !== 'TASK-0002') throw new Error('wrong second: ' + ids[1]);
  if (ids[2] !== 'TASK-0003') throw new Error('wrong third: ' + ids[2]);
});

test('deterministic across repeated calls', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-det', [
    { id: 'A-1', status: 'todo' },
    { id: 'A-2', status: 'in_progress' },
  ]);
  const r1 = buildProjectIndex({ projectsDir });
  const r2 = buildProjectIndex({ projectsDir });
  const b1 = r1.projects[0].backlog.map((b) => b.id).join(',');
  const b2 = r2.projects[0].backlog.map((b) => b.id).join(',');
  if (b1 !== b2) throw new Error(`non-deterministic: ${b1} vs ${b2}`);
});

// -------------------------------------------------------------------------
// Test 9: CLI
// -------------------------------------------------------------------------
console.log('\n--- CLI ---');

test('CLI outputs valid JSON', () => {
  // CLI uses real projects/ dir which may not exist — create it
  const projDir = path.join(WORKSPACE_ROOT, 'projects');
  const existed = fs.existsSync(projDir);
  if (!existed) fs.mkdirSync(projDir, { recursive: true });
  try {
    const stdout = execFileSync('node', [INDEX_SCRIPT], { encoding: 'utf8', timeout: 10000 });
    const parsed = JSON.parse(stdout);
    if (typeof parsed.ok !== 'boolean') throw new Error('missing ok');
  } finally {
    if (!existed) {
      try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
    }
  }
});

test('shell helper outputs valid JSON', () => {
  const projDir = path.join(WORKSPACE_ROOT, 'projects');
  const existed = fs.existsSync(projDir);
  if (!existed) fs.mkdirSync(projDir, { recursive: true });
  try {
    const stdout = execFileSync('bash', [INDEX_SHELL], { encoding: 'utf8', timeout: 10000 });
    const parsed = JSON.parse(stdout);
    if (typeof parsed.ok !== 'boolean') throw new Error('missing ok');
  } finally {
    if (!existed) {
      try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
    }
  }
});

// -------------------------------------------------------------------------
// Test 10: Output schema validation
// -------------------------------------------------------------------------
console.log('\n--- output schema ---');

const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));
const indexSchema = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'project-index.output.schema.json'), 'utf8'));

test('output validates against schema (with items)', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-schema', [
    { id: 'T-S1', status: 'todo', priority: 'P0', owner_role: 'PM' },
  ]);
  const result = buildProjectIndex({ projectsDir });
  const v = validateAgainstSchema(result, indexSchema);
  if (!v.ok) throw new Error(`schema validation failed: ${v.details.join('; ')}`);
});

test('output validates against schema (empty)', () => {
  const projectsDir = makeTempProjectsDir();
  const result = buildProjectIndex({ projectsDir });
  const v = validateAgainstSchema(result, indexSchema);
  if (!v.ok) throw new Error(`schema validation failed: ${v.details.join('; ')}`);
});

test('CLI output validates against schema', () => {
  const projDir = path.join(WORKSPACE_ROOT, 'projects');
  const existed = fs.existsSync(projDir);
  if (!existed) fs.mkdirSync(projDir, { recursive: true });
  try {
    const stdout = execFileSync('node', [INDEX_SCRIPT], { encoding: 'utf8', timeout: 10000 });
    const parsed = JSON.parse(stdout);
    if (parsed.ok) {
      const v = validateAgainstSchema(parsed, indexSchema);
      if (!v.ok) throw new Error(`schema validation failed: ${v.details.join('; ')}`);
    }
  } finally {
    if (!existed) {
      try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
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
