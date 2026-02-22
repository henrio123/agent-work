#!/usr/bin/env node
'use strict';

/**
 * Tests for run-index.js — read-only global run index.
 * Run: node skills/dev-pipeline/tests/test-run-index.js
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
const RUNS_DIR = path.join(WORKSPACE_ROOT, '.claw', 'runs');
fs.mkdirSync(RUNS_DIR, { recursive: true });
const baselineRuns = new Set(fs.readdirSync(RUNS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory()).map((e) => e.name));
const INDEX_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'run-index.js');
const INDEX_SHELL = path.join(WORKSPACE_ROOT, 'tools', 'run-index.sh');

const { buildIndex } = require(INDEX_SCRIPT);

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
  const folderName = `_test_idx_${name}_${Date.now()}`;
  const absDir = path.join(RUNS_DIR, folderName);
  fs.mkdirSync(absDir, { recursive: true });
  tmpDirs.push(absDir);

  if (extras.skipStatus) {
    return { folderName, absDir };
  }

  const status = {
    ticket_id: `TEST-IDX-${name.toUpperCase()}`,
    title: `Test index ${name}`,
    project: 'test',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    current_stage: 'analyze',
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
// Test 1: Basic index output
// -------------------------------------------------------------------------
console.log('\n--- basic index ---');

test('returns ok:true with runs array and summary', () => {
  const result = buildIndex();
  if (!result.ok) throw new Error('expected ok:true');
  if (!Array.isArray(result.runs)) throw new Error('expected runs array');
  if (!result.summary) throw new Error('expected summary');
  if (typeof result.generated_at !== 'string') throw new Error('expected generated_at');
  if (typeof result.summary.total !== 'number') throw new Error('expected total count');
});

test('includes existing real runs (skipped if none)', () => {
  const result = buildIndex();
  const realRuns = result.runs.filter((r) => !r.run_folder.includes('_test_'));
  // On CI there may be no real runs — that's OK
  if (realRuns.length === 0) return;
  if (!realRuns[0].has_status) throw new Error('expected real run to have status');
});

// -------------------------------------------------------------------------
// Test 2: Includes run with status.json
// -------------------------------------------------------------------------
console.log('\n--- run with status ---');

test('includes run with status.json and reads fields', () => {
  const { folderName } = makeTempRun('with-status', {
    current_stage: 'plan',
    blocked: true,
    blocked_reason: 'need input',
  });
  const result = buildIndex();
  const entry = result.runs.find((r) => r.run_folder === `.claw/runs/${folderName}`);
  if (!entry) throw new Error('test run not found in index');
  if (!entry.has_status) throw new Error('expected has_status true');
  if (entry.current_stage !== 'plan') throw new Error(`wrong stage: ${entry.current_stage}`);
  if (!entry.blocked) throw new Error('expected blocked true');
  if (entry.blocked_reason !== 'need input') throw new Error('wrong blocked_reason');
});

// -------------------------------------------------------------------------
// Test 3: Includes run without status.json
// -------------------------------------------------------------------------
console.log('\n--- run without status ---');

test('includes run without status.json (has_status false)', () => {
  const { folderName } = makeTempRun('no-status', {}, { skipStatus: true });
  const result = buildIndex();
  const entry = result.runs.find((r) => r.run_folder === `.claw/runs/${folderName}`);
  if (!entry) throw new Error('test run not found in index');
  if (entry.has_status) throw new Error('expected has_status false');
  if (entry.current_stage !== null) throw new Error('expected null stage');
});

// -------------------------------------------------------------------------
// Test 4: Detects .stop file
// -------------------------------------------------------------------------
console.log('\n--- stop signal ---');

test('detects .stop file', () => {
  const { folderName, absDir } = makeTempRun('with-stop');
  fs.writeFileSync(path.join(absDir, '.stop'), '', 'utf8');
  const result = buildIndex();
  const entry = result.runs.find((r) => r.run_folder === `.claw/runs/${folderName}`);
  if (!entry.stop_signal) throw new Error('expected stop_signal true');
});

test('no stop signal when .stop absent', () => {
  const { folderName } = makeTempRun('no-stop');
  const result = buildIndex();
  const entry = result.runs.find((r) => r.run_folder === `.claw/runs/${folderName}`);
  if (entry.stop_signal) throw new Error('expected stop_signal false');
});

// -------------------------------------------------------------------------
// Test 5: Detects last_autonomous_summary
// -------------------------------------------------------------------------
console.log('\n--- autonomous summary ---');

test('reads last_autonomous_summary and last_autonomous_run_at', () => {
  const { folderName } = makeTempRun('with-summary', {
    last_autonomous_run_at: '2026-01-15T12:00:00.000Z',
    last_autonomous_summary: {
      final_action: 'needs_artifacts',
      steps_run: 5,
      agent_calls: 2,
      artifacts_written: ['10-pm-brief.json'],
    },
  });
  const result = buildIndex();
  const entry = result.runs.find((r) => r.run_folder === `.claw/runs/${folderName}`);
  if (!entry.last_autonomous_run_at) throw new Error('expected last_autonomous_run_at');
  if (!entry.last_autonomous_summary) throw new Error('expected last_autonomous_summary');
  if (entry.last_autonomous_summary.final_action !== 'needs_artifacts') throw new Error('wrong final_action');
  if (entry.last_autonomous_summary.steps_run !== 5) throw new Error('wrong steps_run');
});

// -------------------------------------------------------------------------
// Test 6: Summary counts
// -------------------------------------------------------------------------
console.log('\n--- summary counts ---');

test('summary counts are correct', () => {
  // Create runs with known states
  const { folderName: f1 } = makeTempRun('count-blocked', { blocked: true, current_stage: 'blocked' });
  const { folderName: f2, absDir: d2 } = makeTempRun('count-done', { current_stage: 'done' });
  const { folderName: f3, absDir: d3 } = makeTempRun('count-stopped', { current_stage: 'analyze' });
  fs.writeFileSync(path.join(d3, '.stop'), '', 'utf8');
  const { folderName: f4 } = makeTempRun('count-needs', {
    current_stage: 'implement',
    last_autonomous_summary: { final_action: 'needs_artifacts', steps_run: 1, agent_calls: 1, artifacts_written: [] },
  });

  const result = buildIndex();
  // Filter to only our test runs for this check
  const testRuns = result.runs.filter((r) =>
    r.run_folder.includes('_test_idx_count-')
  );
  if (testRuns.length !== 4) throw new Error(`expected 4 count test runs, got ${testRuns.length}`);

  const blockedCount = testRuns.filter((r) => r.blocked).length;
  const doneCount = testRuns.filter((r) => r.current_stage === 'done').length;
  const stoppedCount = testRuns.filter((r) => r.stop_signal).length;
  const needsCount = testRuns.filter((r) =>
    r.last_autonomous_summary && r.last_autonomous_summary.final_action === 'needs_artifacts'
  ).length;

  if (blockedCount !== 1) throw new Error(`expected 1 blocked, got ${blockedCount}`);
  if (doneCount !== 1) throw new Error(`expected 1 done, got ${doneCount}`);
  if (stoppedCount !== 1) throw new Error(`expected 1 stopped, got ${stoppedCount}`);
  if (needsCount !== 1) throw new Error(`expected 1 needs_artifacts, got ${needsCount}`);

  // Global summary should include at least these
  if (result.summary.total < 4) throw new Error(`total too low: ${result.summary.total}`);
  if (result.summary.blocked < 1) throw new Error('blocked count too low');
  if (result.summary.done < 1) throw new Error('done count too low');
  if (result.summary.stopped < 1) throw new Error('stopped count too low');
  if (result.summary.needs_artifacts < 1) throw new Error('needs_artifacts count too low');
});

// -------------------------------------------------------------------------
// Test 7: Deterministic ordering
// -------------------------------------------------------------------------
console.log('\n--- deterministic ordering ---');

test('runs are sorted by run_folder ASC', () => {
  const result = buildIndex();
  const folders = result.runs.map((r) => r.run_folder);
  const sorted = [...folders].sort();
  if (JSON.stringify(folders) !== JSON.stringify(sorted)) {
    throw new Error('runs not sorted ASC');
  }
});

// -------------------------------------------------------------------------
// Test 8: Audit log detection
// -------------------------------------------------------------------------
console.log('\n--- audit log ---');

test('detects audit log presence', () => {
  const { folderName, absDir } = makeTempRun('with-audit');
  const auditLine = JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', step: 1, action: 'x', stage: 'y', event: 'step', detail: 'test' });
  fs.writeFileSync(path.join(absDir, 'autonomous-audit.jsonl'), auditLine + '\n', 'utf8');
  const result = buildIndex();
  const entry = result.runs.find((r) => r.run_folder === `.claw/runs/${folderName}`);
  if (!entry.has_audit_log) throw new Error('expected has_audit_log true');
});

test('no audit log when file absent', () => {
  const { folderName } = makeTempRun('no-audit');
  const result = buildIndex();
  const entry = result.runs.find((r) => r.run_folder === `.claw/runs/${folderName}`);
  if (entry.has_audit_log) throw new Error('expected has_audit_log false');
});

// -------------------------------------------------------------------------
// Test 9: Stalled detection
// -------------------------------------------------------------------------
console.log('\n--- stalled detection ---');

test('stalled=false when no summary present', () => {
  const { folderName } = makeTempRun('stale-no-summary');
  const result = buildIndex();
  const entry = result.runs.find((r) => r.run_folder === `.claw/runs/${folderName}`);
  if (entry.stalled) throw new Error('expected stalled false');
});

test('stalled=true when needs_artifacts and audit is old', () => {
  const { folderName, absDir } = makeTempRun('stale-old-audit', {
    last_autonomous_summary: { final_action: 'needs_artifacts', steps_run: 1, agent_calls: 1, artifacts_written: [] },
  });
  const auditPath = path.join(absDir, 'autonomous-audit.jsonl');
  fs.writeFileSync(auditPath, '{"step":1}\n', 'utf8');
  // Set mtime to 2 hours ago
  const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(auditPath, oldTime, oldTime);

  const result = buildIndex();
  const entry = result.runs.find((r) => r.run_folder === `.claw/runs/${folderName}`);
  if (!entry.stalled) throw new Error('expected stalled true');
});

test('stalled=false when needs_artifacts but audit is recent', () => {
  const { folderName, absDir } = makeTempRun('stale-recent-audit', {
    last_autonomous_summary: { final_action: 'needs_artifacts', steps_run: 1, agent_calls: 1, artifacts_written: [] },
  });
  const auditPath = path.join(absDir, 'autonomous-audit.jsonl');
  fs.writeFileSync(auditPath, '{"step":1}\n', 'utf8');
  // mtime is now (just written) — within threshold

  const result = buildIndex({ stallThresholdMs: 30 * 60 * 1000 });
  const entry = result.runs.find((r) => r.run_folder === `.claw/runs/${folderName}`);
  if (entry.stalled) throw new Error('expected stalled false for recent audit');
});

// -------------------------------------------------------------------------
// Test 10: Read-only safety
// -------------------------------------------------------------------------
console.log('\n--- read-only safety ---');

test('does not mutate filesystem', () => {
  const { absDir } = makeTempRun('readonly');
  const filesBefore = fs.readdirSync(absDir).sort();
  const statusBefore = fs.readFileSync(path.join(absDir, 'status.json'), 'utf8');

  buildIndex();

  const filesAfter = fs.readdirSync(absDir).sort();
  const statusAfter = fs.readFileSync(path.join(absDir, 'status.json'), 'utf8');
  if (JSON.stringify(filesBefore) !== JSON.stringify(filesAfter)) {
    throw new Error(`files changed: ${filesBefore} → ${filesAfter}`);
  }
  if (statusBefore !== statusAfter) throw new Error('status.json was modified');
});

test('no new run folders created', () => {
  const allRuns = fs.readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const newNonTest = allRuns.filter((n) => !n.startsWith('_test_') && !baselineRuns.has(n));
  if (newNonTest.length > 0) {
    throw new Error(`unexpected non-test runs: ${newNonTest.join(', ')}`);
  }
});

// -------------------------------------------------------------------------
// Test 11: Error on missing .claw/runs/
// -------------------------------------------------------------------------
console.log('\n--- error handling ---');

test('returns error if .claw/runs/ does not exist', () => {
  const result = buildIndex({ runsDir: '/tmp/_nonexistent_runs_dir_xyz' });
  if (result.ok) throw new Error('expected ok:false');
  if (!result.error.includes('does not exist')) throw new Error('wrong error: ' + result.error);
});

// -------------------------------------------------------------------------
// Test 12: CLI output
// -------------------------------------------------------------------------
console.log('\n--- CLI ---');

test('CLI outputs valid JSON to stdout', () => {
  const stdout = execFileSync('node', [INDEX_SCRIPT], { encoding: 'utf8', timeout: 10000 });
  const parsed = JSON.parse(stdout);
  if (!parsed.ok) throw new Error('expected ok:true from CLI');
  if (!Array.isArray(parsed.runs)) throw new Error('expected runs array');
});

test('shell helper outputs valid JSON', () => {
  const stdout = execFileSync('bash', [INDEX_SHELL], { encoding: 'utf8', timeout: 10000 });
  const parsed = JSON.parse(stdout);
  if (!parsed.ok) throw new Error('expected ok:true from shell helper');
});

// -------------------------------------------------------------------------
// Test 13: Output schema validation
// -------------------------------------------------------------------------
console.log('\n--- output schema ---');

const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));
const indexSchema = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'run-index.output.schema.json'), 'utf8'));

test('CLI output validates against run-index.output.schema.json', () => {
  const stdout = execFileSync('node', [INDEX_SCRIPT], { encoding: 'utf8', timeout: 10000 });
  const parsed = JSON.parse(stdout);
  const v = validateAgainstSchema(parsed, indexSchema);
  if (!v.ok) throw new Error(`schema validation failed: ${v.details.join('; ')}`);
});

test('programmatic output validates against schema', () => {
  const result = buildIndex();
  const v = validateAgainstSchema(result, indexSchema);
  if (!v.ok) throw new Error(`schema validation failed: ${v.details.join('; ')}`);
});

test('empty runs dir validates against schema', () => {
  const tmpRunsDir = path.join(os.tmpdir(), `_test_idx_schema_empty_${Date.now()}`);
  fs.mkdirSync(tmpRunsDir, { recursive: true });
  tmpDirs.push(tmpRunsDir);
  const result = buildIndex({ runsDir: tmpRunsDir });
  const v = validateAgainstSchema(result, indexSchema);
  if (!v.ok) throw new Error(`schema validation failed: ${v.details.join('; ')}`);
});

// -------------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------------
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
