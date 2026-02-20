#!/usr/bin/env node
'use strict';

/**
 * Tests for init-workspace.js — Bootstrap .claw/ in a target repo.
 * Run: node skills/dev-pipeline/tests/test-init-workspace.js
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'init-workspace.js');
const SHELL = path.join(WORKSPACE_ROOT, 'tools', 'init-workspace.sh');

const { initWorkspace } = require(SCRIPT);
const wp = require(path.resolve(__dirname, '..', 'scripts', 'workspace-paths.js'));
const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));

const projectSchema = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'project.schema.json'), 'utf8'));
const agentsSchema = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'agents.schema.json'), 'utf8'));

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
  const dir = path.join(os.tmpdir(), `_test_init_ws_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
process.on('exit', cleanup);

// -------------------------------------------------------------------------
// workspace-paths.js
// -------------------------------------------------------------------------
console.log('\n--- workspace-paths ---');

test('resolve returns all expected paths', () => {
  const paths = wp.resolve('/tmp/test-repo');
  assert(paths.root === '/tmp/test-repo/.claw', `root: ${paths.root}`);
  assert(paths.backlog === '/tmp/test-repo/.claw/backlog', `backlog: ${paths.backlog}`);
  assert(paths.runs === '/tmp/test-repo/.claw/runs', `runs: ${paths.runs}`);
  assert(paths.tickets === '/tmp/test-repo/.claw/tickets', `tickets: ${paths.tickets}`);
  assert(paths.taskPacks === '/tmp/test-repo/.claw/task-packs', `taskPacks: ${paths.taskPacks}`);
  assert(paths.artifacts === '/tmp/test-repo/.claw/artifacts', `artifacts: ${paths.artifacts}`);
  assert(paths.agents === '/tmp/test-repo/.claw/agents', `agents: ${paths.agents}`);
  assert(paths.project === '/tmp/test-repo/.claw/project.json', `project: ${paths.project}`);
  assert(paths.agentsConfig === '/tmp/test-repo/.claw/agents.json', `agentsConfig: ${paths.agentsConfig}`);
});

test('subdirs returns 6 directories', () => {
  const dirs = wp.subdirs();
  assert(dirs.length === 6, `expected 6, got ${dirs.length}`);
  assert(dirs.includes('backlog'), 'missing backlog');
  assert(dirs.includes('runs'), 'missing runs');
  assert(dirs.includes('tickets'), 'missing tickets');
  assert(dirs.includes('task-packs'), 'missing task-packs');
  assert(dirs.includes('artifacts'), 'missing artifacts');
  assert(dirs.includes('agents'), 'missing agents');
});

test('safePath rejects traversal', () => {
  let threw = false;
  try { wp.safePath('../../etc/passwd', '/tmp/test-repo'); } catch { threw = true; }
  assert(threw, 'should throw on traversal');
});

test('safePath allows paths inside workspace', () => {
  const p = wp.safePath('.claw/backlog', '/tmp/test-repo');
  assert(p === '/tmp/test-repo/.claw/backlog', `got: ${p}`);
});

// -------------------------------------------------------------------------
// init-workspace: happy path
// -------------------------------------------------------------------------
console.log('\n--- init-workspace: happy path ---');

test('creates .claw/ with all subdirectories', () => {
  const wsRoot = makeTempDir();
  const result = initWorkspace({ workspaceRoot: wsRoot, projectId: 'test-proj', title: 'Test Project' });
  assert(result.ok === true, `expected ok, got: ${JSON.stringify(result)}`);
  assert(result.action === 'initialized', `action: ${result.action}`);
  assert(result.project_id === 'test-proj', `project_id: ${result.project_id}`);

  // Verify directories
  const paths = wp.resolve(wsRoot);
  for (const sub of wp.subdirs()) {
    const dir = path.join(paths.root, sub);
    assert(fs.existsSync(dir), `missing dir: ${sub}`);
    assert(fs.statSync(dir).isDirectory(), `not a dir: ${sub}`);
  }
});

test('project.json validates against schema', () => {
  const wsRoot = makeTempDir();
  initWorkspace({ workspaceRoot: wsRoot, projectId: 'schema-test', title: 'Schema Test', description: 'desc' });
  const paths = wp.resolve(wsRoot);
  const data = JSON.parse(fs.readFileSync(paths.project, 'utf8'));
  const v = validateAgainstSchema(data, projectSchema);
  assert(v.ok, `project.json schema failed: ${(v.details || []).join('; ')}`);
  assert(data.project_id === 'schema-test', 'wrong project_id');
  assert(data.title === 'Schema Test', 'wrong title');
  assert(data.description === 'desc', 'wrong description');
  assert(data.repo_path === wsRoot, 'wrong repo_path');
});

test('agents.json validates against schema', () => {
  const wsRoot = makeTempDir();
  initWorkspace({ workspaceRoot: wsRoot, projectId: 'agents-test', title: 'Agents Test' });
  const paths = wp.resolve(wsRoot);
  const data = JSON.parse(fs.readFileSync(paths.agentsConfig, 'utf8'));
  const v = validateAgainstSchema(data, agentsSchema);
  assert(v.ok, `agents.json schema failed: ${(v.details || []).join('; ')}`);
  assert(Array.isArray(data.agents), 'agents should be array');
  assert(data.agents.length === 0, 'agents should be empty');
});

test('description defaults to empty string', () => {
  const wsRoot = makeTempDir();
  initWorkspace({ workspaceRoot: wsRoot, projectId: 'no-desc', title: 'No Desc' });
  const paths = wp.resolve(wsRoot);
  const data = JSON.parse(fs.readFileSync(paths.project, 'utf8'));
  assert(data.description === '', `description should be empty, got: ${data.description}`);
});

test('created_dirs includes root and all subdirs', () => {
  const wsRoot = makeTempDir();
  const result = initWorkspace({ workspaceRoot: wsRoot, projectId: 'dirs-test', title: 'Dirs' });
  // root + 6 subdirs = 7
  assert(result.created_dirs.length === 7, `expected 7 dirs, got ${result.created_dirs.length}`);
});

test('files_written includes project.json and agents.json', () => {
  const wsRoot = makeTempDir();
  const result = initWorkspace({ workspaceRoot: wsRoot, projectId: 'files-test', title: 'Files' });
  assert(result.files_written.length === 2, `expected 2 files, got ${result.files_written.length}`);
  assert(result.files_written.some(f => f.endsWith('project.json')), 'missing project.json');
  assert(result.files_written.some(f => f.endsWith('agents.json')), 'missing agents.json');
});

// -------------------------------------------------------------------------
// init-workspace: conflict detection
// -------------------------------------------------------------------------
console.log('\n--- init-workspace: conflicts ---');

test('rejects re-initialization of existing .claw/', () => {
  const wsRoot = makeTempDir();
  const r1 = initWorkspace({ workspaceRoot: wsRoot, projectId: 'dup', title: 'First' });
  assert(r1.ok === true, 'first init should succeed');
  const r2 = initWorkspace({ workspaceRoot: wsRoot, projectId: 'dup', title: 'Second' });
  assert(r2.ok === false, 'second init should fail');
  assert(r2.error.includes('already initialized'), `error: ${r2.error}`);
});

// -------------------------------------------------------------------------
// init-workspace: validation errors
// -------------------------------------------------------------------------
console.log('\n--- init-workspace: validation ---');

test('rejects missing workspaceRoot', () => {
  const result = initWorkspace({ projectId: 'x', title: 'x' });
  assert(result.ok === false, 'should fail');
  assert(result.error.includes('workspaceRoot'), `error: ${result.error}`);
});

test('rejects missing projectId', () => {
  const wsRoot = makeTempDir();
  const result = initWorkspace({ workspaceRoot: wsRoot, title: 'x' });
  assert(result.ok === false, 'should fail');
  assert(result.error.includes('projectId'), `error: ${result.error}`);
});

test('rejects missing title', () => {
  const wsRoot = makeTempDir();
  const result = initWorkspace({ workspaceRoot: wsRoot, projectId: 'x' });
  assert(result.ok === false, 'should fail');
  assert(result.error.includes('title'), `error: ${result.error}`);
});

test('rejects non-existent workspace root', () => {
  const result = initWorkspace({ workspaceRoot: '/tmp/nonexistent-xyz-999', projectId: 'x', title: 'x' });
  assert(result.ok === false, 'should fail');
  assert(result.error.includes('does not exist'), `error: ${result.error}`);
});

// -------------------------------------------------------------------------
// CLI
// -------------------------------------------------------------------------
console.log('\n--- CLI ---');

test('CLI initializes workspace and outputs JSON', () => {
  const wsRoot = makeTempDir();
  const stdout = execFileSync('node', [
    SCRIPT, '--workspace', wsRoot, '--project_id', 'cli-proj', '--title', 'CLI Project',
  ], { encoding: 'utf8', timeout: 10000 });
  const parsed = JSON.parse(stdout);
  assert(parsed.ok === true, 'should succeed');
  assert(parsed.project_id === 'cli-proj', `project_id: ${parsed.project_id}`);
  assert(fs.existsSync(path.join(wsRoot, '.claw', 'project.json')), 'project.json missing');
});

test('CLI exits 1 on missing args', () => {
  let exitedNonZero = false;
  try {
    execFileSync('node', [SCRIPT], { encoding: 'utf8', stdio: 'pipe', timeout: 10000 });
  } catch (e) {
    exitedNonZero = true;
    assert(e.status === 1, 'should exit 1');
  }
  assert(exitedNonZero, 'should have failed');
});

test('CLI exits 1 on duplicate init', () => {
  const wsRoot = makeTempDir();
  execFileSync('node', [SCRIPT, '--workspace', wsRoot, '--project_id', 'dup2', '--title', 'Dup'], {
    encoding: 'utf8', timeout: 10000,
  });
  let exitedNonZero = false;
  try {
    execFileSync('node', [SCRIPT, '--workspace', wsRoot, '--project_id', 'dup2', '--title', 'Dup Again'], {
      encoding: 'utf8', stdio: 'pipe', timeout: 10000,
    });
  } catch (e) {
    exitedNonZero = true;
    assert(e.status === 1, 'should exit 1');
  }
  assert(exitedNonZero, 'should have failed');
});

test('shell wrapper works', () => {
  const wsRoot = makeTempDir();
  const stdout = execFileSync('bash', [
    SHELL, '--workspace', wsRoot, '--project_id', 'sh-proj', '--title', 'Shell',
  ], { encoding: 'utf8', timeout: 10000 });
  const parsed = JSON.parse(stdout);
  assert(parsed.ok === true, 'should succeed');
  assert(parsed.project_id === 'sh-proj', `project_id: ${parsed.project_id}`);
});

// -------------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------------
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
