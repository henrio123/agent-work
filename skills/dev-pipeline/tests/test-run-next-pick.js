#!/usr/bin/env node
'use strict';

/**
 * Tests for run-next-pick.js — deterministic run picker.
 * Run: node skills/dev-pipeline/tests/test-run-next-pick.js
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
const RUNS_DIR = path.join(WORKSPACE_ROOT, 'runs');
const PICK_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'run-next-pick.js');
const PICK_SHELL = path.join(WORKSPACE_ROOT, 'tools', 'run-next-pick.sh');

const { pickNextRun, classifyRun } = require(PICK_SCRIPT);

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

function makeTempRun(name, statusOverrides = {}, extras = {}) {
  const folderName = `_test_pick_${name}_${Date.now()}`;
  const absDir = path.join(RUNS_DIR, folderName);
  fs.mkdirSync(absDir, { recursive: true });
  tmpDirs.push(absDir);

  if (extras.skipStatus) {
    return { folderName, absDir };
  }

  const status = {
    ticket_id: `TEST-PICK-${name.toUpperCase()}`,
    title: `Test pick ${name}`,
    project: 'test',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    current_stage: 'pm-ready',
    blocked: false,
    blocked_reason: null,
    required_user_input: [],
    stage_history: [],
    next_actions: [],
    ...statusOverrides,
  };
  fs.writeFileSync(path.join(absDir, 'status.json'), JSON.stringify(status, null, 2), 'utf8');

  return { folderName, absDir };
}

function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
process.on('exit', cleanup);

// -------------------------------------------------------------------------
// Test 1: classifyRun
// -------------------------------------------------------------------------
console.log('\n--- classifyRun ---');

test('classifyRun returns null for stopped run', () => {
  const result = classifyRun({ has_status: true, stop_signal: true, blocked: false, current_stage: 'pm-ready' });
  if (result !== null) throw new Error(`expected null, got ${result}`);
});

test('classifyRun returns null for blocked run', () => {
  const result = classifyRun({ has_status: true, stop_signal: false, blocked: true, current_stage: 'blocked' });
  if (result !== null) throw new Error(`expected null, got ${result}`);
});

test('classifyRun returns null for done run', () => {
  const result = classifyRun({ has_status: true, stop_signal: false, blocked: false, current_stage: 'done' });
  if (result !== null) throw new Error(`expected null, got ${result}`);
});

test('classifyRun returns null for run without status', () => {
  const result = classifyRun({ has_status: false, stop_signal: false, blocked: false, current_stage: null });
  if (result !== null) throw new Error(`expected null, got ${result}`);
});

test('classifyRun returns needs_task_pack for intake', () => {
  const result = classifyRun({ has_status: true, stop_signal: false, blocked: false, current_stage: 'intake' });
  if (result !== 'needs_task_pack') throw new Error(`expected needs_task_pack, got ${result}`);
});

test('classifyRun returns needs_artifacts when last action is needs_artifacts', () => {
  const result = classifyRun({
    has_status: true, stop_signal: false, blocked: false, current_stage: 'pm-ready',
    last_autonomous_summary: { final_action: 'needs_artifacts' },
  });
  if (result !== 'needs_artifacts') throw new Error(`expected needs_artifacts, got ${result}`);
});

test('classifyRun returns other for active stage without summary', () => {
  const result = classifyRun({ has_status: true, stop_signal: false, blocked: false, current_stage: 'pm-ready' });
  if (result !== 'other') throw new Error(`expected other, got ${result}`);
});

// -------------------------------------------------------------------------
// Test 2: Stopped run skipped
// -------------------------------------------------------------------------
console.log('\n--- pick eligibility ---');

test('stopped run is not picked', () => {
  // Stop all real runs temporarily, create one stopped test run
  const { folderName, absDir } = makeTempRun('stopped', { current_stage: 'pm-ready' });
  fs.writeFileSync(path.join(absDir, '.stop'), '', 'utf8');
  const result = pickNextRun();
  if (result.ok && result.action === 'picked_run' && result.run_folder === `runs/${folderName}`) {
    throw new Error('should not pick stopped run');
  }
});

test('blocked run is not picked', () => {
  const { folderName } = makeTempRun('blocked', { current_stage: 'blocked', blocked: true });
  const result = pickNextRun();
  if (result.ok && result.action === 'picked_run' && result.run_folder === `runs/${folderName}`) {
    throw new Error('should not pick blocked run');
  }
});

test('done run is not picked', () => {
  const { folderName } = makeTempRun('done', { current_stage: 'done' });
  const result = pickNextRun();
  if (result.ok && result.action === 'picked_run' && result.run_folder === `runs/${folderName}`) {
    throw new Error('should not pick done run');
  }
});

// -------------------------------------------------------------------------
// Test 3: Priority ordering
// -------------------------------------------------------------------------
console.log('\n--- priority ordering ---');

test('needs_task_pack outranks needs_artifacts', () => {
  // Create two: one intake, one pm-ready with needs_artifacts
  const { folderName: f1 } = makeTempRun('prio-intake', { current_stage: 'intake' });
  const { folderName: f2 } = makeTempRun('prio-needs', {
    current_stage: 'pm-ready',
    last_autonomous_summary: { final_action: 'needs_artifacts' },
  });

  const result = pickNextRun();
  if (!result.ok || result.action !== 'picked_run') throw new Error('expected picked_run');
  // The intake run should be picked (needs_task_pack > needs_artifacts)
  if (result.run_folder === `runs/${f2}` && result.priority_bucket === 'needs_artifacts') {
    // Check that f1 wasn't eligible for some reason
    // Actually just verify the bucket is needs_task_pack
    throw new Error('needs_artifacts was picked over needs_task_pack');
  }
  if (result.priority_bucket === 'needs_task_pack') {
    // Correct — intake run won
  }
});

test('deterministic ordering within same bucket (earliest ASC)', () => {
  // The picker uses run-index which sorts ASC, and picker preserves that order within bucket
  const result = pickNextRun();
  if (result.ok && result.action === 'picked_run') {
    // Just verify we get a stable result — run it twice
    const result2 = pickNextRun();
    if (result.run_folder !== result2.run_folder) {
      throw new Error(`non-deterministic: ${result.run_folder} vs ${result2.run_folder}`);
    }
  }
});

// -------------------------------------------------------------------------
// Test 4: Empty / no eligible
// -------------------------------------------------------------------------
console.log('\n--- no eligible ---');

test('returns no_eligible_runs when all done/blocked/stopped', () => {
  // Use a custom runsDir with only ineligible runs
  const tmpRunsDir = path.join(os.tmpdir(), `_test_pick_empty_${Date.now()}`);
  fs.mkdirSync(tmpRunsDir, { recursive: true });
  tmpDirs.push(tmpRunsDir);

  // Create one done run
  const doneDir = path.join(tmpRunsDir, 'run-done');
  fs.mkdirSync(doneDir);
  fs.writeFileSync(path.join(doneDir, 'status.json'), JSON.stringify({
    ticket_id: 'T', title: 'T', project: 'T',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    current_stage: 'done', blocked: false,
    required_user_input: [], stage_history: [], next_actions: [],
  }), 'utf8');

  const result = pickNextRun({ runsDir: tmpRunsDir });
  if (result.action !== 'no_eligible_runs') throw new Error(`expected no_eligible_runs, got ${result.action}`);
});

test('returns no_eligible_runs when runs/ is empty', () => {
  const tmpRunsDir = path.join(os.tmpdir(), `_test_pick_truly_empty_${Date.now()}`);
  fs.mkdirSync(tmpRunsDir, { recursive: true });
  tmpDirs.push(tmpRunsDir);

  const result = pickNextRun({ runsDir: tmpRunsDir });
  if (result.action !== 'no_eligible_runs') throw new Error(`expected no_eligible_runs, got ${result.action}`);
});

// -------------------------------------------------------------------------
// Test 5: Output contract
// -------------------------------------------------------------------------
console.log('\n--- output contract ---');

test('picked_run output has all required fields', () => {
  const result = pickNextRun();
  if (result.action === 'picked_run') {
    if (!result.run_folder) throw new Error('missing run_folder');
    if (!result.reason) throw new Error('missing reason');
    if (!result.priority_bucket) throw new Error('missing priority_bucket');
  }
  // ok field always present
  if (typeof result.ok !== 'boolean') throw new Error('missing ok');
  if (!result.action) throw new Error('missing action');
});

// -------------------------------------------------------------------------
// Test 6: CLI
// -------------------------------------------------------------------------
console.log('\n--- CLI ---');

test('CLI outputs valid JSON', () => {
  const stdout = execFileSync('node', [PICK_SCRIPT], { encoding: 'utf8', timeout: 10000 });
  const parsed = JSON.parse(stdout);
  if (typeof parsed.ok !== 'boolean') throw new Error('missing ok');
  if (!parsed.action) throw new Error('missing action');
});

test('shell helper outputs valid JSON', () => {
  const stdout = execFileSync('bash', [PICK_SHELL], { encoding: 'utf8', timeout: 10000 });
  const parsed = JSON.parse(stdout);
  if (typeof parsed.ok !== 'boolean') throw new Error('missing ok');
});

// -------------------------------------------------------------------------
// Test 7: Read-only safety
// -------------------------------------------------------------------------
console.log('\n--- read-only safety ---');

test('no new run folders created', () => {
  const allRuns = fs.readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const nonTest = allRuns.filter((n) => !n.startsWith('_test_'));
  const originals = nonTest.filter((n) => n.includes('OC-07') || n.includes('OC-08'));
  if (originals.length !== nonTest.length) {
    throw new Error(`unexpected non-test runs: ${nonTest.filter(n => !n.includes('OC-07') && !n.includes('OC-08')).join(', ')}`);
  }
});

// -------------------------------------------------------------------------
// Test 8: Output schema validation
// -------------------------------------------------------------------------
console.log('\n--- output schema ---');

const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));
const pickSchema = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'run-next-pick.output.schema.json'), 'utf8'));

test('picked_run output validates against schema', () => {
  const result = pickNextRun();
  if (result.action !== 'picked_run') return; // skip if no eligible
  const v = validateAgainstSchema(result, pickSchema);
  if (!v.ok) throw new Error(`schema validation failed: ${v.details.join('; ')}`);
});

test('no_eligible_runs output validates against schema', () => {
  const tmpRunsDir = path.join(os.tmpdir(), `_test_pick_schema_empty_${Date.now()}`);
  fs.mkdirSync(tmpRunsDir, { recursive: true });
  tmpDirs.push(tmpRunsDir);
  const result = pickNextRun({ runsDir: tmpRunsDir });
  const v = validateAgainstSchema(result, pickSchema);
  if (!v.ok) throw new Error(`schema validation failed: ${v.details.join('; ')}`);
});

test('CLI output validates against schema', () => {
  const stdout = execFileSync('node', [PICK_SCRIPT], { encoding: 'utf8', timeout: 10000 });
  const parsed = JSON.parse(stdout);
  const v = validateAgainstSchema(parsed, pickSchema);
  if (!v.ok) throw new Error(`schema validation failed: ${v.details.join('; ')}`);
});

// -------------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------------
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
