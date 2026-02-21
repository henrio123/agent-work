#!/usr/bin/env node
'use strict';

/**
 * Tests for project-drive-loop.js (Phase 5, Epic 4).
 *
 * Run: node skills/dev-pipeline/tests/test-drive-loop-js.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { driveLoop, computeNextSleep } = require(path.resolve(__dirname, '..', 'scripts', 'project-drive-loop.js'));
const { scaffoldAdapter } = require(path.resolve(__dirname, '..', 'scripts', 'autonomous-runner.js'));
const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));

const schema = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'project-drive-loop.output.schema.json'), 'utf8')
);

let passed = 0;
let failed = 0;

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-loop-js-'));
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

function makeWorkspace(projectId, backlogItems = []) {
  const ws = fs.mkdtempSync(path.join(TMP, 'ws-'));
  const clawDir = path.join(ws, '.claw');
  fs.mkdirSync(path.join(clawDir, 'backlog'), { recursive: true });
  fs.mkdirSync(path.join(clawDir, 'runs'), { recursive: true });
  fs.mkdirSync(path.join(clawDir, 'task-packs'), { recursive: true });
  fs.mkdirSync(path.join(clawDir, 'agents'), { recursive: true });

  fs.writeFileSync(path.join(clawDir, 'project.json'), JSON.stringify({
    project_id: projectId,
    title: `Test ${projectId}`,
    description: 'test',
    repo_path: ws,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }), 'utf8');

  for (const item of backlogItems) {
    const defaults = {
      project_id: projectId,
      type: 'task',
      title: `Task ${item.id}`,
      description: 'Test task',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      status: 'todo',
      priority: 'P2',
      owner_role: 'DEV',
      depends_on: [],
      run_folder: null,
      tags: [],
      artifacts_expected: [],
      last_summary: null,
      parent_id: null,
      ...item,
    };
    fs.writeFileSync(
      path.join(clawDir, 'backlog', `${defaults.id}.json`),
      JSON.stringify(defaults, null, 2),
      'utf8'
    );
  }

  return ws;
}

// =========================================================================
// Stop file
// =========================================================================
console.log('\n--- Stop file ---');

test('stops when .stop file exists', () => {
  const ws = makeWorkspace('proj-stop', [
    { id: 'T-1', status: 'todo', priority: 'P0' },
  ]);

  // Create .stop file before starting
  fs.writeFileSync(path.join(ws, '.stop'), '', 'utf8');

  const result = driveLoop({
    workspaceRoot: ws,
    maxIterations: 10,
    sleepMs: 0,
    agentAdapter: scaffoldAdapter,
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.stop_reason, 'stop_file');
  assert.strictEqual(result.iterations, 0);
});

// =========================================================================
// Max iterations
// =========================================================================
console.log('\n--- Max iterations ---');

test('stops at max iterations', () => {
  const ws = makeWorkspace('proj-max', [
    { id: 'T-1', status: 'todo', priority: 'P0' },
  ]);

  const result = driveLoop({
    workspaceRoot: ws,
    maxIterations: 2,
    sleepMs: 0,
    agentAdapter: scaffoldAdapter,
  });

  assert.strictEqual(result.ok, true);
  assert.ok(result.iterations <= 2, `Expected <= 2 iterations, got ${result.iterations}`);
});

// =========================================================================
// Adaptive sleep
// =========================================================================
console.log('\n--- Adaptive sleep ---');

test('sleep increases on idle (drive_skipped)', () => {
  const initial = 5000;
  const next = computeNextSleep('drive_skipped', initial);
  assert.ok(next > initial, `Expected increase from ${initial}, got ${next}`);
  assert.ok(next <= 30000, `Expected <= 30000, got ${next}`);
});

test('sleep decreases on work (drive_created_run)', () => {
  const initial = 10000;
  const next = computeNextSleep('drive_created_run', initial);
  assert.strictEqual(next, 1000, `Expected 1000, got ${next}`);
});

test('sleep decreases on work (drive_complete)', () => {
  const initial = 15000;
  const next = computeNextSleep('drive_complete', initial);
  assert.strictEqual(next, 1000, `Expected 1000, got ${next}`);
});

test('sleep increases on error', () => {
  const initial = 5000;
  const next = computeNextSleep('error', initial);
  assert.strictEqual(next, 60000, `Expected 60000, got ${next}`);
});

// =========================================================================
// No eligible work
// =========================================================================
console.log('\n--- No eligible work ---');

test('stops when no eligible work (empty workspace)', () => {
  const ws = makeWorkspace('proj-empty');

  const result = driveLoop({
    workspaceRoot: ws,
    maxIterations: 5,
    sleepMs: 0,
    agentAdapter: scaffoldAdapter,
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.stop_reason, 'no_eligible_work');
  assert.strictEqual(result.iterations, 1);
});

// =========================================================================
// Project filter
// =========================================================================
console.log('\n--- Project filter ---');

test('project filter is passed through and recorded in output', () => {
  const ws = makeWorkspace('proj-filter');

  const result = driveLoop({
    workspaceRoot: ws,
    maxIterations: 1,
    sleepMs: 0,
    projectId: 'proj-filter',
    agentAdapter: scaffoldAdapter,
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.project_filter, 'proj-filter');
});

// =========================================================================
// Hooks
// =========================================================================
console.log('\n--- Hooks ---');

test('hooks are called after each drive', () => {
  const ws = makeWorkspace('proj-hooks', [
    { id: 'T-1', status: 'todo', priority: 'P0' },
  ]);

  let hookCallCount = 0;
  const testHook = () => { hookCallCount++; };

  const result = driveLoop({
    workspaceRoot: ws,
    maxIterations: 1,
    sleepMs: 0,
    agentAdapter: scaffoldAdapter,
    hooks: [testHook],
  });

  assert.strictEqual(result.ok, true);
  assert.ok(hookCallCount >= 1, `Expected hooks to be called, count: ${hookCallCount}`);
  assert.ok(result.hook_results_summary.hooks_run >= 1);
});

test('hook failure is non-fatal', () => {
  const ws = makeWorkspace('proj-hookfail', [
    { id: 'T-1', status: 'todo', priority: 'P0' },
  ]);

  const failingHook = () => { throw new Error('hook crashed'); };

  const result = driveLoop({
    workspaceRoot: ws,
    maxIterations: 1,
    sleepMs: 0,
    agentAdapter: scaffoldAdapter,
    hooks: [failingHook],
  });

  assert.strictEqual(result.ok, true);
  assert.ok(result.hook_results_summary.hooks_failed >= 1, 'Should record failed hooks');
});

// =========================================================================
// Schema validation
// =========================================================================
console.log('\n--- Schema validation ---');

test('output validates against schema', () => {
  const ws = makeWorkspace('proj-schema');

  const result = driveLoop({
    workspaceRoot: ws,
    maxIterations: 1,
    sleepMs: 0,
    agentAdapter: scaffoldAdapter,
  });

  const v = validateAgainstSchema(result, schema);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);
});

// =========================================================================
// Output summary
// =========================================================================
console.log('\n--- Output summary ---');

test('output has all required summary fields', () => {
  const ws = makeWorkspace('proj-summary');

  const result = driveLoop({
    workspaceRoot: ws,
    maxIterations: 1,
    sleepMs: 0,
    agentAdapter: scaffoldAdapter,
  });

  assert.strictEqual(typeof result.ok, 'boolean');
  assert.strictEqual(typeof result.iterations, 'number');
  assert.strictEqual(typeof result.runs_created, 'number');
  assert.strictEqual(typeof result.drives_attempted, 'number');
  assert.strictEqual(typeof result.stop_reason, 'string');
  assert.ok(result.hook_results_summary, 'should have hook_results_summary');
  assert.ok('hooks_run' in result.hook_results_summary);
  assert.ok('hooks_failed' in result.hook_results_summary);
});

// =========================================================================
// Summary
// =========================================================================
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
