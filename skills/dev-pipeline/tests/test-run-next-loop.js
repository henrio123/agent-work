#!/usr/bin/env node
'use strict';

/**
 * Tests for run_next_loop command.
 * Uses child_process to invoke the CLI against temporary run folders.
 * Run: node skills/dev-pipeline/tests/test-run-next-loop.js
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DP = path.resolve(__dirname, '..', 'scripts', 'dev-pipeline.js');
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
const RUNS_DIR = path.join(WORKSPACE_ROOT, '.claw', 'runs');
fs.mkdirSync(RUNS_DIR, { recursive: true });
const baselineRuns = new Set(fs.readdirSync(RUNS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory()).map((e) => e.name));

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

function runCmd(command, ...extraArgs) {
  try {
    const stdout = execFileSync('node', [DP, command, ...extraArgs], {
      encoding: 'utf8',
      timeout: 10000,
    });
    let json = null;
    try { json = JSON.parse(stdout); } catch {}
    return { stdout, stderr: '', exitCode: 0, json };
  } catch (e) {
    let json = null;
    try { json = JSON.parse(e.stdout || ''); } catch {}
    try { json = json || JSON.parse(e.stderr || ''); } catch {}
    return { stdout: e.stdout || '', stderr: e.stderr || '', exitCode: e.status, json };
  }
}

function makeTempRun(name, statusOverrides = {}) {
  const folderName = `_test_${name}_${Date.now()}`;
  const absDir = path.join(RUNS_DIR, folderName);
  fs.mkdirSync(absDir, { recursive: true });
  tmpDirs.push(absDir);

  const relDir = `.claw/runs/${folderName}`;

  fs.writeFileSync(path.join(absDir, '00-intake.json'), JSON.stringify({
    ticket_id: 'TEST-LOOP',
    title: 'Test run_next_loop',
    project: 'test',
    created_at: '2026-01-01T00:00:00.000Z',
    source: 'test',
  }, null, 2), 'utf8');

  const status = {
    ticket_id: 'TEST-LOOP',
    title: 'Test run_next_loop',
    project: 'test',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    current_stage: 'analyze',
    blocked: false,
    blocked_reason: null,
    required_user_input: [],
    stage_history: [
      { stage: 'intake', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:00:01.000Z', artifact_paths: ['00-intake.json'] },
      { stage: 'task-pack-generated', started_at: '2026-01-01T00:00:01.000Z', finished_at: '2026-01-01T00:00:02.000Z', artifact_paths: ['30-dev-claude-task.txt'] },
      { stage: 'analyze', started_at: '2026-01-01T00:00:02.000Z', finished_at: null, artifact_paths: [], role: 'Analyst' },
    ],
    next_actions: [],
    ...statusOverrides,
  };
  fs.writeFileSync(path.join(absDir, 'status.json'), JSON.stringify(status, null, 2), 'utf8');

  return { relDir, absDir };
}

function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
process.on('exit', cleanup);

// -------------------------------------------------------------------------
// Test 1: non-existent folder
// -------------------------------------------------------------------------
console.log('\n--- non-existent folder ---');

test('non-existent folder returns final_action error, creates nothing', () => {
  const ghostFolder = `.claw/runs/_test_loop_ghost_${Date.now()}`;
  const absGhost = path.join(WORKSPACE_ROOT, ghostFolder);

  const before = fs.readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name).sort();

  const r = runCmd('run_next_loop', ghostFolder);

  const after = fs.readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name).sort();

  if (!r.json) throw new Error(`No JSON output: ${r.stdout} ${r.stderr}`);
  if (r.json.action !== 'loop_complete') throw new Error(`expected action=loop_complete, got ${r.json.action}`);
  if (r.json.final_action !== 'error') throw new Error(`expected final_action=error, got ${r.json.final_action}`);
  if (r.json.steps_run !== 0) throw new Error(`expected steps_run=0, got ${r.json.steps_run}`);
  if (r.exitCode !== 0) throw new Error(`expected exit 0, got ${r.exitCode}`);
  if (fs.existsSync(absGhost)) {
    fs.rmSync(absGhost, { recursive: true, force: true });
    throw new Error('ghost folder was created');
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('directory listing changed');
});

// -------------------------------------------------------------------------
// Test 2: done stage
// -------------------------------------------------------------------------
console.log('\n--- done stage ---');

test('done stage stops at step 1 with final_action none', () => {
  const { relDir } = makeTempRun('loop-done', { current_stage: 'done' });
  const r = runCmd('run_next_loop', relDir);
  if (!r.json) throw new Error(`No JSON: ${r.stdout}`);
  if (r.json.action !== 'loop_complete') throw new Error(`expected loop_complete`);
  if (r.json.final_action !== 'none') throw new Error(`expected none, got ${r.json.final_action}`);
  if (r.json.steps_run !== 1) throw new Error(`expected 1 step, got ${r.json.steps_run}`);
  if (r.json.steps[0].action !== 'none') throw new Error(`step action should be none`);
});

// -------------------------------------------------------------------------
// Test 3: blocked stage
// -------------------------------------------------------------------------
console.log('\n--- blocked stage ---');

test('blocked stage stops immediately with required_inputs', () => {
  const { relDir } = makeTempRun('loop-blocked', {
    current_stage: 'blocked',
    blocked: true,
    blocked_reason: 'need answer',
    required_user_input: [
      { id: 'inp-1', prompt: 'What?', options: null, default: null, status: 'pending', answer: null },
    ],
  });
  const r = runCmd('run_next_loop', relDir);
  if (r.json.final_action !== 'blocked') throw new Error(`expected blocked, got ${r.json.final_action}`);
  if (r.json.steps_run !== 1) throw new Error(`expected 1 step`);
  if (!r.json.steps[0].required_inputs) throw new Error('missing required_inputs in step');
  if (r.json.steps[0].required_inputs[0].id !== 'inp-1') throw new Error('wrong input id');
});

// -------------------------------------------------------------------------
// Test 4: needs_artifacts
// -------------------------------------------------------------------------
console.log('\n--- needs_artifacts ---');

test('implement with task file but no artifacts stops with needs_artifacts', () => {
  const { relDir, absDir } = makeTempRun('loop-needs-art', {
    current_stage: 'implement',
    stage_history: [
      { stage: 'intake', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:00:01.000Z', artifact_paths: ['00-intake.json'] },
      { stage: 'implement', started_at: '2026-01-01T00:00:02.000Z', finished_at: null, artifact_paths: [], role: 'Dev' },
    ],
  });
  fs.writeFileSync(path.join(absDir, '33-implement-task.txt'), 'dev task', 'utf8');
  const r = runCmd('run_next_loop', relDir);
  if (r.json.final_action !== 'needs_artifacts') throw new Error(`expected needs_artifacts, got ${r.json.final_action}`);
  if (r.json.steps_run !== 1) throw new Error(`expected 1 step`);
  if (!r.json.steps[0].missing_artifacts.includes('40-dev-patch.diff')) throw new Error('missing diff not listed');
});

// -------------------------------------------------------------------------
// Test 5: multi-step — task-pack-generated advances then stops at needs_artifacts
// -------------------------------------------------------------------------
console.log('\n--- multi-step progression ---');

test('task-pack-generated run takes 2 steps: advance then needs_artifacts', () => {
  const { relDir } = makeTempRun('loop-multi', {
    current_stage: 'task-pack-generated',
    stage_history: [
      { stage: 'intake', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:00:01.000Z', artifact_paths: ['00-intake.json'] },
      { stage: 'task-pack-generated', started_at: '2026-01-01T00:00:01.000Z', finished_at: null, artifact_paths: ['30-dev-claude-task.txt'] },
    ],
  });
  const r = runCmd('run_next_loop', relDir);
  if (r.json.steps_run !== 2) throw new Error(`expected 2 steps, got ${r.json.steps_run}`);
  if (r.json.steps[0].action !== 'advanced_and_generated') throw new Error(`step 1 expected advanced_and_generated, got ${r.json.steps[0].action}`);
  if (r.json.steps[0].advanced_to !== 'analyze') throw new Error(`step 1 expected advanced_to=analyze`);
  if (r.json.final_action !== 'needs_artifacts') throw new Error(`expected final needs_artifacts, got ${r.json.final_action}`);
});

// -------------------------------------------------------------------------
// Test 6: max_steps enforcement
// -------------------------------------------------------------------------
console.log('\n--- max_steps ---');

test('max_steps=1 stops after one step even if loop could continue', () => {
  const { relDir } = makeTempRun('loop-max1', {
    current_stage: 'task-pack-generated',
    stage_history: [
      { stage: 'intake', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:00:01.000Z', artifact_paths: ['00-intake.json'] },
      { stage: 'task-pack-generated', started_at: '2026-01-01T00:00:01.000Z', finished_at: null, artifact_paths: ['30-dev-claude-task.txt'] },
    ],
  });
  const r = runCmd('run_next_loop', relDir, '--max_steps', '1');
  if (r.json.steps_run !== 1) throw new Error(`expected 1 step, got ${r.json.steps_run}`);
  if (r.json.max_steps !== 1) throw new Error(`expected max_steps=1, got ${r.json.max_steps}`);
  if (r.json.steps[0].action !== 'advanced_and_generated') throw new Error('expected advance step');
});

// -------------------------------------------------------------------------
// Test 7: output schema contract
// -------------------------------------------------------------------------
console.log('\n--- output schema contract ---');

test('loop response has all stable contract fields', () => {
  const { relDir } = makeTempRun('loop-schema', { current_stage: 'done' });
  const r = runCmd('run_next_loop', relDir);
  if (typeof r.json.ok !== 'boolean') throw new Error('missing ok');
  if (r.json.action !== 'loop_complete') throw new Error('missing action=loop_complete');
  if (typeof r.json.final_action !== 'string') throw new Error('missing final_action');
  if (typeof r.json.steps_run !== 'number') throw new Error('missing steps_run');
  if (typeof r.json.max_steps !== 'number') throw new Error('missing max_steps');
  if (!Array.isArray(r.json.steps)) throw new Error('missing steps array');
  if (!Array.isArray(r.json.trace)) throw new Error('missing trace array');
});

// -------------------------------------------------------------------------
// Test 8: safety — no new run directories created
// -------------------------------------------------------------------------
console.log('\n--- safety ---');

test('loop with max_steps=5 does not create any new run directories', () => {
  const before = fs.readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const nonTestBefore = before.filter((n) => !n.startsWith('_test_'));

  // Run loop on a task-pack-generated run (will do advance + needs_artifacts)
  const { relDir } = makeTempRun('loop-safety', {
    current_stage: 'task-pack-generated',
    stage_history: [
      { stage: 'intake', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:00:01.000Z', artifact_paths: ['00-intake.json'] },
      { stage: 'task-pack-generated', started_at: '2026-01-01T00:00:01.000Z', finished_at: null, artifact_paths: ['30-dev-claude-task.txt'] },
    ],
  });
  runCmd('run_next_loop', relDir, '--max_steps', '5');

  const after = fs.readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const nonTestAfter = after.filter((n) => !n.startsWith('_test_'));

  if (nonTestBefore.length !== nonTestAfter.length) {
    throw new Error(`non-test run count changed: ${nonTestBefore.length} → ${nonTestAfter.length}`);
  }
});

test('no new run folders created outside test dirs', () => {
  const allRuns = fs.readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const newNonTest = allRuns.filter((n) => !n.startsWith('_test_') && !baselineRuns.has(n));
  if (newNonTest.length > 0) {
    throw new Error(`unexpected non-test runs: ${newNonTest.join(', ')}`);
  }
});

// -------------------------------------------------------------------------
// Test 9: idempotency — loop twice on same run gives same result
// -------------------------------------------------------------------------
console.log('\n--- idempotency ---');

test('loop is idempotent on done', () => {
  const { relDir } = makeTempRun('loop-idemp-done', { current_stage: 'done' });
  const r1 = runCmd('run_next_loop', relDir);
  const r2 = runCmd('run_next_loop', relDir);
  if (r1.json.final_action !== r2.json.final_action) throw new Error('final_action differs');
  if (r1.json.steps_run !== r2.json.steps_run) throw new Error('steps_run differs');
});

test('loop is idempotent on needs_artifacts', () => {
  const { relDir, absDir } = makeTempRun('loop-idemp-art', {
    current_stage: 'implement',
    stage_history: [
      { stage: 'implement', started_at: '2026-01-01T00:00:00.000Z', finished_at: null, artifact_paths: [], role: 'Dev' },
    ],
  });
  fs.writeFileSync(path.join(absDir, '33-implement-task.txt'), 'dev task', 'utf8');
  const r1 = runCmd('run_next_loop', relDir);
  const r2 = runCmd('run_next_loop', relDir);
  if (r1.json.final_action !== 'needs_artifacts') throw new Error('r1 not needs_artifacts');
  if (r2.json.final_action !== 'needs_artifacts') throw new Error('r2 not needs_artifacts');
  if (r1.json.steps_run !== r2.json.steps_run) throw new Error('steps_run differs');
});

// -------------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------------
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
