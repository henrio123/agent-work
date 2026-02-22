#!/usr/bin/env node
'use strict';

/**
 * Tests for watch-run.js — read-only run folder watcher.
 * Run: node skills/dev-pipeline/tests/test-run-next-watch.js
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WATCH = path.resolve(__dirname, '..', 'scripts', 'watch-run.js');
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
const RUNS_DIR = path.join(WORKSPACE_ROOT, '.claw', 'runs');
fs.mkdirSync(RUNS_DIR, { recursive: true });
const baselineRuns = new Set(fs.readdirSync(RUNS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory()).map((e) => e.name));

const { watchRun } = require(path.resolve(__dirname, '..', 'scripts', 'watch-run.js'));

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

function makeTempRun(name, statusOverrides = {}) {
  const folderName = `_test_${name}_${Date.now()}`;
  const absDir = path.join(RUNS_DIR, folderName);
  fs.mkdirSync(absDir, { recursive: true });
  tmpDirs.push(absDir);

  const relDir = `.claw/runs/${folderName}`;

  const status = {
    ticket_id: 'TEST-WATCH',
    title: 'Test watch mode',
    project: 'test',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    current_stage: 'analyze',
    blocked: false,
    blocked_reason: null,
    required_user_input: [],
    stage_history: [
      { stage: 'intake', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:00:01.000Z', artifact_paths: ['00-intake.json'] },
      { stage: 'analyze', started_at: '2026-01-01T00:00:01.000Z', finished_at: null, artifact_paths: [], role: 'PM' },
    ],
    next_actions: [],
    ...statusOverrides,
  };
  fs.writeFileSync(path.join(absDir, 'status.json'), JSON.stringify(status, null, 2), 'utf8');

  return { relDir, absDir };
}

function runWatch(...args) {
  try {
    const stdout = execFileSync('node', [WATCH, ...args], {
      encoding: 'utf8',
      timeout: 10000,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e) {
    return { stdout: e.stdout || '', stderr: e.stderr || '', exitCode: e.status };
  }
}

function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
process.on('exit', cleanup);

// -------------------------------------------------------------------------
// Test 1: CLI path validation
// -------------------------------------------------------------------------
console.log('\n--- path validation ---');

test('rejects absolute path', () => {
  const r = runWatch('/tmp/evil', '--max_events', '1');
  if (r.exitCode === 0) throw new Error('should reject absolute path');
  if (!r.stderr.includes('absolute paths not allowed')) throw new Error('wrong error: ' + r.stderr);
});

test('rejects path without .claw/runs/ prefix', () => {
  const r = runWatch('notaruns/folder', '--max_events', '1');
  if (r.exitCode === 0) throw new Error('should reject non-runs path');
  if (!r.stderr.includes('path must start with .claw/runs/')) throw new Error('wrong error: ' + r.stderr);
});

test('rejects path traversal', () => {
  const r = runWatch('.claw/runs/../../../tmp/evil', '--max_events', '1');
  if (r.exitCode === 0) throw new Error('should reject traversal');
  if (!r.stderr.includes('path traversal not allowed')) throw new Error('wrong error: ' + r.stderr);
});

test('rejects non-existent run folder', () => {
  const r = runWatch('.claw/runs/_ghost_nonexistent', '--max_events', '1');
  // The node script should report error event and exit 1
  if (r.exitCode === 0) {
    // Check if it emitted an error event
    if (!r.stdout.includes('"error"')) throw new Error('should report error for missing folder');
  }
});

// -------------------------------------------------------------------------
// Test 2: status_snapshot on initial read
// -------------------------------------------------------------------------
console.log('\n--- status_snapshot ---');

test('emits status_snapshot on first poll', () => {
  const { relDir } = makeTempRun('watch-snapshot');
  const events = [];
  watchRun(relDir, {
    maxEvents: 1,
    onEvent: (e) => events.push(e),
  });

  if (events.length === 0) throw new Error('no events emitted');
  if (events[0].event !== 'status_snapshot') throw new Error(`expected status_snapshot, got ${events[0].event}`);
  if (!events[0].status) throw new Error('missing status in snapshot');
  if (events[0].status.ticket_id !== 'TEST-WATCH') throw new Error('wrong ticket_id');
  if (events[0].run_folder !== relDir) throw new Error('wrong run_folder');
  if (typeof events[0].ts !== 'string') throw new Error('missing ts');
});

// -------------------------------------------------------------------------
// Test 3: status_changed on modification
// -------------------------------------------------------------------------
console.log('\n--- status_changed ---');

test('emits status_changed when status.json modified', () => {
  const { relDir, absDir } = makeTempRun('watch-changed');
  const events = [];
  let pollCount = 0;

  // Use onEvent to modify status after first event
  watchRun(relDir, {
    maxEvents: 2,
    onEvent: (e) => {
      events.push(e);
      if (events.length === 1) {
        // Modify status.json after snapshot
        const status = JSON.parse(fs.readFileSync(path.join(absDir, 'status.json'), 'utf8'));
        status.current_stage = 'plan';
        status.updated_at = new Date().toISOString();
        fs.writeFileSync(path.join(absDir, 'status.json'), JSON.stringify(status, null, 2), 'utf8');
      }
    },
  });

  if (events.length < 2) throw new Error(`expected 2 events, got ${events.length}`);
  if (events[0].event !== 'status_snapshot') throw new Error('first should be snapshot');
  if (events[1].event !== 'status_changed') throw new Error(`second should be status_changed, got ${events[1].event}`);
  if (events[1].status.current_stage !== 'plan') throw new Error('status_changed should reflect new stage');
});

// -------------------------------------------------------------------------
// Test 4: audit log following
// -------------------------------------------------------------------------
console.log('\n--- audit log ---');

test('emits audit_missing when no audit file', () => {
  const { relDir } = makeTempRun('watch-no-audit');
  const events = [];
  watchRun(relDir, {
    maxEvents: 2,
    followAudit: true,
    onEvent: (e) => events.push(e),
  });

  const auditEvents = events.filter((e) => e.event === 'audit_missing');
  if (auditEvents.length === 0) throw new Error('should emit audit_missing');
});

test('emits audit_line when audit log exists', () => {
  const { relDir, absDir } = makeTempRun('watch-audit');
  const auditPath = path.join(absDir, 'autonomous-audit.jsonl');
  const auditLine = JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', step: 1, action: 'none', stage: 'done', event: 'step', detail: 'test' });
  fs.writeFileSync(auditPath, auditLine + '\n', 'utf8');

  const events = [];
  watchRun(relDir, {
    maxEvents: 3,
    followAudit: true,
    onEvent: (e) => events.push(e),
  });

  const auditLines = events.filter((e) => e.event === 'audit_line');
  if (auditLines.length === 0) throw new Error('should emit audit_line');
  if (!auditLines[0].line || auditLines[0].line.step !== 1) throw new Error('audit_line should contain parsed line');
});

test('emits new audit lines appended after start', () => {
  const { relDir, absDir } = makeTempRun('watch-audit-append');
  const auditPath = path.join(absDir, 'autonomous-audit.jsonl');
  const line1 = JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', step: 1, action: 'x', stage: 'y', event: 'step', detail: 'first' });
  fs.writeFileSync(auditPath, line1 + '\n', 'utf8');

  const events = [];
  watchRun(relDir, {
    maxEvents: 4,
    followAudit: true,
    onEvent: (e) => {
      events.push(e);
      // After reading first audit line, append another
      const auditLineEvents = events.filter((ev) => ev.event === 'audit_line');
      if (auditLineEvents.length === 1 && !events._appended) {
        events._appended = true;
        const line2 = JSON.stringify({ ts: '2026-01-01T00:00:01.000Z', step: 2, action: 'z', stage: 'w', event: 'stop', detail: 'second' });
        fs.appendFileSync(auditPath, line2 + '\n', 'utf8');
      }
    },
  });

  const auditLines = events.filter((e) => e.event === 'audit_line');
  if (auditLines.length < 2) throw new Error(`expected at least 2 audit_line events, got ${auditLines.length}`);
});

// -------------------------------------------------------------------------
// Test 5: .stop signal detection
// -------------------------------------------------------------------------
console.log('\n--- stop signal ---');

test('emits stop_signal_present when .stop exists', () => {
  const { relDir, absDir } = makeTempRun('watch-stop');
  fs.writeFileSync(path.join(absDir, '.stop'), '', 'utf8');

  const events = [];
  watchRun(relDir, {
    maxEvents: 2,
    onEvent: (e) => events.push(e),
  });

  const stopEvents = events.filter((e) => e.event === 'stop_signal_present');
  if (stopEvents.length === 0) throw new Error('should emit stop_signal_present');
});

test('stop_signal_present not emitted if .stop absent', () => {
  const { relDir } = makeTempRun('watch-no-stop');
  const events = [];
  watchRun(relDir, {
    maxEvents: 2,
    onEvent: (e) => events.push(e),
  });

  const stopEvents = events.filter((e) => e.event === 'stop_signal_present');
  if (stopEvents.length > 0) throw new Error('should not emit stop_signal_present');
});

// -------------------------------------------------------------------------
// Test 6: max_events enforcement
// -------------------------------------------------------------------------
console.log('\n--- max_events ---');

test('respects max_events limit', () => {
  const { relDir, absDir } = makeTempRun('watch-maxevents');
  const auditPath = path.join(absDir, 'autonomous-audit.jsonl');
  // Write many audit lines
  const lines = [];
  for (let i = 0; i < 10; i++) {
    lines.push(JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', step: i, action: 'x', stage: 'y', event: 'step', detail: `line ${i}` }));
  }
  fs.writeFileSync(auditPath, lines.join('\n') + '\n', 'utf8');

  const events = [];
  watchRun(relDir, {
    maxEvents: 3,
    followAudit: true,
    onEvent: (e) => events.push(e),
  });

  if (events.length > 3) throw new Error(`expected max 3 events, got ${events.length}`);
});

// -------------------------------------------------------------------------
// Test 7: never mutates filesystem
// -------------------------------------------------------------------------
console.log('\n--- read-only safety ---');

test('watch never creates or modifies files in run folder', () => {
  const { relDir, absDir } = makeTempRun('watch-readonly');
  const filesBefore = fs.readdirSync(absDir).sort();
  const statusBefore = fs.readFileSync(path.join(absDir, 'status.json'), 'utf8');

  watchRun(relDir, {
    maxEvents: 2,
    followAudit: true,
    onEvent: () => {},
  });

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
// Test 8: JSONL output via CLI
// -------------------------------------------------------------------------
console.log('\n--- CLI output ---');

test('CLI outputs valid JSONL to stdout', () => {
  const { relDir } = makeTempRun('watch-cli');
  const r = runWatch(relDir, '--max_events', '1');
  if (r.exitCode !== 0) throw new Error(`expected exit 0, got ${r.exitCode}: ${r.stderr}`);
  const lines = r.stdout.trim().split('\n');
  if (lines.length === 0) throw new Error('no output');
  const first = JSON.parse(lines[0]);
  if (first.event !== 'status_snapshot') throw new Error(`expected status_snapshot, got ${first.event}`);
});

// -------------------------------------------------------------------------
// Test 9: shell helper path validation
// -------------------------------------------------------------------------
console.log('\n--- shell helper ---');

test('run-next-watch.sh rejects absolute path', () => {
  let exitCode = 0;
  try {
    execFileSync('bash', [path.join(WORKSPACE_ROOT, 'tools', 'run-next-watch.sh'), '/tmp/evil', '--max_events', '1'], {
      encoding: 'utf8',
      timeout: 5000,
    });
  } catch (e) {
    exitCode = e.status;
  }
  if (exitCode === 0) throw new Error('should reject absolute path');
});

test('run-next-watch.sh rejects traversal', () => {
  let exitCode = 0;
  try {
    execFileSync('bash', [path.join(WORKSPACE_ROOT, 'tools', 'run-next-watch.sh'), '.claw/runs/../../../tmp', '--max_events', '1'], {
      encoding: 'utf8',
      timeout: 5000,
    });
  } catch (e) {
    exitCode = e.status;
  }
  if (exitCode === 0) throw new Error('should reject traversal');
});

// -------------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------------
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
