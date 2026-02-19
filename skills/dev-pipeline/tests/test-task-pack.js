#!/usr/bin/env node
'use strict';

/**
 * Tests for task-pack-generate.js — deterministic task pack generator.
 * Run: node skills/dev-pipeline/tests/test-task-pack.js
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = path.resolve(os.homedir(), 'dev', 'agent-work');
const GEN_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'task-pack-generate.js');
const GEN_SHELL = path.join(WORKSPACE_ROOT, 'tools', 'task-pack-generate.sh');
const VALIDATE_SHELL = path.join(WORKSPACE_ROOT, 'tools', 'task-pack-validate.sh');
const LIST_SHELL = path.join(WORKSPACE_ROOT, 'tools', 'task-pack-list.sh');

const { generateTaskPack, validateTaskPack, listTaskPacks } = require(GEN_SCRIPT);
const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));
const taskPackSchema = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'task-pack.schema.json'), 'utf8'));

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
  const dir = path.join(os.tmpdir(), `_test_tpack_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function makeProject(workspaceRoot, projectId, backlogItems = [], opts = {}) {
  const projectsDir = path.join(workspaceRoot, 'projects');
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

  if (opts.agents) {
    fs.writeFileSync(path.join(projectDir, 'agents.json'), JSON.stringify({ agents: opts.agents }, null, 2), 'utf8');
  }

  if (backlogItems.length > 0) {
    const backlogDir = path.join(projectDir, 'backlog');
    fs.mkdirSync(backlogDir, { recursive: true });
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
// Test 1: Basic generation
// -------------------------------------------------------------------------
console.log('\n--- basic generation ---');

test('generates task pack for backlog item', () => {
  const wsRoot = makeTempDir();
  makeProject(wsRoot, 'proj-gen', [
    { id: 'T-GEN', status: 'todo', title: 'Generate test', description: 'A test task' },
  ]);

  const result = generateTaskPack('proj-gen', 'T-GEN', {
    workspaceRoot: wsRoot,
    projectsDir: path.join(wsRoot, 'projects'),
  });
  if (!result.ok) throw new Error('expected ok:true, got: ' + JSON.stringify(result));
  if (!result.task_pack) throw new Error('missing task_pack');
  if (result.task_pack.task_id !== 'T-GEN') throw new Error('wrong task_id');
  if (result.task_pack.project_id !== 'proj-gen') throw new Error('wrong project_id');
});

test('generates file on disk', () => {
  const wsRoot = makeTempDir();
  makeProject(wsRoot, 'proj-file', [
    { id: 'T-FILE', status: 'todo', title: 'File test' },
  ]);

  const result = generateTaskPack('proj-file', 'T-FILE', {
    workspaceRoot: wsRoot,
    projectsDir: path.join(wsRoot, 'projects'),
  });
  if (!result.ok) throw new Error('expected ok:true');
  const absPath = path.join(wsRoot, result.task_pack_path);
  if (!fs.existsSync(absPath)) throw new Error('task pack file not created');
  const data = JSON.parse(fs.readFileSync(absPath, 'utf8'));
  if (data.task_id !== 'T-FILE') throw new Error('wrong task_id on disk');
});

test('generated task pack validates against schema', () => {
  const wsRoot = makeTempDir();
  makeProject(wsRoot, 'proj-sv', [
    { id: 'T-SV', status: 'todo', title: 'Schema test', description: 'desc' },
  ]);

  const result = generateTaskPack('proj-sv', 'T-SV', {
    workspaceRoot: wsRoot,
    projectsDir: path.join(wsRoot, 'projects'),
  });
  if (!result.ok) throw new Error('expected ok:true');
  const v = validateAgainstSchema(result.task_pack, taskPackSchema);
  if (!v.ok) throw new Error(`schema validation failed: ${v.details.join('; ')}`);
});

// -------------------------------------------------------------------------
// Test 2: Inputs inference
// -------------------------------------------------------------------------
console.log('\n--- inputs inference ---');

test('includes project.json in inputs_present', () => {
  const wsRoot = makeTempDir();
  makeProject(wsRoot, 'proj-inp', [
    { id: 'T-INP', status: 'todo' },
  ]);

  const result = generateTaskPack('proj-inp', 'T-INP', {
    workspaceRoot: wsRoot,
    projectsDir: path.join(wsRoot, 'projects'),
  });
  if (!result.task_pack.inputs_present.includes('project.json')) throw new Error('missing project.json');
});

test('includes agents.json in inputs_present when present', () => {
  const wsRoot = makeTempDir();
  makeProject(wsRoot, 'proj-agents', [
    { id: 'T-AG', status: 'todo' },
  ], {
    agents: [{ role_name: 'PM', goal: 'Plan', allowed_actions: [], required_outputs: [], handoff_contract: '' }],
  });

  const result = generateTaskPack('proj-agents', 'T-AG', {
    workspaceRoot: wsRoot,
    projectsDir: path.join(wsRoot, 'projects'),
  });
  if (!result.task_pack.inputs_present.includes('agents.json')) throw new Error('missing agents.json');
});

test('adds open_question when agents.json missing', () => {
  const wsRoot = makeTempDir();
  makeProject(wsRoot, 'proj-noag', [
    { id: 'T-NOAG', status: 'todo' },
  ]);

  const result = generateTaskPack('proj-noag', 'T-NOAG', {
    workspaceRoot: wsRoot,
    projectsDir: path.join(wsRoot, 'projects'),
  });
  const hasAgentQ = result.task_pack.open_questions.some((q) => q.includes('agents.json'));
  if (!hasAgentQ) throw new Error('expected open question about agents.json');
});

test('adds open_question for empty description', () => {
  const wsRoot = makeTempDir();
  makeProject(wsRoot, 'proj-nodesc', [
    { id: 'T-NODESC', status: 'todo', description: '' },
  ]);

  const result = generateTaskPack('proj-nodesc', 'T-NODESC', {
    workspaceRoot: wsRoot,
    projectsDir: path.join(wsRoot, 'projects'),
  });
  const hasDescQ = result.task_pack.open_questions.some((q) => q.includes('description'));
  if (!hasDescQ) throw new Error('expected open question about description');
});

// -------------------------------------------------------------------------
// Test 3: Run folder scanning
// -------------------------------------------------------------------------
console.log('\n--- run folder scanning ---');

test('scans linked run folder for artifacts', () => {
  const wsRoot = makeTempDir();
  const runsDir = path.join(wsRoot, 'runs', 'test_run');
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(path.join(runsDir, 'status.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(runsDir, '00-intake.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(runsDir, '10-pm-brief.json'), '{}', 'utf8');

  makeProject(wsRoot, 'proj-run', [
    { id: 'T-RUN', status: 'in_progress', run_folder: 'runs/test_run' },
  ]);

  const result = generateTaskPack('proj-run', 'T-RUN', {
    workspaceRoot: wsRoot,
    projectsDir: path.join(wsRoot, 'projects'),
  });
  if (!result.ok) throw new Error('expected ok:true');
  const hasRunRef = result.task_pack.inputs_present.some((i) => i.includes('runs/test_run'));
  if (!hasRunRef) throw new Error('expected run folder in inputs_present');
  const hasPmBrief = result.task_pack.inputs_present.some((i) => i.includes('10-pm-brief.json'));
  if (!hasPmBrief) throw new Error('expected 10-pm-brief.json in inputs');
});

// -------------------------------------------------------------------------
// Test 4: Dependency checking
// -------------------------------------------------------------------------
console.log('\n--- dependency checking ---');

test('adds open_question for unfinished dependency', () => {
  const wsRoot = makeTempDir();
  makeProject(wsRoot, 'proj-dep', [
    { id: 'T-DEP', status: 'todo' },
    { id: 'T-CHILD', status: 'todo', depends_on: ['T-DEP'] },
  ]);

  const result = generateTaskPack('proj-dep', 'T-CHILD', {
    workspaceRoot: wsRoot,
    projectsDir: path.join(wsRoot, 'projects'),
  });
  const hasDepQ = result.task_pack.open_questions.some((q) => q.includes('T-DEP'));
  if (!hasDepQ) throw new Error('expected open question about dependency T-DEP');
});

test('no open_question for finished dependency', () => {
  const wsRoot = makeTempDir();
  makeProject(wsRoot, 'proj-dep-done', [
    { id: 'T-DEP-DONE', status: 'done' },
    { id: 'T-CHILD2', status: 'todo', depends_on: ['T-DEP-DONE'] },
  ]);

  const result = generateTaskPack('proj-dep-done', 'T-CHILD2', {
    workspaceRoot: wsRoot,
    projectsDir: path.join(wsRoot, 'projects'),
  });
  const hasDepQ = result.task_pack.open_questions.some((q) => q.includes('T-DEP-DONE'));
  if (hasDepQ) throw new Error('should not have open question for done dependency');
});

// -------------------------------------------------------------------------
// Test 5: Error cases
// -------------------------------------------------------------------------
console.log('\n--- error cases ---');

test('returns error for non-existent project', () => {
  const wsRoot = makeTempDir();
  fs.mkdirSync(path.join(wsRoot, 'projects'), { recursive: true });
  const result = generateTaskPack('non-existent', 'T-X', {
    workspaceRoot: wsRoot,
    projectsDir: path.join(wsRoot, 'projects'),
  });
  if (result.ok) throw new Error('expected ok:false');
  if (!result.error.includes('does not exist')) throw new Error('wrong error');
});

test('returns error for non-existent task', () => {
  const wsRoot = makeTempDir();
  makeProject(wsRoot, 'proj-missing', []);
  const result = generateTaskPack('proj-missing', 'T-MISSING', {
    workspaceRoot: wsRoot,
    projectsDir: path.join(wsRoot, 'projects'),
  });
  if (result.ok) throw new Error('expected ok:false');
  if (!result.error.includes('not found')) throw new Error('wrong error');
});

// -------------------------------------------------------------------------
// Test 6: Validate function
// -------------------------------------------------------------------------
console.log('\n--- validate ---');

test('validates a valid task pack', () => {
  const wsRoot = makeTempDir();
  makeProject(wsRoot, 'proj-val', [
    { id: 'T-VAL', status: 'todo' },
  ]);

  const gen = generateTaskPack('proj-val', 'T-VAL', {
    workspaceRoot: wsRoot,
    projectsDir: path.join(wsRoot, 'projects'),
  });
  if (!gen.ok) throw new Error('generation failed');

  const result = validateTaskPack(gen.task_pack);
  if (!result.ok) throw new Error(`validation failed: ${result.details?.join('; ')}`);
});

test('validates from file path', () => {
  const wsRoot = makeTempDir();
  makeProject(wsRoot, 'proj-vfp', [
    { id: 'T-VFP', status: 'todo' },
  ]);

  const gen = generateTaskPack('proj-vfp', 'T-VFP', {
    workspaceRoot: wsRoot,
    projectsDir: path.join(wsRoot, 'projects'),
  });
  if (!gen.ok) throw new Error('generation failed');

  const result = validateTaskPack(gen.task_pack_path, { workspaceRoot: wsRoot });
  if (!result.ok) throw new Error(`validation failed: ${result.details?.join('; ')}`);
});

test('returns error for missing file', () => {
  const result = validateTaskPack('/tmp/_nonexistent_task_pack.json');
  if (result.ok) throw new Error('expected ok:false');
  if (!result.error.includes('not found')) throw new Error('wrong error: ' + result.error);
});

// -------------------------------------------------------------------------
// Test 7: List function
// -------------------------------------------------------------------------
console.log('\n--- list ---');

test('lists task packs across projects', () => {
  const wsRoot = makeTempDir();
  makeProject(wsRoot, 'proj-list1', [{ id: 'T-L1' }]);
  makeProject(wsRoot, 'proj-list2', [{ id: 'T-L2' }]);

  generateTaskPack('proj-list1', 'T-L1', {
    workspaceRoot: wsRoot, projectsDir: path.join(wsRoot, 'projects'),
  });
  generateTaskPack('proj-list2', 'T-L2', {
    workspaceRoot: wsRoot, projectsDir: path.join(wsRoot, 'projects'),
  });

  const result = listTaskPacks({
    workspaceRoot: wsRoot,
    projectsDir: path.join(wsRoot, 'projects'),
  });
  if (!result.ok) throw new Error('expected ok:true');
  if (result.task_packs.length !== 2) throw new Error(`expected 2 packs, got ${result.task_packs.length}`);
});

test('filters by project_id', () => {
  const wsRoot = makeTempDir();
  makeProject(wsRoot, 'proj-filt1', [{ id: 'T-F1' }]);
  makeProject(wsRoot, 'proj-filt2', [{ id: 'T-F2' }]);

  generateTaskPack('proj-filt1', 'T-F1', {
    workspaceRoot: wsRoot, projectsDir: path.join(wsRoot, 'projects'),
  });
  generateTaskPack('proj-filt2', 'T-F2', {
    workspaceRoot: wsRoot, projectsDir: path.join(wsRoot, 'projects'),
  });

  const result = listTaskPacks({
    workspaceRoot: wsRoot,
    projectsDir: path.join(wsRoot, 'projects'),
    projectId: 'proj-filt1',
  });
  if (result.task_packs.length !== 1) throw new Error(`expected 1 pack, got ${result.task_packs.length}`);
  if (result.task_packs[0].project_id !== 'proj-filt1') throw new Error('wrong project');
});

test('returns empty when no task packs exist', () => {
  const wsRoot = makeTempDir();
  makeProject(wsRoot, 'proj-empty', []);
  const result = listTaskPacks({
    workspaceRoot: wsRoot,
    projectsDir: path.join(wsRoot, 'projects'),
  });
  if (result.task_packs.length !== 0) throw new Error('expected 0 packs');
});

// -------------------------------------------------------------------------
// Test 8: CLI
// -------------------------------------------------------------------------
console.log('\n--- CLI ---');

test('CLI list outputs valid JSON', () => {
  const listStdout = execFileSync('node', [GEN_SCRIPT, 'list'], { encoding: 'utf8', timeout: 10000 });
  const parsed = JSON.parse(listStdout);
  if (!parsed.ok) throw new Error('expected ok:true');
  if (!Array.isArray(parsed.task_packs)) throw new Error('expected task_packs array');
});

test('CLI generate exits 1 for non-existent project', () => {
  try {
    execFileSync('node', [GEN_SCRIPT, '_nonexistent_proj_xyz', 'T-X'], {
      encoding: 'utf8', timeout: 10000,
    });
    throw new Error('expected non-zero exit');
  } catch (e) {
    if (e.message === 'expected non-zero exit') throw e;
    if (e.status !== 1) throw new Error(`expected exit 1, got ${e.status}`);
    const stderr = e.stderr || '';
    if (!stderr.includes('does not exist')) throw new Error('wrong error message');
  }
});

test('CLI validate exits 1 for missing file', () => {
  try {
    execFileSync('node', [GEN_SCRIPT, 'validate', '/tmp/_nonexistent.json'], {
      encoding: 'utf8', timeout: 10000,
    });
    throw new Error('expected non-zero exit');
  } catch (e) {
    if (e.message === 'expected non-zero exit') throw e;
    if (e.status !== 1) throw new Error(`expected exit 1, got ${e.status}`);
  }
});

test('shell wrappers are executable', () => {
  // task-pack-list.sh
  const listStdout = execFileSync('bash', [LIST_SHELL], { encoding: 'utf8', timeout: 10000 });
  const parsed = JSON.parse(listStdout);
  if (!parsed.ok) throw new Error('list shell wrapper failed');

  // task-pack-validate.sh exits 1 for missing
  try {
    execFileSync('bash', [VALIDATE_SHELL, '/tmp/_nonexistent.json'], {
      encoding: 'utf8', timeout: 10000,
    });
    throw new Error('expected non-zero exit');
  } catch (e) {
    if (e.message === 'expected non-zero exit') throw e;
    if (e.status !== 1) throw new Error(`expected exit 1, got ${e.status}`);
  }
});

// -------------------------------------------------------------------------
// Test 9: Integration — picker and task pack
// -------------------------------------------------------------------------
console.log('\n--- picker integration ---');

const { pickNextTask, classifyTask } = require(path.resolve(__dirname, '..', 'scripts', 'project-next-pick.js'));

test('classifyTask returns needs_task_pack when no task pack exists', () => {
  const wsRoot = makeTempDir();
  fs.mkdirSync(path.join(wsRoot, 'projects', 'proj-cls', 'backlog'), { recursive: true });

  const entry = { id: 'T-CLS', status: 'todo', blocked: false, stop_signal: false, run_folder: null, project_id: 'proj-cls' };
  const result = classifyTask(entry, wsRoot, 'proj-cls');
  if (result !== 'needs_task_pack') throw new Error(`expected needs_task_pack, got ${result}`);
});

test('classifyTask returns ready_for_run_creation when task pack exists', () => {
  const wsRoot = makeTempDir();
  const tpDir = path.join(wsRoot, 'projects', 'proj-rdy', 'task-packs');
  fs.mkdirSync(tpDir, { recursive: true });
  fs.writeFileSync(path.join(tpDir, 'T-RDY.json'), '{"task_id":"T-RDY"}', 'utf8');

  const entry = { id: 'T-RDY', status: 'todo', blocked: false, stop_signal: false, run_folder: null, project_id: 'proj-rdy' };
  const result = classifyTask(entry, wsRoot, 'proj-rdy');
  if (result !== 'ready_for_run_creation') throw new Error(`expected ready_for_run_creation, got ${result}`);
});

test('picker prefers ready_for_run_creation over needs_task_pack', () => {
  const wsRoot = makeTempDir();
  const projectsDir = path.join(wsRoot, 'projects');

  // proj-a has task pack → ready_for_run_creation
  makeProject(wsRoot, 'proj-a', [
    { id: 'T-READY', status: 'todo', priority: 'P2' },
  ]);
  const tpDir = path.join(projectsDir, 'proj-a', 'task-packs');
  fs.mkdirSync(tpDir, { recursive: true });
  fs.writeFileSync(path.join(tpDir, 'T-READY.json'), '{"task_id":"T-READY"}', 'utf8');

  // proj-b has no task pack → needs_task_pack
  makeProject(wsRoot, 'proj-b', [
    { id: 'T-NOPACK', status: 'todo', priority: 'P0' },
  ]);

  const result = pickNextTask({ projectsDir, workspaceRoot: wsRoot });
  if (!result.ok) throw new Error('expected ok:true');
  if (result.task_id !== 'T-READY') throw new Error(`expected T-READY (ready_for_run_creation), got ${result.task_id}`);
  if (result.priority_bucket !== 'ready_for_run_creation') throw new Error(`expected ready_for_run_creation, got ${result.priority_bucket}`);
});

// -------------------------------------------------------------------------
// Test 10: Integration — drive copies task pack
// -------------------------------------------------------------------------
console.log('\n--- drive integration ---');

const { copyTaskPackToRun } = require(path.resolve(__dirname, '..', 'scripts', 'project-next-drive.js'));

test('copyTaskPackToRun copies task pack into run folder', () => {
  const wsRoot = makeTempDir();
  const projectsDir = path.join(wsRoot, 'projects');
  makeProject(wsRoot, 'proj-copy', [
    { id: 'T-COPY', status: 'todo' },
  ]);
  const tpDir = path.join(projectsDir, 'proj-copy', 'task-packs');
  fs.mkdirSync(tpDir, { recursive: true });
  const taskPackData = { task_id: 'T-COPY', project_id: 'proj-copy', title: 'Copy test' };
  fs.writeFileSync(path.join(tpDir, 'T-COPY.json'), JSON.stringify(taskPackData), 'utf8');

  const runsDir = path.join(wsRoot, 'runs', 'test_copy_run');
  fs.mkdirSync(runsDir, { recursive: true });

  const result = copyTaskPackToRun('proj-copy', 'T-COPY', 'runs/test_copy_run', {
    workspaceRoot: wsRoot, projectsDir,
  });
  if (!result) throw new Error('expected true');

  const destPath = path.join(runsDir, '10-pm-brief.json');
  if (!fs.existsSync(destPath)) throw new Error('10-pm-brief.json not created in run');
  const copied = JSON.parse(fs.readFileSync(destPath, 'utf8'));
  if (copied.task_id !== 'T-COPY') throw new Error('wrong content in copied file');
});

test('copyTaskPackToRun does not overwrite existing 10-pm-brief.json', () => {
  const wsRoot = makeTempDir();
  const projectsDir = path.join(wsRoot, 'projects');
  makeProject(wsRoot, 'proj-noover', [
    { id: 'T-NOOVER', status: 'todo' },
  ]);
  const tpDir = path.join(projectsDir, 'proj-noover', 'task-packs');
  fs.mkdirSync(tpDir, { recursive: true });
  fs.writeFileSync(path.join(tpDir, 'T-NOOVER.json'), '{"task_id":"T-NOOVER","new":true}', 'utf8');

  const runsDir = path.join(wsRoot, 'runs', 'test_noover_run');
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(path.join(runsDir, '10-pm-brief.json'), '{"existing":true}', 'utf8');

  const result = copyTaskPackToRun('proj-noover', 'T-NOOVER', 'runs/test_noover_run', {
    workspaceRoot: wsRoot, projectsDir,
  });
  if (result) throw new Error('expected false (should not overwrite)');

  const existing = JSON.parse(fs.readFileSync(path.join(runsDir, '10-pm-brief.json'), 'utf8'));
  if (existing.new) throw new Error('file was overwritten');
});

test('copyTaskPackToRun returns false when no task pack exists', () => {
  const wsRoot = makeTempDir();
  const projectsDir = path.join(wsRoot, 'projects');
  makeProject(wsRoot, 'proj-notp', []);

  const runsDir = path.join(wsRoot, 'runs', 'test_notp_run');
  fs.mkdirSync(runsDir, { recursive: true });

  const result = copyTaskPackToRun('proj-notp', 'T-NOTP', 'runs/test_notp_run', {
    workspaceRoot: wsRoot, projectsDir,
  });
  if (result) throw new Error('expected false (no task pack)');
});

// -------------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------------
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
