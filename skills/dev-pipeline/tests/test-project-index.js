#!/usr/bin/env node
'use strict';

/**
 * Tests for project-index.js — read-only single-project index under .claw/.
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

function makeTempWorkspace(projectId, backlogItems = [], opts = {}) {
  const wsRoot = path.join(os.tmpdir(), `_test_proj_idx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(wsRoot, { recursive: true });
  const clawDir = path.join(wsRoot, '.claw');
  fs.mkdirSync(path.join(clawDir, 'backlog'), { recursive: true });
  fs.mkdirSync(path.join(clawDir, 'runs'), { recursive: true });
  fs.mkdirSync(path.join(clawDir, 'task-packs'), { recursive: true });

  fs.writeFileSync(path.join(clawDir, 'project.json'), JSON.stringify({
    project_id: projectId,
    title: opts.title || `Test project ${projectId}`,
    description: opts.description || `Description for ${projectId}`,
    repo_path: wsRoot,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }), 'utf8');

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
      path.join(clawDir, 'backlog', `${defaults.id}.json`),
      JSON.stringify(defaults, null, 2),
      'utf8'
    );
  }

  tmpDirs.push(wsRoot);
  return wsRoot;
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

test('returns ok:true with projects array and summary (no project.json)', () => {
  // Workspace dir exists but has no .claw/project.json
  const wsRoot = path.join(os.tmpdir(), `_test_proj_idx_empty_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(wsRoot, { recursive: true });
  tmpDirs.push(wsRoot);
  const result = buildProjectIndex({ workspaceRoot: wsRoot });
  if (!result.ok) throw new Error('expected ok:true');
  if (!Array.isArray(result.projects)) throw new Error('expected projects array');
  if (!result.summary) throw new Error('expected summary');
  if (typeof result.generated_at !== 'string') throw new Error('expected generated_at');
  if (result.summary.projects !== 0) throw new Error('expected 0 projects');
  if (result.summary.tasks_total !== 0) throw new Error('expected 0 tasks');
});

test('returns ok:true with empty projects when no project.json exists', () => {
  const wsRoot = path.join(os.tmpdir(), `_test_proj_idx_noproj_${Date.now()}`);
  fs.mkdirSync(wsRoot, { recursive: true });
  tmpDirs.push(wsRoot);
  const result = buildProjectIndex({ workspaceRoot: wsRoot });
  if (!result.ok) throw new Error('expected ok:true');
  if (result.projects.length !== 0) throw new Error('expected 0 projects');
});

// -------------------------------------------------------------------------
// Test 2: Single project, no backlog
// -------------------------------------------------------------------------
console.log('\n--- single project ---');

test('single project with no backlog', () => {
  const wsRoot = makeTempWorkspace('proj-alpha');
  const result = buildProjectIndex({ workspaceRoot: wsRoot });
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
  const wsRoot = makeTempWorkspace('proj-beta', [
    { id: 'TASK-0001', status: 'todo', priority: 'P0', owner_role: 'PM' },
    { id: 'TASK-0002', status: 'in_progress', priority: 'P1', owner_role: 'DEV' },
    { id: 'TASK-0003', status: 'done', priority: 'P2', owner_role: 'QA' },
    { id: 'TASK-0004', status: 'blocked', priority: 'P3', owner_role: 'ARCHITECT' },
  ]);
  const result = buildProjectIndex({ workspaceRoot: wsRoot });
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
// Test 4: Summary counts (single project)
// -------------------------------------------------------------------------
console.log('\n--- summary counts ---');

test('summary counts are correct for single project', () => {
  const wsRoot = makeTempWorkspace('proj-a', [
    { id: 'T-1', status: 'todo' },
    { id: 'T-2', status: 'in_progress' },
    { id: 'T-3', status: 'blocked' },
    { id: 'T-4', status: 'done' },
    { id: 'T-5', status: 'todo' },
  ]);
  const result = buildProjectIndex({ workspaceRoot: wsRoot });
  if (result.summary.projects !== 1) throw new Error('wrong projects count');
  if (result.summary.tasks_total !== 5) throw new Error('wrong tasks_total');
  if (result.summary.todo !== 2) throw new Error('wrong todo count');
  if (result.summary.in_progress !== 1) throw new Error('wrong in_progress');
  if (result.summary.blocked !== 1) throw new Error('wrong blocked');
  if (result.summary.done !== 1) throw new Error('wrong done');
});

// -------------------------------------------------------------------------
// Test 5: Stop signal detection via linked run
// -------------------------------------------------------------------------
console.log('\n--- run enrichment ---');

test('detects stop signal from linked run', () => {
  const wsRoot = makeTempWorkspace('proj-stop');
  // Create a temporary run with .stop
  const tmpRunDir = path.join(os.tmpdir(), `_test_proj_run_stop_${Date.now()}`);
  fs.mkdirSync(tmpRunDir, { recursive: true });
  tmpDirs.push(tmpRunDir);
  fs.writeFileSync(path.join(tmpRunDir, 'status.json'), JSON.stringify({
    current_stage: 'analyze', blocked: false,
  }), 'utf8');
  fs.writeFileSync(path.join(tmpRunDir, '.stop'), '', 'utf8');

  // Write backlog item with run_folder
  fs.writeFileSync(
    path.join(wsRoot, '.claw', 'backlog', 'T-STOP.json'),
    JSON.stringify({
      id: 'T-STOP', project_id: 'proj-stop', type: 'task', title: 'Stop task',
      description: '', status: 'in_progress', priority: 'P2', owner_role: 'DEV',
      depends_on: [], run_folder: tmpRunDir, tags: [], artifacts_expected: [],
      last_summary: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    }, null, 2),
    'utf8'
  );

  const result = buildProjectIndex({ workspaceRoot: wsRoot });
  const item = result.projects[0].backlog[0];
  if (!item.stop_signal) throw new Error('expected stop_signal true');
});

test('detects blocked from linked run', () => {
  const wsRoot = makeTempWorkspace('proj-block');
  const tmpRunDir = path.join(os.tmpdir(), `_test_proj_run_block_${Date.now()}`);
  fs.mkdirSync(tmpRunDir, { recursive: true });
  tmpDirs.push(tmpRunDir);
  fs.writeFileSync(path.join(tmpRunDir, 'status.json'), JSON.stringify({
    current_stage: 'blocked', blocked: true, blocked_reason: 'need input',
  }), 'utf8');

  fs.writeFileSync(
    path.join(wsRoot, '.claw', 'backlog', 'T-BLOCK.json'),
    JSON.stringify({
      id: 'T-BLOCK', project_id: 'proj-block', type: 'task', title: 'Blocked task',
      description: '', status: 'in_progress', priority: 'P2', owner_role: 'DEV',
      depends_on: [], run_folder: tmpRunDir, tags: [], artifacts_expected: [],
      last_summary: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    }, null, 2),
    'utf8'
  );

  const result = buildProjectIndex({ workspaceRoot: wsRoot });
  const item = result.projects[0].backlog[0];
  if (!item.blocked) throw new Error('expected blocked true');
});

test('stalled detection from linked run', () => {
  const wsRoot = makeTempWorkspace('proj-stall');
  const tmpRunDir = path.join(os.tmpdir(), `_test_proj_run_stall_${Date.now()}`);
  fs.mkdirSync(tmpRunDir, { recursive: true });
  tmpDirs.push(tmpRunDir);
  fs.writeFileSync(path.join(tmpRunDir, 'status.json'), JSON.stringify({
    current_stage: 'analyze', blocked: false,
    last_autonomous_summary: { final_action: 'needs_artifacts' },
  }), 'utf8');
  const auditPath = path.join(tmpRunDir, 'autonomous-audit.jsonl');
  fs.writeFileSync(auditPath, '{"step":1}\n', 'utf8');
  const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(auditPath, oldTime, oldTime);

  fs.writeFileSync(
    path.join(wsRoot, '.claw', 'backlog', 'T-STALL.json'),
    JSON.stringify({
      id: 'T-STALL', project_id: 'proj-stall', type: 'task', title: 'Stalled task',
      description: '', status: 'in_progress', priority: 'P2', owner_role: 'DEV',
      depends_on: [], run_folder: tmpRunDir, tags: [], artifacts_expected: [],
      last_summary: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    }, null, 2),
    'utf8'
  );

  const result = buildProjectIndex({ workspaceRoot: wsRoot });
  const item = result.projects[0].backlog[0];
  if (!item.stalled) throw new Error('expected stalled true');
});

// -------------------------------------------------------------------------
// Test 6: Edge cases
// -------------------------------------------------------------------------
console.log('\n--- edge cases ---');

test('skips backlog items with invalid JSON', () => {
  const wsRoot = makeTempWorkspace('proj-bad-item', [
    { id: 'T-GOOD', status: 'todo' },
  ]);
  // Write an invalid JSON file
  fs.writeFileSync(path.join(wsRoot, '.claw', 'backlog', 'bad.json'), 'NOT JSON', 'utf8');
  const result = buildProjectIndex({ workspaceRoot: wsRoot });
  const proj = result.projects[0];
  if (proj.backlog.length !== 1) throw new Error('expected 1 valid item');
  if (proj.backlog[0].id !== 'T-GOOD') throw new Error('wrong item');
});

// -------------------------------------------------------------------------
// Test 7: Deterministic ordering
// -------------------------------------------------------------------------
console.log('\n--- deterministic ---');

test('backlog items sorted by filename ASC', () => {
  const wsRoot = makeTempWorkspace('proj-sort', [
    { id: 'TASK-0003' },
    { id: 'TASK-0001' },
    { id: 'TASK-0002' },
  ]);
  const result = buildProjectIndex({ workspaceRoot: wsRoot });
  const ids = result.projects[0].backlog.map((b) => b.id);
  if (ids[0] !== 'TASK-0001') throw new Error('wrong first: ' + ids[0]);
  if (ids[1] !== 'TASK-0002') throw new Error('wrong second: ' + ids[1]);
  if (ids[2] !== 'TASK-0003') throw new Error('wrong third: ' + ids[2]);
});

test('deterministic across repeated calls', () => {
  const wsRoot = makeTempWorkspace('proj-det', [
    { id: 'A-1', status: 'todo' },
    { id: 'A-2', status: 'in_progress' },
  ]);
  const r1 = buildProjectIndex({ workspaceRoot: wsRoot });
  const r2 = buildProjectIndex({ workspaceRoot: wsRoot });
  const b1 = r1.projects[0].backlog.map((b) => b.id).join(',');
  const b2 = r2.projects[0].backlog.map((b) => b.id).join(',');
  if (b1 !== b2) throw new Error(`non-deterministic: ${b1} vs ${b2}`);
});

// -------------------------------------------------------------------------
// Test 8: CLI
// -------------------------------------------------------------------------
console.log('\n--- CLI ---');

test('CLI outputs valid JSON', () => {
  // CLI uses WORKSPACE_ROOT which must have .claw/ — create it if needed
  const clawDir = path.join(WORKSPACE_ROOT, '.claw');
  const existed = fs.existsSync(clawDir);
  if (!existed) fs.mkdirSync(clawDir, { recursive: true });
  try {
    const stdout = execFileSync('node', [INDEX_SCRIPT], { encoding: 'utf8', timeout: 10000 });
    const parsed = JSON.parse(stdout);
    if (typeof parsed.ok !== 'boolean') throw new Error('missing ok');
  } finally {
    if (!existed) {
      try { fs.rmSync(clawDir, { recursive: true, force: true }); } catch {}
    }
  }
});

test('shell helper outputs valid JSON', () => {
  const clawDir = path.join(WORKSPACE_ROOT, '.claw');
  const existed = fs.existsSync(clawDir);
  if (!existed) fs.mkdirSync(clawDir, { recursive: true });
  try {
    const stdout = execFileSync('bash', [INDEX_SHELL], { encoding: 'utf8', timeout: 10000 });
    const parsed = JSON.parse(stdout);
    if (typeof parsed.ok !== 'boolean') throw new Error('missing ok');
  } finally {
    if (!existed) {
      try { fs.rmSync(clawDir, { recursive: true, force: true }); } catch {}
    }
  }
});

// -------------------------------------------------------------------------
// Test 9: Output schema validation
// -------------------------------------------------------------------------
console.log('\n--- output schema ---');

const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));
const indexSchema = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'project-index.output.schema.json'), 'utf8'));

test('output validates against schema (with items)', () => {
  const wsRoot = makeTempWorkspace('proj-schema', [
    { id: 'T-S1', status: 'todo', priority: 'P0', owner_role: 'PM' },
  ]);
  const result = buildProjectIndex({ workspaceRoot: wsRoot });
  const v = validateAgainstSchema(result, indexSchema);
  if (!v.ok) throw new Error(`schema validation failed: ${v.details.join('; ')}`);
});

test('output validates against schema (empty)', () => {
  const wsRoot = path.join(os.tmpdir(), `_test_proj_idx_schema_empty_${Date.now()}`);
  fs.mkdirSync(wsRoot, { recursive: true });
  tmpDirs.push(wsRoot);
  const result = buildProjectIndex({ workspaceRoot: wsRoot });
  const v = validateAgainstSchema(result, indexSchema);
  if (!v.ok) throw new Error(`schema validation failed: ${v.details.join('; ')}`);
});

test('CLI output validates against schema', () => {
  const clawDir = path.join(WORKSPACE_ROOT, '.claw');
  const existed = fs.existsSync(clawDir);
  if (!existed) fs.mkdirSync(clawDir, { recursive: true });
  try {
    const stdout = execFileSync('node', [INDEX_SCRIPT], { encoding: 'utf8', timeout: 10000 });
    const parsed = JSON.parse(stdout);
    if (parsed.ok) {
      const v = validateAgainstSchema(parsed, indexSchema);
      if (!v.ok) throw new Error(`schema validation failed: ${v.details.join('; ')}`);
    }
  } finally {
    if (!existed) {
      try { fs.rmSync(clawDir, { recursive: true, force: true }); } catch {}
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
