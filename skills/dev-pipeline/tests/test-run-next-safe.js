#!/usr/bin/env node
'use strict';

/**
 * Tests for run_next_safe command.
 * Uses child_process to invoke the CLI against temporary run folders.
 * Run: node skills/dev-pipeline/tests/test-run-next-safe.js
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DP = path.resolve(__dirname, '..', 'scripts', 'dev-pipeline.js');
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
const RUNS_DIR = path.join(WORKSPACE_ROOT, '.claw', 'runs');
fs.mkdirSync(RUNS_DIR, { recursive: true });

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

// Run the CLI and parse JSON stdout. Returns { stdout, stderr, exitCode, json }.
function runCmd(command, runFolder) {
  try {
    const stdout = execFileSync('node', [DP, command, runFolder], {
      encoding: 'utf8',
      timeout: 5000,
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

// Create a temporary run folder inside .claw/runs/ (so safePath accepts it).
// Returns the relative path like ".claw/runs/<name>".
function makeTempRun(name, statusOverrides = {}) {
  const folderName = `_test_${name}_${Date.now()}`;
  const absDir = path.join(RUNS_DIR, folderName);
  fs.mkdirSync(absDir, { recursive: true });
  tmpDirs.push(absDir);

  const relDir = `.claw/runs/${folderName}`;

  // 00-intake.json
  fs.writeFileSync(path.join(absDir, '00-intake.json'), JSON.stringify({
    ticket_id: 'TEST-SAFE',
    title: 'Test run_next_safe',
    project: 'test',
    created_at: '2026-01-01T00:00:00.000Z',
    source: 'test',
  }, null, 2), 'utf8');

  // status.json
  const status = {
    ticket_id: 'TEST-SAFE',
    title: 'Test run_next_safe',
    project: 'test',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    current_stage: 'pm-ready',
    blocked: false,
    blocked_reason: null,
    required_user_input: [],
    stage_history: [
      { stage: 'intake', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:00:01.000Z', artifact_paths: ['00-intake.json'] },
      { stage: 'task-pack-generated', started_at: '2026-01-01T00:00:01.000Z', finished_at: '2026-01-01T00:00:02.000Z', artifact_paths: ['30-dev-claude-task.txt'] },
      { stage: 'pm-ready', started_at: '2026-01-01T00:00:02.000Z', finished_at: null, artifact_paths: [], role: 'PM' },
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
// Test 1: done stage returns action none
// -------------------------------------------------------------------------
console.log('\n--- done stage ---');

test('done stage returns action none', () => {
  const { relDir } = makeTempRun('done', { current_stage: 'done' });
  const r = runCmd('run_next_safe', relDir);
  if (!r.json) throw new Error(`No JSON output: ${r.stdout} ${r.stderr}`);
  if (r.json.action !== 'none') throw new Error(`expected action=none, got ${r.json.action}`);
  if (r.json.current_stage !== 'done') throw new Error(`expected current_stage=done`);
  if (!Array.isArray(r.json.trace)) throw new Error('missing trace');
});

// -------------------------------------------------------------------------
// Test 2: blocked stage returns action blocked with inputs
// -------------------------------------------------------------------------
console.log('\n--- blocked stage ---');

test('blocked stage returns action blocked with required inputs', () => {
  const { relDir } = makeTempRun('blocked', {
    current_stage: 'blocked',
    blocked: true,
    blocked_reason: 'test block',
    required_user_input: [
      { id: 'inp-1', prompt: 'What color?', options: null, default: null, status: 'pending', answer: null },
    ],
  });
  const r = runCmd('run_next_safe', relDir);
  if (r.json.action !== 'blocked') throw new Error(`expected action=blocked, got ${r.json.action}`);
  if (r.json.required_inputs.length !== 1) throw new Error('expected 1 required input');
  if (r.json.required_inputs[0].id !== 'inp-1') throw new Error('wrong input id');
});

// -------------------------------------------------------------------------
// Test 3: intake stage returns needs_task_pack
// -------------------------------------------------------------------------
console.log('\n--- intake stage ---');

test('intake stage returns needs_task_pack', () => {
  const { relDir } = makeTempRun('intake', { current_stage: 'intake' });
  const r = runCmd('run_next_safe', relDir);
  if (r.json.action !== 'needs_task_pack') throw new Error(`expected needs_task_pack, got ${r.json.action}`);
});

// -------------------------------------------------------------------------
// Test 4: stage with missing task file triggers generated_role_pack
// -------------------------------------------------------------------------
console.log('\n--- missing task file ---');

test('pm-ready without task file triggers generated_role_pack', () => {
  const { relDir, absDir } = makeTempRun('no-taskfile');
  // Ensure no task file exists
  const taskFile = path.join(absDir, '31-pm-claude-task.txt');
  if (fs.existsSync(taskFile)) fs.unlinkSync(taskFile);
  const r = runCmd('run_next_safe', relDir);
  if (r.json.action !== 'generated_role_pack') throw new Error(`expected generated_role_pack, got ${r.json.action}`);
  if (r.json.role !== 'PM') throw new Error(`expected role=PM, got ${r.json.role}`);
  if (r.json.task_file !== '31-pm-claude-task.txt') throw new Error('wrong task_file');
  // Verify file was actually created
  if (!fs.existsSync(taskFile)) throw new Error('task file not created');
});

// -------------------------------------------------------------------------
// Test 5: stage with missing artifacts returns needs_artifacts
// -------------------------------------------------------------------------
console.log('\n--- missing artifacts ---');

test('pm-ready with task file but no artifact returns needs_artifacts', () => {
  const { relDir, absDir } = makeTempRun('needs-art');
  // Create the task file so it doesn't trigger generated_role_pack
  fs.writeFileSync(path.join(absDir, '31-pm-claude-task.txt'), 'task content', 'utf8');
  const r = runCmd('run_next_safe', relDir);
  if (r.json.action !== 'needs_artifacts') throw new Error(`expected needs_artifacts, got ${r.json.action}`);
  if (!r.json.missing_artifacts.includes('10-pm-brief.json')) throw new Error('missing artifact not listed');
});

// -------------------------------------------------------------------------
// Test 6: stage with gates passing triggers orchestrate_one
// -------------------------------------------------------------------------
console.log('\n--- gates pass ---');

test('pm-ready with valid artifact delegates to orchestrate_one', () => {
  const { relDir, absDir } = makeTempRun('gates-pass');
  // Create task file
  fs.writeFileSync(path.join(absDir, '31-pm-claude-task.txt'), 'task content', 'utf8');
  // Create valid PM brief
  fs.writeFileSync(path.join(absDir, '10-pm-brief.json'), JSON.stringify({
    ticket_id: 'TEST-SAFE', title: 't', project: 'p',
    problem_statement: 'x', scope: 'y', acceptance_criteria: [],
  }, null, 2), 'utf8');
  const r = runCmd('run_next_safe', relDir);
  // orchestrate_one should advance to ux-ready
  if (!r.json) throw new Error(`No JSON: stdout=${r.stdout} stderr=${r.stderr}`);
  if (r.json.action !== 'advanced_and_generated') throw new Error(`expected advanced_and_generated, got ${r.json.action}`);
  if (r.json.advanced_to !== 'ux-ready') throw new Error(`expected ux-ready, got ${r.json.advanced_to}`);
});

// -------------------------------------------------------------------------
// Test 7: idempotency — running twice on needs_artifacts gives same result
// -------------------------------------------------------------------------
console.log('\n--- idempotency ---');

test('run_next_safe is idempotent on needs_artifacts', () => {
  const { relDir, absDir } = makeTempRun('idempotent');
  fs.writeFileSync(path.join(absDir, '31-pm-claude-task.txt'), 'task', 'utf8');
  const r1 = runCmd('run_next_safe', relDir);
  const r2 = runCmd('run_next_safe', relDir);
  if (r1.json.action !== r2.json.action) throw new Error('actions differ');
  if (r1.json.action !== 'needs_artifacts') throw new Error('expected needs_artifacts');
  if (JSON.stringify(r1.json.missing_artifacts) !== JSON.stringify(r2.json.missing_artifacts)) throw new Error('missing_artifacts differ');
});

test('run_next_safe is idempotent on done', () => {
  const { relDir } = makeTempRun('idempotent-done', { current_stage: 'done' });
  const r1 = runCmd('run_next_safe', relDir);
  const r2 = runCmd('run_next_safe', relDir);
  if (r1.json.action !== 'none') throw new Error('first call not none');
  if (r2.json.action !== 'none') throw new Error('second call not none');
});

// -------------------------------------------------------------------------
// Test 8: non-existent run folder returns error, creates nothing
// -------------------------------------------------------------------------
console.log('\n--- non-existent folder ---');

test('non-existent folder returns action error and creates no directory', () => {
  const ghostFolder = `.claw/runs/_test_ghost_${Date.now()}`;
  const absGhost = path.join(WORKSPACE_ROOT, ghostFolder);

  // Snapshot directory listing before
  const before = fs.readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const r = runCmd('run_next_safe', ghostFolder);

  // Snapshot after
  const after = fs.readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  if (r.json.action !== 'error') throw new Error(`expected action=error, got ${r.json.action}`);
  if (!r.json.error) throw new Error('missing error message');
  if (!Array.isArray(r.json.trace)) throw new Error('missing trace');
  if (r.exitCode !== 0) throw new Error(`expected exit 0 (ok envelope), got ${r.exitCode}`);
  if (fs.existsSync(absGhost)) {
    fs.rmSync(absGhost, { recursive: true, force: true });
    throw new Error('ghost folder was created!');
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('directory listing changed');
});

// -------------------------------------------------------------------------
// Test 9: output schema shape is stable across all action types
// -------------------------------------------------------------------------
console.log('\n--- output schema contract ---');

test('all responses have ok, action, and trace fields', () => {
  // Collect multiple action types
  const { relDir: doneDir } = makeTempRun('schema-done', { current_stage: 'done' });
  const { relDir: blockedDir } = makeTempRun('schema-blocked', {
    current_stage: 'blocked', blocked: true, blocked_reason: 'test',
    required_user_input: [{ id: 'x', prompt: 'y', options: null, default: null, status: 'pending', answer: null }],
  });
  const { relDir: intakeDir } = makeTempRun('schema-intake', { current_stage: 'intake' });
  const { relDir: needsArtDir, absDir: needsArtAbs } = makeTempRun('schema-needs-art');
  fs.writeFileSync(path.join(needsArtAbs, '31-pm-claude-task.txt'), 'task', 'utf8');

  const cases = [
    { label: 'done', dir: doneDir, expectedAction: 'none' },
    { label: 'blocked', dir: blockedDir, expectedAction: 'blocked' },
    { label: 'intake', dir: intakeDir, expectedAction: 'needs_task_pack' },
    { label: 'needs_artifacts', dir: needsArtDir, expectedAction: 'needs_artifacts' },
  ];

  for (const c of cases) {
    const r = runCmd('run_next_safe', c.dir);
    if (!r.json) throw new Error(`${c.label}: no JSON output`);
    if (typeof r.json.ok !== 'boolean') throw new Error(`${c.label}: missing ok field`);
    if (typeof r.json.action !== 'string') throw new Error(`${c.label}: missing action field`);
    if (!Array.isArray(r.json.trace)) throw new Error(`${c.label}: missing trace array`);
    if (r.json.action !== c.expectedAction) throw new Error(`${c.label}: expected ${c.expectedAction}, got ${r.json.action}`);
  }
});

test('blocked response includes required_inputs array', () => {
  const { relDir } = makeTempRun('schema-blocked2', {
    current_stage: 'blocked', blocked: true, blocked_reason: 'need info',
    required_user_input: [
      { id: 'a', prompt: 'Q1?', options: null, default: null, status: 'pending', answer: null },
      { id: 'b', prompt: 'Q2?', options: null, default: null, status: 'pending', answer: null },
    ],
  });
  const r = runCmd('run_next_safe', relDir);
  if (!Array.isArray(r.json.required_inputs)) throw new Error('missing required_inputs');
  if (r.json.required_inputs.length !== 2) throw new Error(`expected 2 inputs, got ${r.json.required_inputs.length}`);
  // Each input must have id and prompt
  for (const inp of r.json.required_inputs) {
    if (!inp.id) throw new Error('input missing id');
    if (!inp.prompt) throw new Error('input missing prompt');
  }
});

test('needs_artifacts response includes missing_artifacts and role', () => {
  const { relDir, absDir } = makeTempRun('schema-needs-art2');
  fs.writeFileSync(path.join(absDir, '31-pm-claude-task.txt'), 'task', 'utf8');
  const r = runCmd('run_next_safe', relDir);
  if (r.json.action !== 'needs_artifacts') throw new Error(`expected needs_artifacts, got ${r.json.action}`);
  if (!Array.isArray(r.json.missing_artifacts)) throw new Error('missing missing_artifacts');
  if (typeof r.json.role !== 'string') throw new Error('missing role');
  if (!Array.isArray(r.json.required_artifacts)) throw new Error('missing required_artifacts');
});

// -------------------------------------------------------------------------
// Test 10: never creates new run folders
// -------------------------------------------------------------------------
console.log('\n--- safety ---');

test('no new run folders created outside test dirs', () => {
  const allRuns = fs.readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const nonTest = allRuns.filter((n) => !n.startsWith('_test_'));
  // Should only be the two original runs
  const originals = nonTest.filter((n) => n.includes('OC-07') || n.includes('OC-08'));
  if (originals.length !== nonTest.length) {
    throw new Error(`unexpected non-test runs: ${nonTest.filter(n => !n.includes('OC-07') && !n.includes('OC-08')).join(', ')}`);
  }
});

// -------------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------------
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
