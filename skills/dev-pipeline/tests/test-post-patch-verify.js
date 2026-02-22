#!/usr/bin/env node
'use strict';

/**
 * Tests for Phase 7 post-patch test execution (Epic 2).
 *
 * Covers:
 *   - discoverTestCommand with package.json, Makefile, test-all.sh, Cargo.toml
 *   - discoverTestCommand skips npm default "echo Error" scripts
 *   - discoverTestCommand returns found:false when no test infrastructure
 *   - runPostPatchTests with explicit test command
 *   - runPostPatchTests with discovered command
 *   - runPostPatchTests when no tests discovered
 *   - runPostPatchTests when tests fail
 *   - runPostPatchTests requires workspaceRoot
 *   - Integration with autonomous-runner
 *
 * Run: node skills/dev-pipeline/tests/test-post-patch-verify.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { discoverTestCommand, runPostPatchTests } = require(path.resolve(__dirname, '..', 'scripts', 'post-patch-verify.js'));

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

function makeTempDir(name) {
  const dir = path.join(os.tmpdir(), `test-ppv-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// ── discoverTestCommand tests ──

test('discover: package.json with valid test script', () => {
  const dir = makeTempDir('pkg-valid');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    scripts: { test: 'jest --coverage' },
  }), 'utf8');
  const result = discoverTestCommand(dir);
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.command, 'npm test');
  assert.strictEqual(result.source, 'package.json');
});

test('discover: package.json with default echo Error script is skipped', () => {
  const dir = makeTempDir('pkg-default');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    scripts: { test: 'echo "Error: no test specified" && exit 1' },
  }), 'utf8');
  const result = discoverTestCommand(dir);
  assert.strictEqual(result.found, false);
});

test('discover: package.json without test script falls through', () => {
  const dir = makeTempDir('pkg-no-test');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    scripts: { start: 'node index.js' },
  }), 'utf8');
  const result = discoverTestCommand(dir);
  assert.strictEqual(result.found, false);
});

test('discover: Makefile with test target', () => {
  const dir = makeTempDir('makefile');
  fs.writeFileSync(path.join(dir, 'Makefile'), 'test:\n\t@echo running tests\n', 'utf8');
  const result = discoverTestCommand(dir);
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.command, 'make test');
  assert.strictEqual(result.source, 'Makefile');
});

test('discover: Makefile without test target falls through', () => {
  const dir = makeTempDir('makefile-no-test');
  fs.writeFileSync(path.join(dir, 'Makefile'), 'build:\n\t@echo building\n', 'utf8');
  const result = discoverTestCommand(dir);
  assert.strictEqual(result.found, false);
});

test('discover: test-all.sh in root', () => {
  const dir = makeTempDir('testall-root');
  fs.writeFileSync(path.join(dir, 'test-all.sh'), '#!/bin/bash\necho ok\n', 'utf8');
  const result = discoverTestCommand(dir);
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.command, 'bash test-all.sh');
  assert.strictEqual(result.source, 'test-all.sh');
});

test('discover: test-all.sh in tools/', () => {
  const dir = makeTempDir('testall-tools');
  fs.mkdirSync(path.join(dir, 'tools'));
  fs.writeFileSync(path.join(dir, 'tools', 'test-all.sh'), '#!/bin/bash\necho ok\n', 'utf8');
  const result = discoverTestCommand(dir);
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.command, 'bash tools/test-all.sh');
  assert.strictEqual(result.source, 'tools/test-all.sh');
});

test('discover: Cargo.toml', () => {
  const dir = makeTempDir('cargo');
  fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "test"\n', 'utf8');
  const result = discoverTestCommand(dir);
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.command, 'cargo test');
  assert.strictEqual(result.source, 'Cargo.toml');
});

test('discover: no test infrastructure returns found:false', () => {
  const dir = makeTempDir('empty');
  const result = discoverTestCommand(dir);
  assert.strictEqual(result.found, false);
  assert.strictEqual(result.command, null);
  assert.strictEqual(result.source, null);
});

test('discover: priority order package.json > Makefile', () => {
  const dir = makeTempDir('priority');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    scripts: { test: 'jest' },
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'Makefile'), 'test:\n\t@echo running\n', 'utf8');
  const result = discoverTestCommand(dir);
  assert.strictEqual(result.source, 'package.json');
});

// ── runPostPatchTests tests ──

test('runPostPatchTests: requires workspaceRoot', () => {
  const result = runPostPatchTests({});
  assert.strictEqual(result.ok, false);
  assert.ok(result.error);
});

test('runPostPatchTests: no tests discovered returns ok with tests_discovered:false', () => {
  const dir = makeTempDir('no-tests');
  const result = runPostPatchTests({ workspaceRoot: dir });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.tests_discovered, false);
  assert.strictEqual(result.test_command, null);
});

test('runPostPatchTests: explicit passing command', () => {
  const dir = makeTempDir('pass-cmd');
  const result = runPostPatchTests({
    workspaceRoot: dir,
    testCommand: 'echo passed',
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.tests_discovered, true);
  assert.strictEqual(result.exit_code, 0);
  assert.strictEqual(result.test_command, 'echo passed');
  assert.ok(result.stdout_tail.includes('passed'));
  assert.ok(result.duration_ms >= 0);
});

test('runPostPatchTests: explicit failing command', () => {
  const dir = makeTempDir('fail-cmd');
  const result = runPostPatchTests({
    workspaceRoot: dir,
    testCommand: 'false',
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.tests_discovered, true);
  assert.notStrictEqual(result.exit_code, 0);
});

test('runPostPatchTests: stdout_tail is limited', () => {
  const dir = makeTempDir('tail-limit');
  // Generate long output
  const longStr = 'x'.repeat(5000);
  fs.writeFileSync(path.join(dir, 'test.sh'), `#!/bin/bash\necho "${longStr}"\n`, { mode: 0o755 });
  const result = runPostPatchTests({
    workspaceRoot: dir,
    testCommand: `bash ${path.join(dir, 'test.sh')}`,
    tailChars: 100,
  });
  assert.strictEqual(result.ok, true);
  assert.ok(result.stdout_tail.length <= 100);
});

test('runPostPatchTests: discovers from package.json', () => {
  const dir = makeTempDir('discover-run');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    scripts: { test: 'echo "all tests passed"' },
  }), 'utf8');
  const result = runPostPatchTests({ workspaceRoot: dir });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.tests_discovered, true);
  assert.strictEqual(result.source, 'package.json');
});

test('runPostPatchTests: result has duration_ms', () => {
  const dir = makeTempDir('duration');
  const result = runPostPatchTests({
    workspaceRoot: dir,
    testCommand: 'echo quick',
  });
  assert.strictEqual(typeof result.duration_ms, 'number');
  assert.ok(result.duration_ms >= 0);
});

// ── Cleanup ──
cleanup();

console.log('');
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
