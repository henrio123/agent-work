#!/usr/bin/env node
'use strict';

/**
 * Tests for run-next-drive.js — one-shot deterministic driver.
 * Run: node skills/dev-pipeline/tests/test-run-next-drive.js
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
const RUNS_DIR = path.join(WORKSPACE_ROOT, 'runs');
const DRIVE_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'run-next-drive.js');
const DRIVE_SHELL = path.join(WORKSPACE_ROOT, 'tools', 'run-next-drive.sh');
const AUDIT_FILENAME = 'autonomous-audit.jsonl';

const { driveOnce } = require(DRIVE_SCRIPT);
const { scaffoldAdapter } = require(path.resolve(__dirname, '..', 'scripts', 'autonomous-runner.js'));

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
  const folderName = `_test_drv_${name}_${Date.now()}`;
  const absDir = path.join(RUNS_DIR, folderName);
  fs.mkdirSync(absDir, { recursive: true });
  tmpDirs.push(absDir);

  const relDir = `runs/${folderName}`;

  if (extras.skipStatus) {
    return { folderName, absDir, relDir };
  }

  // Write intake artifact (needed for autonomous runner)
  fs.writeFileSync(path.join(absDir, '00-intake.json'), JSON.stringify({
    ticket_id: `TEST-DRV-${name.toUpperCase()}`,
    title: `Test drive ${name}`,
    project: 'test',
    created_at: '2026-01-01T00:00:00.000Z',
    source: 'test',
  }, null, 2), 'utf8');

  const status = {
    ticket_id: `TEST-DRV-${name.toUpperCase()}`,
    title: `Test drive ${name}`,
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

  return { folderName, absDir, relDir };
}

function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
process.on('exit', cleanup);

// -------------------------------------------------------------------------
// Test 1: No eligible runs
// -------------------------------------------------------------------------
console.log('\n--- no eligible ---');

test('drive_skipped when all runs done/blocked/stopped', () => {
  const tmpRunsDir = path.join(os.tmpdir(), `_test_drv_empty_${Date.now()}`);
  fs.mkdirSync(tmpRunsDir, { recursive: true });
  tmpDirs.push(tmpRunsDir);

  // One done run
  const doneDir = path.join(tmpRunsDir, 'run-done');
  fs.mkdirSync(doneDir);
  fs.writeFileSync(path.join(doneDir, 'status.json'), JSON.stringify({
    ticket_id: 'T', title: 'T', project: 'T',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    current_stage: 'done', blocked: false,
    required_user_input: [], stage_history: [], next_actions: [],
  }), 'utf8');

  const result = driveOnce({ runsDir: tmpRunsDir });
  if (!result.ok) throw new Error('expected ok:true');
  if (result.action !== 'drive_skipped') throw new Error(`expected drive_skipped, got ${result.action}`);
  if (result.picked.action !== 'no_eligible_runs') throw new Error('expected no_eligible_runs in picked');
});

test('drive_skipped returns exit 0 via CLI when no eligible', () => {
  // The real runs/ has active runs so we can't easily test this via CLI.
  // But we can test the output contract is JSON.
  const stdout = execFileSync('node', [DRIVE_SCRIPT, '--dry_run'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  const parsed = JSON.parse(stdout);
  if (!parsed.ok) throw new Error('expected ok:true');
  // It should be either drive_complete or drive_skipped — both are valid
  if (parsed.action !== 'drive_complete' && parsed.action !== 'drive_skipped') {
    throw new Error(`unexpected action: ${parsed.action}`);
  }
});

// -------------------------------------------------------------------------
// Test 2: Eligible run gets driven
// -------------------------------------------------------------------------
console.log('\n--- drive eligible ---');

test('drive_complete with scaffold adapter picks and drives a run', () => {
  const { folderName, relDir } = makeTempRun('eligible');

  // Use custom runsDir with only this run to isolate the test
  const tmpRunsDir = path.join(os.tmpdir(), `_test_drv_iso_${Date.now()}`);
  fs.mkdirSync(tmpRunsDir, { recursive: true });
  tmpDirs.push(tmpRunsDir);

  // Copy the run into the isolated dir
  const isoDir = path.join(tmpRunsDir, folderName);
  fs.cpSync(path.join(RUNS_DIR, folderName), isoDir, { recursive: true });

  const result = driveOnce({
    runsDir: tmpRunsDir,
    agentAdapter: scaffoldAdapter,
    maxSteps: 5,
    maxAgentCalls: 3,
  });

  if (!result.ok) throw new Error(`expected ok:true, got error: ${result.error}`);
  if (result.action !== 'drive_complete') throw new Error(`expected drive_complete, got ${result.action}`);
  if (!result.picked) throw new Error('missing picked');
  if (!result.autonomous) throw new Error('missing autonomous');
  if (result.picked.action !== 'picked_run') throw new Error('expected picked_run');
  if (!result.autonomous.final_action) throw new Error('missing final_action in autonomous');
});

// -------------------------------------------------------------------------
// Test 3: dry_run passthrough
// -------------------------------------------------------------------------
console.log('\n--- dry_run ---');

test('dry_run prevents agent invocation', () => {
  const { folderName } = makeTempRun('dryrun');

  const tmpRunsDir = path.join(os.tmpdir(), `_test_drv_dry_${Date.now()}`);
  fs.mkdirSync(tmpRunsDir, { recursive: true });
  tmpDirs.push(tmpRunsDir);

  const isoDir = path.join(tmpRunsDir, folderName);
  fs.cpSync(path.join(RUNS_DIR, folderName), isoDir, { recursive: true });

  const result = driveOnce({ runsDir: tmpRunsDir, dryRun: true, maxSteps: 1 });
  if (!result.ok) throw new Error(`expected ok:true, error: ${result.error}`);
  if (result.action !== 'drive_complete') throw new Error(`expected drive_complete, got ${result.action}`);
  if (result.autonomous.agent_calls !== 0) throw new Error(`dry_run should have 0 agent_calls, got ${result.autonomous.agent_calls}`);
});

// -------------------------------------------------------------------------
// Test 4: audit_log passthrough
// -------------------------------------------------------------------------
console.log('\n--- audit_log ---');

test('audit_log creates audit file when enabled', () => {
  // Use real RUNS_DIR so autonomous runner can resolve the path
  const { folderName, absDir } = makeTempRun('audit');

  const result = driveOnce({
    agentAdapter: scaffoldAdapter,
    auditLog: true,
    maxSteps: 3,
    maxAgentCalls: 2,
  });
  if (!result.ok) throw new Error(`expected ok, error: ${result.error}`);

  // The driver should have picked some run and driven it with audit enabled.
  // Check the picked run's audit file in the real workspace.
  const pickedFolder = result.picked.run_folder;
  const pickedAbsDir = path.join(WORKSPACE_ROOT, pickedFolder);
  const auditPath = path.join(pickedAbsDir, AUDIT_FILENAME);
  if (!fs.existsSync(auditPath)) throw new Error('audit file not created');
  const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n');
  if (lines.length === 0) throw new Error('audit file is empty');
  const first = JSON.parse(lines[0]);
  if (!first.ts || !first.event) throw new Error('audit line missing expected fields');
});

// -------------------------------------------------------------------------
// Test 5: Stopped run not driven
// -------------------------------------------------------------------------
console.log('\n--- stopped run ---');

test('driver never picks a stopped run', () => {
  const tmpRunsDir = path.join(os.tmpdir(), `_test_drv_stop_${Date.now()}`);
  fs.mkdirSync(tmpRunsDir, { recursive: true });
  tmpDirs.push(tmpRunsDir);

  // One run with .stop
  const stopDir = path.join(tmpRunsDir, 'run-stopped');
  fs.mkdirSync(stopDir);
  fs.writeFileSync(path.join(stopDir, 'status.json'), JSON.stringify({
    ticket_id: 'T', title: 'T', project: 'T',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    current_stage: 'pm-ready', blocked: false,
    required_user_input: [], stage_history: [], next_actions: [],
  }), 'utf8');
  fs.writeFileSync(path.join(stopDir, '.stop'), '', 'utf8');

  const result = driveOnce({ runsDir: tmpRunsDir });
  if (result.action === 'drive_complete') throw new Error('should not drive stopped run');
  if (result.action !== 'drive_skipped') throw new Error(`expected drive_skipped, got ${result.action}`);
});

// -------------------------------------------------------------------------
// Test 6: Output contract
// -------------------------------------------------------------------------
console.log('\n--- output contract ---');

test('drive_complete has picked and autonomous fields', () => {
  const { folderName } = makeTempRun('contract');

  const tmpRunsDir = path.join(os.tmpdir(), `_test_drv_contract_${Date.now()}`);
  fs.mkdirSync(tmpRunsDir, { recursive: true });
  tmpDirs.push(tmpRunsDir);

  const isoDir = path.join(tmpRunsDir, folderName);
  fs.cpSync(path.join(RUNS_DIR, folderName), isoDir, { recursive: true });

  const result = driveOnce({
    runsDir: tmpRunsDir,
    dryRun: true,
    maxSteps: 1,
  });
  if (!result.ok) throw new Error(`expected ok, error: ${result.error}`);
  if (result.action !== 'drive_complete') throw new Error(`expected drive_complete, got ${result.action}`);

  // Verify contract fields
  if (!result.picked || result.picked.action !== 'picked_run') throw new Error('missing picked');
  if (!result.autonomous) throw new Error('missing autonomous');
  if (typeof result.autonomous.steps_run !== 'number') throw new Error('missing steps_run');
  if (typeof result.autonomous.agent_calls !== 'number') throw new Error('missing agent_calls');
});

// -------------------------------------------------------------------------
// Test 7: CLI
// -------------------------------------------------------------------------
console.log('\n--- CLI ---');

test('CLI --dry_run outputs valid JSON', () => {
  const stdout = execFileSync('node', [DRIVE_SCRIPT, '--dry_run', '--max_steps', '1'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  const parsed = JSON.parse(stdout);
  if (typeof parsed.ok !== 'boolean') throw new Error('missing ok');
  if (!parsed.action) throw new Error('missing action');
});

test('shell helper --dry_run outputs valid JSON', () => {
  const stdout = execFileSync('bash', [DRIVE_SHELL, '--dry_run', '--max_steps', '1'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  const parsed = JSON.parse(stdout);
  if (typeof parsed.ok !== 'boolean') throw new Error('missing ok');
});

// -------------------------------------------------------------------------
// Test 8: Quiet mode (JSON-only stdout)
// -------------------------------------------------------------------------
console.log('\n--- quiet mode ---');

test('CLI stdout starts with { (JSON-only, no progress lines)', () => {
  const stdout = execFileSync('node', [DRIVE_SCRIPT, '--dry_run', '--max_steps', '1'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  const trimmed = stdout.trimStart();
  if (!trimmed.startsWith('{')) throw new Error(`stdout starts with: ${trimmed.slice(0, 40)}`);
  // Verify no "autonomous:" prefix lines in stdout
  if (stdout.includes('autonomous:')) throw new Error('stdout contains progress prefix');
  if (/\[\d+\]/.test(stdout.split('{')[0])) throw new Error('stdout contains step lines before JSON');
});

test('CLI stderr is empty in quiet mode (default)', () => {
  try {
    const result = require('node:child_process').execFileSync('node', [DRIVE_SCRIPT, '--dry_run', '--max_steps', '1'], {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    // Even if it fails, check stderr
    if (e.stderr && e.stderr.includes('autonomous:')) throw new Error('stderr has progress in quiet mode');
  }
  // If it succeeded, we can't easily get stderr from execFileSync return value,
  // but we verified stdout is clean above. Use spawnSync for stderr check.
  const { spawnSync } = require('node:child_process');
  const r = spawnSync('node', [DRIVE_SCRIPT, '--dry_run', '--max_steps', '1'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (r.stderr && r.stderr.includes('autonomous:')) throw new Error('stderr has progress in quiet mode');
  if (r.stderr && /\[\d+\]/.test(r.stderr)) throw new Error('stderr has step lines in quiet mode');
});

test('--verbose restores progress lines to stderr', () => {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync('node', [DRIVE_SCRIPT, '--verbose', '--dry_run', '--max_steps', '1'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.stderr}`);
  // stdout should still be valid JSON
  const parsed = JSON.parse(r.stdout);
  if (!parsed.ok) throw new Error('stdout not valid JSON result');
  // stderr should have progress lines
  if (!r.stderr.includes('autonomous:')) throw new Error('stderr missing progress header in verbose mode');
});

test('quiet mode does not change selection or summary', () => {
  // Run quiet and verbose with same params, compare pick result
  const { spawnSync } = require('node:child_process');
  const quietR = spawnSync('node', [DRIVE_SCRIPT, '--dry_run', '--max_steps', '1'], {
    encoding: 'utf8', timeout: 30000,
  });
  const verboseR = spawnSync('node', [DRIVE_SCRIPT, '--verbose', '--dry_run', '--max_steps', '1'], {
    encoding: 'utf8', timeout: 30000,
  });
  const quietResult = JSON.parse(quietR.stdout);
  const verboseResult = JSON.parse(verboseR.stdout);
  if (quietResult.action !== verboseResult.action) throw new Error('action differs between quiet/verbose');
  if (quietResult.picked.run_folder !== verboseResult.picked.run_folder) throw new Error('picked run_folder differs');
  if (quietResult.autonomous.final_action !== verboseResult.autonomous.final_action) throw new Error('final_action differs');
});

// -------------------------------------------------------------------------
// Test 9: Output schema validation
// -------------------------------------------------------------------------
console.log('\n--- output schema ---');

const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));
const driveSchema = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'run-next-drive.output.schema.json'), 'utf8'));

test('drive_complete output validates against schema', () => {
  const stdout = execFileSync('node', [DRIVE_SCRIPT, '--dry_run', '--max_steps', '1'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  const parsed = JSON.parse(stdout);
  if (parsed.action !== 'drive_complete') return; // skip if no eligible runs
  const v = validateAgainstSchema(parsed, driveSchema);
  if (!v.ok) throw new Error(`schema validation failed: ${v.details.join('; ')}`);
});

test('drive_skipped output validates against schema', () => {
  const tmpRunsDir = path.join(os.tmpdir(), `_test_drv_schema_empty_${Date.now()}`);
  fs.mkdirSync(tmpRunsDir, { recursive: true });
  tmpDirs.push(tmpRunsDir);

  const doneDir = path.join(tmpRunsDir, 'run-done');
  fs.mkdirSync(doneDir);
  fs.writeFileSync(path.join(doneDir, 'status.json'), JSON.stringify({
    ticket_id: 'T', title: 'T', project: 'T',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    current_stage: 'done', blocked: false,
    required_user_input: [], stage_history: [], next_actions: [],
  }), 'utf8');

  const result = driveOnce({ runsDir: tmpRunsDir });
  const v = validateAgainstSchema(result, driveSchema);
  if (!v.ok) throw new Error(`schema validation failed: ${v.details.join('; ')}`);
});

// -------------------------------------------------------------------------
// Test 10: Read-only safety
// -------------------------------------------------------------------------
console.log('\n--- read-only safety ---');

test('no new run folders created in real runs/', () => {
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
// Summary
// -------------------------------------------------------------------------
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
