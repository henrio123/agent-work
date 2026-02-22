#!/usr/bin/env node
'use strict';

/**
 * Tests for Phase 7 auto-commit (Epic 3).
 *
 * Covers:
 *   - autoCommit requires workspaceRoot
 *   - autoCommit requires patchApplied
 *   - autoCommit rejects when tests failed
 *   - autoCommit handles no changes gracefully
 *   - autoCommit creates commit with structured message in temp git repo
 *   - autoCommit includes correct SHA
 *   - autoCommit handles null testsOk (no tests found)
 *   - autoCommit never pushes
 *
 * Run: node skills/dev-pipeline/tests/test-auto-commit.js
 */

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { autoCommit } = require(path.resolve(__dirname, '..', 'scripts', 'auto-commit.js'));

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

function makeTempGitDir(name) {
  const dir = path.join(os.tmpdir(), `test-ac-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);

  // Initialize a git repo with an initial commit
  execFileSync('git', ['init'], { cwd: dir, encoding: 'utf8' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, encoding: 'utf8' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, encoding: 'utf8' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8' });
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: dir, encoding: 'utf8' });

  return dir;
}

function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// ── Pre-condition tests ──

test('autoCommit: requires workspaceRoot', () => {
  const result = autoCommit({});
  assert.strictEqual(result.ok, false);
  assert.ok(result.error.includes('workspaceRoot'));
});

test('autoCommit: requires patchApplied', () => {
  const dir = makeTempGitDir('no-patch');
  const result = autoCommit({ workspaceRoot: dir });
  assert.strictEqual(result.ok, false);
  assert.ok(result.error.includes('patch was not applied'));
});

test('autoCommit: rejects when tests failed', () => {
  const dir = makeTempGitDir('tests-failed');
  const result = autoCommit({ workspaceRoot: dir, patchApplied: true, testsOk: false });
  assert.strictEqual(result.ok, false);
  assert.ok(result.error.includes('tests failed'));
});

test('autoCommit: handles no changes gracefully', () => {
  const dir = makeTempGitDir('no-changes');
  const result = autoCommit({ workspaceRoot: dir, patchApplied: true });
  assert.strictEqual(result.ok, false);
  assert.ok(result.error.includes('no changes'));
});

// ── Successful commit tests ──

test('autoCommit: creates commit with structured message', () => {
  const dir = makeTempGitDir('good-commit');
  fs.writeFileSync(path.join(dir, 'new-file.js'), 'console.log("hello");\n', 'utf8');
  const result = autoCommit({
    workspaceRoot: dir,
    patchApplied: true,
    ticketId: 'TICKET-1',
    title: 'Add greeting',
    runFolder: '.claw/runs/123_TICKET-1',
    agentId: 'agent-alpha',
  });
  assert.strictEqual(result.ok, true);
  assert.ok(result.commit_sha);
  assert.ok(result.message.includes('feat(TICKET-1)'));
  assert.ok(result.message.includes('Add greeting'));
  assert.ok(result.message.includes('Run: .claw/runs/123_TICKET-1'));
  assert.ok(result.message.includes('Agent: agent-alpha'));
  assert.ok(result.message.includes('dev-pipeline autonomous runner'));
  assert.strictEqual(result.error, null);
});

test('autoCommit: SHA is valid short hash', () => {
  const dir = makeTempGitDir('sha-check');
  fs.writeFileSync(path.join(dir, 'code.js'), 'x = 1;\n', 'utf8');
  const result = autoCommit({ workspaceRoot: dir, patchApplied: true, ticketId: 'T-2' });
  assert.strictEqual(result.ok, true);
  assert.ok(/^[0-9a-f]{7,}$/.test(result.commit_sha), `SHA should be hex: ${result.commit_sha}`);
});

test('autoCommit: git log shows the commit', () => {
  const dir = makeTempGitDir('log-check');
  fs.writeFileSync(path.join(dir, 'data.txt'), 'data\n', 'utf8');
  const result = autoCommit({ workspaceRoot: dir, patchApplied: true, ticketId: 'T-3', title: 'Test log' });
  assert.strictEqual(result.ok, true);

  const log = execFileSync('git', ['log', '--oneline', '-1'], { cwd: dir, encoding: 'utf8' }).trim();
  assert.ok(log.includes('feat(T-3)'), `Log should contain commit: ${log}`);
});

test('autoCommit: null testsOk is acceptable (no tests found)', () => {
  const dir = makeTempGitDir('null-tests');
  fs.writeFileSync(path.join(dir, 'file.txt'), 'content\n', 'utf8');
  const result = autoCommit({ workspaceRoot: dir, patchApplied: true, testsOk: null, ticketId: 'T-4' });
  assert.strictEqual(result.ok, true);
});

test('autoCommit: true testsOk is acceptable', () => {
  const dir = makeTempGitDir('true-tests');
  fs.writeFileSync(path.join(dir, 'file.txt'), 'ok\n', 'utf8');
  const result = autoCommit({ workspaceRoot: dir, patchApplied: true, testsOk: true, ticketId: 'T-5' });
  assert.strictEqual(result.ok, true);
});

test('autoCommit: default ticketId and agentId', () => {
  const dir = makeTempGitDir('defaults');
  fs.writeFileSync(path.join(dir, 'def.txt'), 'default\n', 'utf8');
  const result = autoCommit({ workspaceRoot: dir, patchApplied: true });
  assert.strictEqual(result.ok, true);
  assert.ok(result.message.includes('feat(unknown)'));
  assert.ok(result.message.includes('Agent: autonomous'));
});

test('autoCommit: never adds remote or pushes', () => {
  const dir = makeTempGitDir('no-push');
  fs.writeFileSync(path.join(dir, 'push-test.txt'), 'nopush\n', 'utf8');
  const result = autoCommit({ workspaceRoot: dir, patchApplied: true, ticketId: 'T-6' });
  assert.strictEqual(result.ok, true);

  // Verify no remotes configured
  const remotes = execFileSync('git', ['remote', '-v'], { cwd: dir, encoding: 'utf8' }).trim();
  assert.strictEqual(remotes, '', 'should have no remotes');
});

test('autoCommit: working dir is clean after commit', () => {
  const dir = makeTempGitDir('clean-after');
  fs.writeFileSync(path.join(dir, 'clean.txt'), 'clean\n', 'utf8');
  const result = autoCommit({ workspaceRoot: dir, patchApplied: true, ticketId: 'T-7' });
  assert.strictEqual(result.ok, true);

  const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim();
  assert.strictEqual(status, '', 'working dir should be clean after commit');
});

test('autoCommit: not a git repo returns error', () => {
  const dir = path.join(os.tmpdir(), `test-ac-nogit-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'text\n', 'utf8');
  const result = autoCommit({ workspaceRoot: dir, patchApplied: true });
  assert.strictEqual(result.ok, false);
  assert.ok(result.error);
});

// ── Cleanup ──
cleanup();

console.log('');
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
