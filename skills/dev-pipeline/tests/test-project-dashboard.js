#!/usr/bin/env node
'use strict';

/**
 * Tests for project-dashboard.js — read-only aggregated project dashboard.
 * Run: node skills/dev-pipeline/tests/test-project-dashboard.js
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = path.resolve(os.homedir(), 'dev', 'agent-work');
const DASHBOARD_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'project-dashboard.js');
const DASHBOARD_SHELL = path.join(WORKSPACE_ROOT, 'tools', 'project-dashboard.sh');

const { buildDashboard } = require(DASHBOARD_SCRIPT);
const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));
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

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `_test_dashboard_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function makeProject(projectsDir, projectId, backlogItems = [], opts = {}) {
  const projectDir = path.join(projectsDir, projectId);
  fs.mkdirSync(projectDir, { recursive: true });

  const project = {
    project_id: projectId,
    title: opts.title || `Test project ${projectId}`,
    description: opts.description || `Description for ${projectId}`,
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

test('returns ok:true with empty projects', () => {
  const projectsDir = makeTempDir();
  const result = buildDashboard({ projectsDir });
  if (!result.ok) throw new Error('expected ok:true');
  if (!Array.isArray(result.projects)) throw new Error('expected projects array');
  if (!result.summary) throw new Error('expected summary');
  if (typeof result.generated_at !== 'string') throw new Error('expected generated_at');
  if (result.summary.projects !== 0) throw new Error('expected 0 projects');
});

test('returns error if projects/ does not exist', () => {
  const result = buildDashboard({ projectsDir: '/tmp/_nonexistent_dashboard_xyz' });
  if (result.ok) throw new Error('expected ok:false');
  if (!result.error.includes('does not exist')) throw new Error('wrong error: ' + result.error);
});

test('empty output validates against schema', () => {
  const projectsDir = makeTempDir();
  const result = buildDashboard({ projectsDir });
  const v = validateAgainstSchema(result, dashboardSchema);
  if (!v.ok) throw new Error(`schema validation failed: ${v.details.join('; ')}`);
});

// -------------------------------------------------------------------------
// Test 2: Project metadata
// -------------------------------------------------------------------------
console.log('\n--- project metadata ---');

test('includes title and description from project.json', () => {
  const projectsDir = makeTempDir();
  makeProject(projectsDir, 'proj-meta', [], {
    title: 'Meta Project',
    description: 'A description',
  });
  const result = buildDashboard({ projectsDir });
  const proj = result.projects[0];
  if (proj.title !== 'Meta Project') throw new Error(`wrong title: ${proj.title}`);
  if (proj.description !== 'A description') throw new Error(`wrong desc: ${proj.description}`);
});

// -------------------------------------------------------------------------
// Test 3: Backlog items with enrichment
// -------------------------------------------------------------------------
console.log('\n--- backlog enrichment ---');

test('items have all required dashboard fields', () => {
  const projectsDir = makeTempDir();
  makeProject(projectsDir, 'proj-fields', [
    { id: 'T-1', status: 'todo', priority: 'P0', owner_role: 'PM', depends_on: ['T-0'], tags: ['urgent'] },
  ]);
  const result = buildDashboard({ projectsDir });
  const item = result.projects[0].backlog[0];
  const requiredFields = [
    'id', 'type', 'status', 'priority', 'owner_role', 'depends_on', 'tags',
    'run_folder', 'priority_bucket', 'run_stage', 'run_blocked', 'run_stop',
    'needs_task_pack', 'needs_artifacts', 'stalled',
  ];
  for (const field of requiredFields) {
    if (!(field in item)) throw new Error(`missing field: ${field}`);
  }
});

test('todo task without run_folder shows needs_task_pack', () => {
  const projectsDir = makeTempDir();
  makeProject(projectsDir, 'proj-ntp', [
    { id: 'T-NTP', status: 'todo' },
  ]);
  const result = buildDashboard({ projectsDir });
  const item = result.projects[0].backlog[0];
  if (!item.needs_task_pack) throw new Error('expected needs_task_pack true');
  if (item.priority_bucket !== 'needs_task_pack') throw new Error(`expected needs_task_pack bucket, got ${item.priority_bucket}`);
});

test('done task has null priority_bucket', () => {
  const projectsDir = makeTempDir();
  makeProject(projectsDir, 'proj-done', [
    { id: 'T-DONE', status: 'done' },
  ]);
  const result = buildDashboard({ projectsDir });
  const item = result.projects[0].backlog[0];
  if (item.priority_bucket !== null) throw new Error(`expected null bucket, got ${item.priority_bucket}`);
  if (item.needs_task_pack) throw new Error('done task should not need task pack');
});

// -------------------------------------------------------------------------
// Test 4: Run enrichment
// -------------------------------------------------------------------------
console.log('\n--- run enrichment ---');

test('detects run_stage from linked run', () => {
  const projectsDir = makeTempDir();
  const tmpRunDir = makeTempDir();
  fs.writeFileSync(path.join(tmpRunDir, 'status.json'), JSON.stringify({
    current_stage: 'pm-ready', blocked: false,
  }), 'utf8');

  makeProject(projectsDir, 'proj-stage', [
    { id: 'T-STAGE', status: 'in_progress', run_folder: tmpRunDir },
  ]);

  const result = buildDashboard({ projectsDir, workspaceRoot: '/' });
  const item = result.projects[0].backlog[0];
  if (item.run_stage !== 'pm-ready') throw new Error(`expected pm-ready, got ${item.run_stage}`);
});

test('detects run_blocked from linked run', () => {
  const projectsDir = makeTempDir();
  const tmpRunDir = makeTempDir();
  fs.writeFileSync(path.join(tmpRunDir, 'status.json'), JSON.stringify({
    current_stage: 'blocked', blocked: true,
  }), 'utf8');

  makeProject(projectsDir, 'proj-blk', [
    { id: 'T-BLK', status: 'in_progress', run_folder: tmpRunDir },
  ]);

  const result = buildDashboard({ projectsDir, workspaceRoot: '/' });
  const item = result.projects[0].backlog[0];
  if (!item.run_blocked) throw new Error('expected run_blocked true');
});

test('detects run_stop from linked run', () => {
  const projectsDir = makeTempDir();
  const tmpRunDir = makeTempDir();
  fs.writeFileSync(path.join(tmpRunDir, 'status.json'), JSON.stringify({
    current_stage: 'pm-ready', blocked: false,
  }), 'utf8');
  fs.writeFileSync(path.join(tmpRunDir, '.stop'), '', 'utf8');

  makeProject(projectsDir, 'proj-stop', [
    { id: 'T-STOP', status: 'in_progress', run_folder: tmpRunDir },
  ]);

  const result = buildDashboard({ projectsDir, workspaceRoot: '/' });
  const item = result.projects[0].backlog[0];
  if (!item.run_stop) throw new Error('expected run_stop true');
});

test('detects needs_artifacts from linked run', () => {
  const projectsDir = makeTempDir();
  const tmpRunDir = makeTempDir();
  fs.writeFileSync(path.join(tmpRunDir, 'status.json'), JSON.stringify({
    current_stage: 'pm-ready', blocked: false,
    last_autonomous_summary: { final_action: 'needs_artifacts' },
  }), 'utf8');

  makeProject(projectsDir, 'proj-na', [
    { id: 'T-NA', status: 'in_progress', run_folder: tmpRunDir },
  ]);

  const result = buildDashboard({ projectsDir, workspaceRoot: '/' });
  const item = result.projects[0].backlog[0];
  if (!item.needs_artifacts) throw new Error('expected needs_artifacts true');
  if (item.priority_bucket !== 'needs_artifacts') throw new Error(`expected needs_artifacts bucket, got ${item.priority_bucket}`);
});

test('detects stalled run', () => {
  const projectsDir = makeTempDir();
  const tmpRunDir = makeTempDir();
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

  const result = buildDashboard({ projectsDir, workspaceRoot: '/' });
  const item = result.projects[0].backlog[0];
  if (!item.stalled) throw new Error('expected stalled true');
});

// -------------------------------------------------------------------------
// Test 5: Task pack detection
// -------------------------------------------------------------------------
console.log('\n--- task pack detection ---');

test('task with task pack shows ready_for_run_creation', () => {
  // workspaceRoot must contain 'projects' as a subdirectory
  const wsRoot = makeTempDir();
  const projectsDir = path.join(wsRoot, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  makeProject(projectsDir, 'proj-tp', [
    { id: 'T-TP', status: 'todo' },
  ]);
  // Create task pack
  const taskPacksDir = path.join(projectsDir, 'proj-tp', 'task-packs');
  fs.mkdirSync(taskPacksDir, { recursive: true });
  fs.writeFileSync(path.join(taskPacksDir, 'T-TP.json'), JSON.stringify({
    task_id: 'T-TP', project_id: 'proj-tp', title: 'Test',
  }), 'utf8');

  const result = buildDashboard({ projectsDir, workspaceRoot: wsRoot });
  const item = result.projects[0].backlog[0];
  if (item.needs_task_pack) throw new Error('should not need task pack');
  if (item.priority_bucket !== 'ready_for_run_creation') throw new Error(`expected ready_for_run_creation, got ${item.priority_bucket}`);
});

// -------------------------------------------------------------------------
// Test 6: Summary counts
// -------------------------------------------------------------------------
console.log('\n--- summary counts ---');

test('summary counts are correct', () => {
  const projectsDir = makeTempDir();
  makeProject(projectsDir, 'proj-a', [
    { id: 'T-1', status: 'todo' },
    { id: 'T-2', status: 'in_progress' },
  ]);
  makeProject(projectsDir, 'proj-b', [
    { id: 'T-3', status: 'blocked' },
    { id: 'T-4', status: 'done' },
    { id: 'T-5', status: 'todo' },
  ]);

  const result = buildDashboard({ projectsDir });
  if (result.summary.projects !== 2) throw new Error('wrong projects count');
  if (result.summary.tasks_total !== 5) throw new Error('wrong tasks_total');
  if (result.summary.todo !== 2) throw new Error('wrong todo count');
  if (result.summary.in_progress !== 1) throw new Error('wrong in_progress');
  if (result.summary.blocked !== 1) throw new Error('wrong blocked');
  if (result.summary.done !== 1) throw new Error('wrong done');
  if (result.summary.needs_task_pack !== 3) throw new Error(`wrong needs_task_pack: ${result.summary.needs_task_pack}`);
});

// -------------------------------------------------------------------------
// Test 7: Schema validation with populated data
// -------------------------------------------------------------------------
console.log('\n--- schema validation ---');

test('populated output validates against schema', () => {
  const projectsDir = makeTempDir();
  makeProject(projectsDir, 'proj-sv', [
    { id: 'T-SV1', status: 'todo', priority: 'P0', depends_on: [], tags: ['test'] },
    { id: 'T-SV2', status: 'done' },
  ]);
  const result = buildDashboard({ projectsDir });
  const v = validateAgainstSchema(result, dashboardSchema);
  if (!v.ok) throw new Error(`schema validation failed: ${v.details.join('; ')}`);
});

// -------------------------------------------------------------------------
// Test 8: Deterministic ordering
// -------------------------------------------------------------------------
console.log('\n--- deterministic ---');

test('projects sorted by project_id ASC', () => {
  const projectsDir = makeTempDir();
  makeProject(projectsDir, 'zzz-last');
  makeProject(projectsDir, 'aaa-first');
  const result = buildDashboard({ projectsDir });
  if (result.projects[0].project_id !== 'aaa-first') throw new Error('wrong order');
  if (result.projects[1].project_id !== 'zzz-last') throw new Error('wrong order');
});

test('backlog items sorted by filename ASC', () => {
  const projectsDir = makeTempDir();
  makeProject(projectsDir, 'proj-sort', [
    { id: 'T-003' },
    { id: 'T-001' },
    { id: 'T-002' },
  ]);
  const result = buildDashboard({ projectsDir });
  const ids = result.projects[0].backlog.map((b) => b.id);
  if (ids[0] !== 'T-001') throw new Error('wrong first');
  if (ids[1] !== 'T-002') throw new Error('wrong second');
  if (ids[2] !== 'T-003') throw new Error('wrong third');
});

// -------------------------------------------------------------------------
// Test 9: CLI
// -------------------------------------------------------------------------
console.log('\n--- CLI ---');

test('CLI outputs valid JSON', () => {
  const projDir = path.join(WORKSPACE_ROOT, 'projects');
  const existed = fs.existsSync(projDir);
  if (!existed) fs.mkdirSync(projDir, { recursive: true });
  try {
    const stdout = execFileSync('node', [DASHBOARD_SCRIPT], { encoding: 'utf8', timeout: 10000 });
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
    const stdout = execFileSync('bash', [DASHBOARD_SHELL], { encoding: 'utf8', timeout: 10000 });
    const parsed = JSON.parse(stdout);
    if (typeof parsed.ok !== 'boolean') throw new Error('missing ok');
  } finally {
    if (!existed) {
      try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
    }
  }
});

test('CLI output validates against schema', () => {
  const projDir = path.join(WORKSPACE_ROOT, 'projects');
  const existed = fs.existsSync(projDir);
  if (!existed) fs.mkdirSync(projDir, { recursive: true });
  try {
    const stdout = execFileSync('node', [DASHBOARD_SCRIPT], { encoding: 'utf8', timeout: 10000 });
    const parsed = JSON.parse(stdout);
    if (parsed.ok) {
      const v = validateAgainstSchema(parsed, dashboardSchema);
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
