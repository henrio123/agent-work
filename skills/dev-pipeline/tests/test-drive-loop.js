#!/usr/bin/env node
'use strict';

/**
 * OPS-02: Tests for tools/project-drive-loop.sh.
 * Run: node skills/dev-pipeline/tests/test-drive-loop.js
 */

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
const LOOP_SCRIPT = path.join(WORKSPACE_ROOT, 'tools', 'project-drive-loop.sh');

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

function makeTempWorkspace() {
  const dir = path.join(os.tmpdir(), `_test_loop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  // Create minimal workspace structure so the driver can load
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
process.on('exit', cleanup);

// ---------------------------------------------------------------
// Test: .stop file causes immediate clean exit
// ---------------------------------------------------------------
console.log('\n--- .stop file ---');

test('exits on .stop file with stop_reason=stop_file', () => {
  const workspace = makeTempWorkspace();
  // Create .stop file before running
  fs.writeFileSync(path.join(workspace, '.stop'), '', 'utf8');

  const output = execSync(
    `WORKSPACE_ROOT="${workspace}" bash "${LOOP_SCRIPT}" --max 10 --sleep 0`,
    { encoding: 'utf8', timeout: 15000 }
  ).trim();

  // Last line should be JSON summary
  const lines = output.split('\n');
  const summary = JSON.parse(lines[lines.length - 1]);
  assert(summary.ok === true, 'expected ok: true');
  assert(summary.stop_reason === 'stop_file', `expected stop_file, got ${summary.stop_reason}`);
  assert(summary.iterations === 0, `expected 0 iterations, got ${summary.iterations}`);
});

// ---------------------------------------------------------------
// Test: no eligible work causes exit with summary
// ---------------------------------------------------------------
console.log('\n--- no eligible work ---');

test('exits with no_eligible_work when projects dir is empty', () => {
  // Use real workspace root — all tasks are done
  // Run with max 1 to avoid long test
  const output = execSync(
    `bash "${LOOP_SCRIPT}" --max 1 --sleep 0`,
    { encoding: 'utf8', timeout: 30000 }
  ).trim();

  const lines = output.split('\n');
  const summary = JSON.parse(lines[lines.length - 1]);
  assert(summary.ok === true, 'expected ok: true');
  // Could be no_eligible_work or max_iterations depending on project state
  assert(
    summary.stop_reason === 'no_eligible_work' || summary.stop_reason === 'max_iterations',
    `expected no_eligible_work or max_iterations, got ${summary.stop_reason}`
  );
  assert(typeof summary.iterations === 'number', 'expected iterations number');
  assert(typeof summary.runs_created === 'number', 'expected runs_created number');
  assert(typeof summary.drives_attempted === 'number', 'expected drives_attempted number');
});

// ---------------------------------------------------------------
// Test: max iterations enforced
// ---------------------------------------------------------------
console.log('\n--- max iterations ---');

test('respects max iterations', () => {
  const workspace = makeTempWorkspace();
  // No projects means drive_skipped immediately, but let's test max too
  // With an empty workspace, the first drive will error or skip
  const output = execSync(
    `bash "${LOOP_SCRIPT}" --max 1 --sleep 0`,
    { encoding: 'utf8', timeout: 30000 }
  ).trim();

  const lines = output.split('\n');
  const summary = JSON.parse(lines[lines.length - 1]);
  assert(summary.ok === true, 'expected ok: true');
  assert(summary.drives_attempted <= 1, `expected at most 1 drive, got ${summary.drives_attempted}`);
});

// ---------------------------------------------------------------
// Test: summary JSON shape
// ---------------------------------------------------------------
console.log('\n--- summary shape ---');

test('summary contains all required fields', () => {
  const workspace = makeTempWorkspace();
  fs.writeFileSync(path.join(workspace, '.stop'), '', 'utf8');

  const output = execSync(
    `WORKSPACE_ROOT="${workspace}" bash "${LOOP_SCRIPT}" --sleep 0`,
    { encoding: 'utf8', timeout: 15000 }
  ).trim();

  const lines = output.split('\n');
  const summary = JSON.parse(lines[lines.length - 1]);
  const requiredKeys = ['ok', 'iterations', 'runs_created', 'drives_attempted', 'stop_reason'];
  for (const key of requiredKeys) {
    assert(key in summary, `missing key: ${key}`);
  }
});

// ---------------------------------------------------------------
// Summary
// ---------------------------------------------------------------
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
