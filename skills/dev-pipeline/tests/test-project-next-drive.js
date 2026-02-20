#!/usr/bin/env node
'use strict';

/**
 * Tests for project-next-drive.js — one-shot single-project driver.
 * Run: node skills/dev-pipeline/tests/test-project-next-drive.js
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
const DRIVE_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'project-next-drive.js');
const DRIVE_SHELL = path.join(WORKSPACE_ROOT, 'tools', 'project-next-drive.sh');

const { projectDriveOnce } = require(DRIVE_SCRIPT);

let passed = 0;
let failed = 0;
const tmpDirs = [];
const createdRunDirs = [];

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
  const wsRoot = path.join(os.tmpdir(), `_test_proj_drv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
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
      description: 'Test task description',
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

/** Scaffold adapter -- mimics the test scaffold used in run-next-autonomous tests. */
function makeScaffoldAdapter() {
  // Reuse existing scaffold infrastructure
  const devPipelinePath = path.resolve(__dirname, '..', 'scripts', 'dev-pipeline.js');
  const {
    STAGE_CONFIG, loadArtifactSchema, generateMinimalValue, safePath: dpSafePath,
  } = require(devPipelinePath);

  return function scaffoldAdapter(runFolder, stage, missingArtifacts) {
    const absRun = dpSafePath(runFolder);
    const written = [];
    for (const artifactFile of missingArtifacts) {
      const schemaName = Object.entries(STAGE_CONFIG).reduce((acc, [, cfg]) => {
        const idx = cfg.requiredArtifacts.indexOf(artifactFile);
        if (idx !== -1) {
          const schemaMap = {
            '10-pm-brief.json': 'pm-brief.schema.json',
            '20-arch-design.json': 'arch-design.schema.json',
            '41-dev-notes.json': 'dev-notes.schema.json',
            '50-qa-report.json': 'qa-report.schema.json',
            '60-review-report.json': 'review-report.schema.json',
          };
          return schemaMap[artifactFile] || acc;
        }
        return acc;
      }, null);

      if (artifactFile.endsWith('.diff')) {
        fs.writeFileSync(path.join(absRun, artifactFile), '--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n', 'utf8');
        written.push(artifactFile);
      } else if (schemaName) {
        try {
          const schema = loadArtifactSchema(schemaName);
          const data = generateMinimalValue(schema, schema);
          fs.writeFileSync(path.join(absRun, artifactFile), JSON.stringify(data, null, 2) + '\n', 'utf8');
          written.push(artifactFile);
        } catch {
          // Skip if schema not found
        }
      }
    }
    return written;
  };
}

function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  for (const dir of createdRunDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
process.on('exit', cleanup);

// -------------------------------------------------------------------------
// Test 1: No eligible tasks
// -------------------------------------------------------------------------
console.log('\n--- no eligible ---');

test('drive_skipped when all tasks done', () => {
  const wsRoot = makeTempWorkspace('proj-done', [
    { id: 'T-DONE', status: 'done' },
  ]);
  const result = projectDriveOnce({ workspaceRoot: wsRoot, dryRun: true });
  if (result.action !== 'drive_skipped') throw new Error(`expected drive_skipped, got ${result.action}`);
});

test('drive_skipped when empty workspace', () => {
  const wsRoot = path.join(os.tmpdir(), `_test_proj_drv_empty_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(wsRoot, { recursive: true });
  tmpDirs.push(wsRoot);
  const result = projectDriveOnce({ workspaceRoot: wsRoot, dryRun: true });
  if (result.action !== 'drive_skipped') throw new Error(`expected drive_skipped, got ${result.action}`);
});

// -------------------------------------------------------------------------
// Test 2: Dry run with task needing run creation
// -------------------------------------------------------------------------
console.log('\n--- dry run ---');

test('dry_run skips when no run_folder exists', () => {
  const wsRoot = makeTempWorkspace('proj-dry', [
    { id: 'T-DRY', status: 'todo', priority: 'P0' },
  ]);
  const result = projectDriveOnce({ workspaceRoot: wsRoot, dryRun: true });
  if (result.action !== 'drive_skipped') throw new Error(`expected drive_skipped, got ${result.action}`);
  if (!result.picked) throw new Error('expected picked field');
  if (result.picked.task_id !== 'T-DRY') throw new Error(`expected T-DRY, got ${result.picked.task_id}`);
});

// -------------------------------------------------------------------------
// Test 3: Run creation for task without run_folder
// -------------------------------------------------------------------------
console.log('\n--- run creation ---');

test('creates run folder when task has no run_folder', () => {
  const wsRoot = makeTempWorkspace('proj-create', [
    { id: 'T-NEW', status: 'todo', priority: 'P0', title: 'New task' },
  ]);

  const result = projectDriveOnce({
    workspaceRoot: wsRoot,
    agentAdapter: makeScaffoldAdapter(),
    maxSteps: 3,
  });

  // Track created run folder for cleanup BEFORE any assertions
  if (result.run_folder) {
    createdRunDirs.push(path.resolve(wsRoot, result.run_folder));
  }

  if (!result.ok) throw new Error('expected ok:true, got: ' + JSON.stringify(result));
  if (result.action !== 'drive_created_run') throw new Error(`expected drive_created_run, got ${result.action}`);
  if (!result.run_folder) throw new Error('missing run_folder');

  // Verify run was created under .claw/runs/
  const absRun = path.resolve(wsRoot, result.run_folder);
  if (!fs.existsSync(absRun)) throw new Error('run folder does not exist');

  // Verify status.json was created
  const status = JSON.parse(fs.readFileSync(path.join(absRun, 'status.json'), 'utf8'));
  if (status.ticket_id !== 'T-NEW') throw new Error('wrong ticket_id in status');
  if (status.project !== 'proj-create') throw new Error('wrong project in status');

  // Verify backlog item was updated with run_folder
  const backlogItem = JSON.parse(fs.readFileSync(
    path.join(wsRoot, '.claw', 'backlog', 'T-NEW.json'), 'utf8'
  ));
  if (backlogItem.run_folder !== result.run_folder) throw new Error('backlog item not linked');
  if (backlogItem.status !== 'in_progress') throw new Error('backlog item status not updated');
});

// -------------------------------------------------------------------------
// Test 4: Drive with existing run_folder
// -------------------------------------------------------------------------
console.log('\n--- existing run ---');

test('drives existing run without creating new one', () => {
  const wsRoot = makeTempWorkspace('proj-exist');

  // Create a run folder under .claw/runs/
  const runFolderName = `_test_proj_drv_existing_${Date.now()}`;
  const runFolder = `.claw/runs/${runFolderName}`;
  const absRun = path.join(wsRoot, '.claw', 'runs', runFolderName);
  fs.mkdirSync(absRun, { recursive: true });
  createdRunDirs.push(absRun);

  // Set up a pm-ready status so autonomous runner can drive it
  fs.writeFileSync(path.join(absRun, 'status.json'), JSON.stringify({
    ticket_id: 'T-EXIST',
    title: 'Existing task',
    project: 'proj-exist',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    current_stage: 'pm-ready',
    blocked: false,
    blocked_reason: null,
    required_user_input: [],
    stage_history: [],
    next_actions: [],
  }, null, 2) + '\n', 'utf8');

  // Add a task file so it goes to needs_artifacts
  fs.writeFileSync(path.join(absRun, '31-pm-claude-task.txt'), 'task content', 'utf8');

  // Write backlog item with run_folder
  fs.writeFileSync(
    path.join(wsRoot, '.claw', 'backlog', 'T-EXIST.json'),
    JSON.stringify({
      id: 'T-EXIST', project_id: 'proj-exist', type: 'task', title: 'Existing task',
      description: 'Test task description', status: 'in_progress', priority: 'P2', owner_role: 'DEV',
      depends_on: [], run_folder: runFolder, tags: [], artifacts_expected: [],
      last_summary: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    }, null, 2),
    'utf8'
  );

  const result = projectDriveOnce({
    workspaceRoot: wsRoot,
    agentAdapter: makeScaffoldAdapter(),
    maxSteps: 5,
  });

  if (!result.ok) throw new Error('expected ok:true');
  if (result.action !== 'drive_complete') throw new Error(`expected drive_complete, got ${result.action}`);
  if (result.run_folder !== runFolder) throw new Error(`expected ${runFolder}, got ${result.run_folder}`);
});

// -------------------------------------------------------------------------
// Test 5: Output contract
// -------------------------------------------------------------------------
console.log('\n--- output contract ---');

test('drive_skipped has ok and action and picked', () => {
  const wsRoot = path.join(os.tmpdir(), `_test_proj_drv_contract_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(wsRoot, { recursive: true });
  tmpDirs.push(wsRoot);
  const result = projectDriveOnce({ workspaceRoot: wsRoot, dryRun: true });
  if (typeof result.ok !== 'boolean') throw new Error('missing ok');
  if (!result.action) throw new Error('missing action');
  if (!result.picked) throw new Error('missing picked');
});

// -------------------------------------------------------------------------
// Test 6: CLI
// -------------------------------------------------------------------------
console.log('\n--- CLI ---');

test('CLI --dry_run outputs valid JSON', () => {
  const clawDir = path.join(WORKSPACE_ROOT, '.claw');
  const existed = fs.existsSync(clawDir);
  if (!existed) fs.mkdirSync(clawDir, { recursive: true });
  try {
    const stdout = execFileSync('node', [DRIVE_SCRIPT, '--dry_run'], { encoding: 'utf8', timeout: 10000 });
    const parsed = JSON.parse(stdout);
    if (typeof parsed.ok !== 'boolean') throw new Error('missing ok');
    if (!parsed.action) throw new Error('missing action');
  } finally {
    if (!existed) {
      try { fs.rmSync(clawDir, { recursive: true, force: true }); } catch {}
    }
  }
});

test('shell helper --dry_run outputs valid JSON', () => {
  const clawDir = path.join(WORKSPACE_ROOT, '.claw');
  const existed = fs.existsSync(clawDir);
  if (!existed) fs.mkdirSync(clawDir, { recursive: true });
  try {
    const stdout = execFileSync('bash', [DRIVE_SHELL, '--dry_run'], { encoding: 'utf8', timeout: 10000 });
    const parsed = JSON.parse(stdout);
    if (typeof parsed.ok !== 'boolean') throw new Error('missing ok');
  } finally {
    if (!existed) {
      try { fs.rmSync(clawDir, { recursive: true, force: true }); } catch {}
    }
  }
});

// -------------------------------------------------------------------------
// Test 7: Output schema validation
// -------------------------------------------------------------------------
console.log('\n--- output schema ---');

const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));
const driveSchema = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'project-next-drive.output.schema.json'), 'utf8'));

test('drive_skipped output validates against schema', () => {
  const wsRoot = path.join(os.tmpdir(), `_test_proj_drv_schema_skip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(wsRoot, { recursive: true });
  tmpDirs.push(wsRoot);
  const result = projectDriveOnce({ workspaceRoot: wsRoot, dryRun: true });
  const v = validateAgainstSchema(result, driveSchema);
  if (!v.ok) throw new Error(`schema validation failed: ${v.details.join('; ')}`);
});

test('drive_created_run output validates against schema', () => {
  const wsRoot = makeTempWorkspace('proj-schema-new', [
    { id: 'T-SCHEMA-NEW', status: 'todo', priority: 'P0', title: 'Schema test' },
  ]);

  const result = projectDriveOnce({
    workspaceRoot: wsRoot,
    agentAdapter: makeScaffoldAdapter(),
    maxSteps: 3,
  });

  // Track created run folder for cleanup BEFORE any assertions
  if (result.run_folder) {
    createdRunDirs.push(path.resolve(wsRoot, result.run_folder));
  }

  if (!result.ok) throw new Error('expected ok:true');
  if (result.action !== 'drive_created_run') throw new Error(`expected drive_created_run, got ${result.action}`);

  const v = validateAgainstSchema(result, driveSchema);
  if (!v.ok) throw new Error(`schema validation failed: ${v.details.join('; ')}`);
});

// -------------------------------------------------------------------------
// Test 8: Backlog item updated after drive
// -------------------------------------------------------------------------
console.log('\n--- backlog update ---');

test('backlog item gets last_summary after drive', () => {
  const wsRoot = makeTempWorkspace('proj-summary', [
    { id: 'T-SUM', status: 'todo', priority: 'P0', title: 'Summary test' },
  ]);

  const result = projectDriveOnce({
    workspaceRoot: wsRoot,
    agentAdapter: makeScaffoldAdapter(),
    maxSteps: 3,
  });

  // Track created run folder for cleanup BEFORE any assertions
  if (result.run_folder) {
    createdRunDirs.push(path.resolve(wsRoot, result.run_folder));
  }

  if (!result.ok) throw new Error('expected ok:true');

  const backlogItem = JSON.parse(fs.readFileSync(
    path.join(wsRoot, '.claw', 'backlog', 'T-SUM.json'), 'utf8'
  ));
  if (!backlogItem.last_summary) throw new Error('expected last_summary to be set');
  if (typeof backlogItem.last_summary.steps_run !== 'number') throw new Error('missing steps_run in last_summary');
});

// -------------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------------
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
