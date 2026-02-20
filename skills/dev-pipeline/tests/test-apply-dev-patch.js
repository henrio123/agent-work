#!/usr/bin/env node
'use strict';

/**
 * Tests for apply-dev-patch.js — Apply 40-dev-patch.diff to workspace.
 * Run: node skills/dev-pipeline/tests/test-apply-dev-patch.js
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'apply-dev-patch.js');
const { applyDevPatch } = require(SCRIPT);
const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));

const outputSchema = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '..', 'schemas', 'apply-dev-patch.output.schema.json'), 'utf8'));

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

/**
 * Create a temp workspace that is a git repo with one committed file,
 * a .claw/runs/<runName>/ folder, and a 40-dev-patch.diff inside it.
 */
function makeTempWorkspace(runName, patchContent) {
  const wsRoot = path.join(os.tmpdir(), `_test_adp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(wsRoot, { recursive: true });
  tmpDirs.push(wsRoot);

  // Init git repo with an initial commit
  execFileSync('git', ['init'], { cwd: wsRoot, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: wsRoot, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: wsRoot, stdio: 'pipe' });

  // Create a file and commit it
  fs.writeFileSync(path.join(wsRoot, 'hello.txt'), 'hello world\n', 'utf8');
  execFileSync('git', ['add', '.'], { cwd: wsRoot, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: wsRoot, stdio: 'pipe' });

  // Create .claw/runs/<runName>/
  const runFolder = `.claw/runs/${runName}`;
  const runDir = path.join(wsRoot, runFolder);
  fs.mkdirSync(runDir, { recursive: true });

  // Write patch file if provided
  if (patchContent !== undefined) {
    fs.writeFileSync(path.join(runDir, '40-dev-patch.diff'), patchContent, 'utf8');
  }

  return { wsRoot, runFolder, runDir };
}

/**
 * Generate a valid unified diff that changes hello.txt content.
 */
function makeValidPatch() {
  return [
    'diff --git a/hello.txt b/hello.txt',
    'index 3b18e51..f195027 100644',
    '--- a/hello.txt',
    '+++ b/hello.txt',
    '@@ -1 +1 @@',
    '-hello world',
    '+hello patched world',
    '',
  ].join('\n');
}

/**
 * Generate a valid unified diff that adds a new file.
 */
function makeNewFilePatch() {
  return [
    'diff --git a/newfile.txt b/newfile.txt',
    'new file mode 100644',
    'index 0000000..5716ca5',
    '--- /dev/null',
    '+++ b/newfile.txt',
    '@@ -0,0 +1 @@',
    '+brand new file',
    '',
  ].join('\n');
}

function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
process.on('exit', cleanup);

// -------------------------------------------------------------------------
// 1. Missing runFolder
// -------------------------------------------------------------------------
console.log('\n--- validation ---');

test('rejects missing runFolder', () => {
  const result = applyDevPatch({}, { workspaceRoot: '/tmp' });
  assert(result.ok === false, 'should fail');
  assert(result.error.includes('runFolder is required'), `error: ${result.error}`);
});

test('rejects absolute path', () => {
  const result = applyDevPatch({ runFolder: '/etc/passwd' }, { workspaceRoot: '/tmp' });
  assert(result.ok === false, 'should fail');
  assert(result.error.includes('absolute paths not allowed'), `error: ${result.error}`);
});

test('rejects path not under .claw/runs/', () => {
  const result = applyDevPatch({ runFolder: 'runs/foo' }, { workspaceRoot: '/tmp' });
  assert(result.ok === false, 'should fail');
  assert(result.error.includes('must start with .claw/runs/'), `error: ${result.error}`);
});

test('rejects path traversal', () => {
  const result = applyDevPatch({ runFolder: '.claw/runs/../../etc' }, { workspaceRoot: '/tmp' });
  assert(result.ok === false, 'should fail');
  assert(result.error.includes('path traversal'), `error: ${result.error}`);
});

test('rejects non-existent run folder', () => {
  const wsRoot = path.join(os.tmpdir(), `_test_adp_ne_${Date.now()}`);
  fs.mkdirSync(wsRoot, { recursive: true });
  tmpDirs.push(wsRoot);
  const result = applyDevPatch({ runFolder: '.claw/runs/nonexistent' }, { workspaceRoot: wsRoot });
  assert(result.ok === false, 'should fail');
  assert(result.error.includes('does not exist'), `error: ${result.error}`);
});

// -------------------------------------------------------------------------
// 2. Missing/empty patch
// -------------------------------------------------------------------------
console.log('\n--- patch validation ---');

test('rejects missing 40-dev-patch.diff', () => {
  const { wsRoot, runFolder } = makeTempWorkspace('run-no-patch');
  // No patch file written
  const result = applyDevPatch({ runFolder }, { workspaceRoot: wsRoot });
  assert(result.ok === false, 'should fail');
  assert(result.error.includes('not found'), `error: ${result.error}`);
});

test('rejects empty 40-dev-patch.diff', () => {
  const { wsRoot, runFolder } = makeTempWorkspace('run-empty-patch', '');
  const result = applyDevPatch({ runFolder }, { workspaceRoot: wsRoot });
  assert(result.ok === false, 'should fail');
  assert(result.error.includes('empty'), `error: ${result.error}`);
});

test('rejects whitespace-only 40-dev-patch.diff', () => {
  const { wsRoot, runFolder } = makeTempWorkspace('run-ws-patch', '   \n  \n');
  const result = applyDevPatch({ runFolder }, { workspaceRoot: wsRoot });
  assert(result.ok === false, 'should fail');
  assert(result.error.includes('empty'), `error: ${result.error}`);
});

// -------------------------------------------------------------------------
// 3. Dry run
// -------------------------------------------------------------------------
console.log('\n--- dry run ---');

test('dry run succeeds with valid patch (does not modify files)', () => {
  const { wsRoot, runFolder } = makeTempWorkspace('run-dry', makeValidPatch());
  const result = applyDevPatch({ runFolder }, { workspaceRoot: wsRoot, dryRun: true });
  assert(result.ok === true, `should succeed: ${result.error}`);
  assert(result.action === 'dry_run_passed', `action: ${result.action}`);
  assert(result.dry_run === true, 'dry_run flag should be true');
  assert(result.files_changed.includes('hello.txt'), 'should list hello.txt');
  // File should NOT be modified
  const content = fs.readFileSync(path.join(wsRoot, 'hello.txt'), 'utf8');
  assert(content === 'hello world\n', 'file should be unchanged after dry run');
});

test('dry run fails with invalid patch', () => {
  const { wsRoot, runFolder } = makeTempWorkspace('run-dry-bad', 'not a valid diff\n');
  const result = applyDevPatch({ runFolder }, { workspaceRoot: wsRoot, dryRun: true });
  assert(result.ok === false, 'should fail');
  assert(result.error.includes('git apply failed'), `error: ${result.error}`);
  assert(result.dry_run === true, 'dry_run should be true');
});

// -------------------------------------------------------------------------
// 4. Actual apply
// -------------------------------------------------------------------------
console.log('\n--- apply ---');

test('applies valid patch to modify existing file', () => {
  const { wsRoot, runFolder } = makeTempWorkspace('run-apply', makeValidPatch());
  const result = applyDevPatch({ runFolder }, { workspaceRoot: wsRoot });
  assert(result.ok === true, `should succeed: ${result.error}`);
  assert(result.action === 'applied', `action: ${result.action}`);
  assert(result.dry_run === false, 'dry_run should be false');
  assert(result.files_changed.includes('hello.txt'), 'should list hello.txt');
  // Verify file was changed
  const content = fs.readFileSync(path.join(wsRoot, 'hello.txt'), 'utf8');
  assert(content.includes('patched'), `file should contain "patched": ${content}`);
});

test('applies patch that adds new file', () => {
  const { wsRoot, runFolder } = makeTempWorkspace('run-newfile', makeNewFilePatch());
  const result = applyDevPatch({ runFolder }, { workspaceRoot: wsRoot });
  assert(result.ok === true, `should succeed: ${result.error}`);
  assert(result.action === 'applied', `action: ${result.action}`);
  assert(result.files_changed.includes('newfile.txt'), 'should list newfile.txt');
  // Verify new file exists
  const content = fs.readFileSync(path.join(wsRoot, 'newfile.txt'), 'utf8');
  assert(content.includes('brand new file'), `new file content: ${content}`);
});

test('applies multi-file patch', () => {
  const multiPatch = makeValidPatch() + makeNewFilePatch();
  const { wsRoot, runFolder } = makeTempWorkspace('run-multi', multiPatch);
  const result = applyDevPatch({ runFolder }, { workspaceRoot: wsRoot });
  assert(result.ok === true, `should succeed: ${result.error}`);
  assert(result.files_changed.length === 2, `should have 2 files, got ${result.files_changed.length}`);
  assert(result.files_changed.includes('hello.txt'), 'should list hello.txt');
  assert(result.files_changed.includes('newfile.txt'), 'should list newfile.txt');
});

test('rejects patch that conflicts with current state', () => {
  const { wsRoot, runFolder } = makeTempWorkspace('run-conflict', makeValidPatch());
  // Modify hello.txt so the patch won't apply cleanly
  fs.writeFileSync(path.join(wsRoot, 'hello.txt'), 'totally different content\n', 'utf8');
  const result = applyDevPatch({ runFolder }, { workspaceRoot: wsRoot });
  assert(result.ok === false, 'should fail');
  assert(result.error.includes('git apply failed'), `error: ${result.error}`);
});

// -------------------------------------------------------------------------
// 5. Schema validation
// -------------------------------------------------------------------------
console.log('\n--- schema ---');

test('success output validates against schema', () => {
  const { wsRoot, runFolder } = makeTempWorkspace('run-schema-ok', makeValidPatch());
  const result = applyDevPatch({ runFolder }, { workspaceRoot: wsRoot });
  assert(result.ok === true, `should succeed: ${result.error}`);
  const v = validateAgainstSchema(result, outputSchema);
  assert(v.ok, `schema validation failed: ${(v.details || []).join('; ')}`);
});

test('error output validates against schema', () => {
  const result = applyDevPatch({}, { workspaceRoot: '/tmp' });
  assert(result.ok === false, 'should fail');
  const v = validateAgainstSchema(result, outputSchema);
  assert(v.ok, `schema validation failed: ${(v.details || []).join('; ')}`);
});

// -------------------------------------------------------------------------
// 6. CLI
// -------------------------------------------------------------------------
console.log('\n--- CLI ---');

test('CLI dry run outputs valid JSON', () => {
  const { wsRoot, runFolder } = makeTempWorkspace('run-cli-dry', makeValidPatch());
  const stdout = execFileSync('node', [SCRIPT, '--workspace', wsRoot, '--run_folder', runFolder, '--dry_run'], {
    encoding: 'utf8', timeout: 10000,
  });
  const parsed = JSON.parse(stdout);
  assert(parsed.ok === true, `CLI should succeed: ${parsed.error}`);
  assert(parsed.action === 'dry_run_passed', `action: ${parsed.action}`);
});

test('CLI apply outputs valid JSON', () => {
  const { wsRoot, runFolder } = makeTempWorkspace('run-cli-apply', makeValidPatch());
  const stdout = execFileSync('node', [SCRIPT, '--workspace', wsRoot, '--run_folder', runFolder], {
    encoding: 'utf8', timeout: 10000,
  });
  const parsed = JSON.parse(stdout);
  assert(parsed.ok === true, `CLI should succeed: ${parsed.error}`);
  assert(parsed.action === 'applied', `action: ${parsed.action}`);
});

test('CLI exits 1 on error', () => {
  let exitedNonZero = false;
  try {
    execFileSync('node', [SCRIPT, '--workspace', '/tmp', '--run_folder', '.claw/runs/nope'], {
      encoding: 'utf8', stdio: 'pipe', timeout: 10000,
    });
  } catch (e) {
    exitedNonZero = true;
    assert(e.status === 1, 'should exit 1');
  }
  assert(exitedNonZero, 'should have failed');
});

// -------------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------------
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
