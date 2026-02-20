#!/usr/bin/env node
'use strict';

/**
 * Tests for run_next_autonomous command.
 * Uses child_process to invoke CLI and a fake agent adapter for artifact generation.
 * Run: node skills/dev-pipeline/tests/test-run-next-autonomous.js
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DP = path.resolve(__dirname, '..', 'scripts', 'dev-pipeline.js');
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
const RUNS_DIR = path.join(WORKSPACE_ROOT, '.claw', 'runs');
fs.mkdirSync(RUNS_DIR, { recursive: true });

// Import autonomous runner and pipeline for direct function testing
const { runAutonomous, scaffoldAdapter, validateDraft, AUDIT_FILENAME, STOP_FILENAME } = require(path.resolve(__dirname, '..', 'scripts', 'autonomous-runner.js'));
const dp = require(path.resolve(__dirname, '..', 'scripts', 'dev-pipeline.js'));

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
      timeout: 30000,
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
    ticket_id: 'TEST-AUTO',
    title: 'Test autonomous runner',
    project: 'test',
    created_at: '2026-01-01T00:00:00.000Z',
    source: 'test',
  }, null, 2), 'utf8');

  const status = {
    ticket_id: 'TEST-AUTO',
    title: 'Test autonomous runner',
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
// Test 1: non-existent folder
// -------------------------------------------------------------------------
console.log('\n--- non-existent folder ---');

test('non-existent folder returns final_action error, creates nothing', () => {
  const ghostFolder = `.claw/runs/_test_auto_ghost_${Date.now()}`;
  const absGhost = path.join(WORKSPACE_ROOT, ghostFolder);

  const before = fs.readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name).sort();

  const r = runCmd('run_next_autonomous', ghostFolder);

  const after = fs.readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name).sort();

  if (!r.json) throw new Error(`No JSON: ${r.stdout} ${r.stderr}`);
  if (r.json.action !== 'autonomous_complete') throw new Error(`expected autonomous_complete, got ${r.json.action}`);
  if (r.json.final_action !== 'error') throw new Error(`expected error, got ${r.json.final_action}`);
  if (r.json.steps_run !== 0) throw new Error(`expected steps_run=0, got ${r.json.steps_run}`);
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

test('done stage stops immediately with final_action none', () => {
  const { relDir, absDir } = makeTempRun('auto-done', { current_stage: 'done' });
  const filesBefore = fs.readdirSync(absDir).sort();

  const r = runCmd('run_next_autonomous', relDir);
  if (r.json.final_action !== 'none') throw new Error(`expected none, got ${r.json.final_action}`);
  if (r.json.steps_run !== 1) throw new Error(`expected 1 step`);
  if (r.json.agent_calls !== 0) throw new Error(`expected 0 agent calls`);
  if (r.json.artifacts_written.length !== 0) throw new Error('unexpected artifacts written');

  // No file changes
  const filesAfter = fs.readdirSync(absDir).sort();
  if (JSON.stringify(filesBefore) !== JSON.stringify(filesAfter)) throw new Error('files changed in done run');
});

// -------------------------------------------------------------------------
// Test 3: intake → task-pack → pm-ready → needs_artifacts (via direct call)
// -------------------------------------------------------------------------
console.log('\n--- intake with scaffold adapter ---');

test('intake stage generates task pack then stops at needs_artifacts', () => {
  const { relDir, absDir } = makeTempRun('auto-intake', {
    current_stage: 'intake',
    stage_history: [
      { stage: 'intake', started_at: '2026-01-01T00:00:00.000Z', finished_at: null, artifact_paths: ['00-intake.json'] },
    ],
  });

  // Use direct function call with scaffold adapter to avoid Claude Code dependency
  const result = runAutonomous(relDir, {
    maxSteps: 10,
    maxAgentCalls: 5,
    agentAdapter: scaffoldAdapter,
  });

  if (result.final_action === 'error') throw new Error(`error: ${result.trace.join('; ')}`);

  // Should have generated task pack and advanced to pm-ready, then produced PM artifact
  if (!result.trace.some((t) => t.includes('generating task pack'))) {
    throw new Error('did not generate task pack');
  }
  if (result.agent_calls < 1) throw new Error(`expected at least 1 agent call, got ${result.agent_calls}`);
  if (!result.artifacts_written.includes('10-pm-brief.json')) {
    throw new Error(`expected 10-pm-brief.json written, got: ${result.artifacts_written.join(', ')}`);
  }

  // Verify artifact file actually exists
  if (!fs.existsSync(path.join(absDir, '10-pm-brief.json'))) {
    throw new Error('10-pm-brief.json not on disk');
  }
});

// -------------------------------------------------------------------------
// Test 4: needs_artifacts with scaffold adapter — writes artifacts and advances
// -------------------------------------------------------------------------
console.log('\n--- needs_artifacts with scaffold adapter ---');

test('pm-ready with task file: scaffold adapter writes PM brief and advances', () => {
  const { relDir, absDir } = makeTempRun('auto-pm');
  // Create task file so run_next_safe returns needs_artifacts
  fs.writeFileSync(path.join(absDir, '31-pm-claude-task.txt'), 'PM task content', 'utf8');

  const result = runAutonomous(relDir, {
    maxSteps: 10,
    maxAgentCalls: 5,
    agentAdapter: scaffoldAdapter,
  });

  if (result.final_action === 'error') throw new Error(`error: ${result.trace.join('; ')}`);
  if (!result.artifacts_written.includes('10-pm-brief.json')) {
    throw new Error(`expected 10-pm-brief.json in artifacts_written`);
  }
  if (result.agent_calls < 1) throw new Error('expected at least 1 agent call');

  // Should have advanced beyond pm-ready
  const status = JSON.parse(fs.readFileSync(path.join(absDir, 'status.json'), 'utf8'));
  if (status.current_stage === 'pm-ready') {
    throw new Error('still at pm-ready after writing artifact');
  }
});

test('dev-ready: scaffold adapter writes diff and notes, advances to qa-ready', () => {
  const { relDir, absDir } = makeTempRun('auto-dev', {
    current_stage: 'dev-ready',
    stage_history: [
      { stage: 'intake', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:00:01.000Z', artifact_paths: ['00-intake.json'] },
      { stage: 'dev-ready', started_at: '2026-01-01T00:00:02.000Z', finished_at: null, artifact_paths: [], role: 'Dev' },
    ],
  });
  fs.writeFileSync(path.join(absDir, '34-dev-claude-task.txt'), 'Dev task content', 'utf8');

  const result = runAutonomous(relDir, {
    maxSteps: 10,
    maxAgentCalls: 5,
    agentAdapter: scaffoldAdapter,
  });

  if (result.final_action === 'error') throw new Error(`error: ${result.trace.join('; ')}`);
  if (!result.artifacts_written.includes('40-dev-patch.diff')) throw new Error('missing diff');
  if (!result.artifacts_written.includes('41-dev-notes.json')) throw new Error('missing notes');

  const status = JSON.parse(fs.readFileSync(path.join(absDir, 'status.json'), 'utf8'));
  if (status.current_stage === 'dev-ready') {
    throw new Error('still at dev-ready');
  }
});

// -------------------------------------------------------------------------
// Test 5: dry_run mode
// -------------------------------------------------------------------------
console.log('\n--- dry_run ---');

test('dry_run returns needs_artifacts without invoking agent', () => {
  const { relDir, absDir } = makeTempRun('auto-dry');
  fs.writeFileSync(path.join(absDir, '31-pm-claude-task.txt'), 'PM task', 'utf8');

  const r = runCmd('run_next_autonomous', relDir, '--dry_run');
  if (r.json.final_action !== 'needs_artifacts') throw new Error(`expected needs_artifacts, got ${r.json.final_action}`);
  if (r.json.agent_calls !== 0) throw new Error('agent should not be called in dry_run');
  if (!r.json.trace.some((t) => t.includes('dry_run'))) throw new Error('missing dry_run trace');
  // No artifact files should exist
  if (fs.existsSync(path.join(absDir, '10-pm-brief.json'))) throw new Error('artifact created in dry_run');
});

// -------------------------------------------------------------------------
// Test 6: blocked stage
// -------------------------------------------------------------------------
console.log('\n--- blocked ---');

test('blocked stage stops with final_action blocked', () => {
  const { relDir } = makeTempRun('auto-blocked', {
    current_stage: 'blocked',
    blocked: true,
    blocked_reason: 'need answer',
    required_user_input: [
      { id: 'inp-1', prompt: 'What?', options: null, default: null, status: 'pending', answer: null },
    ],
  });
  const result = runAutonomous(relDir, { maxSteps: 5, agentAdapter: scaffoldAdapter });
  if (result.final_action !== 'blocked') throw new Error(`expected blocked, got ${result.final_action}`);
  if (result.agent_calls !== 0) throw new Error('no agent calls on blocked');
});

// -------------------------------------------------------------------------
// Test 7: safety — no new directories under .claw/runs/
// -------------------------------------------------------------------------
console.log('\n--- safety ---');

test('autonomous runner does not create any new run directories', () => {
  const before = fs.readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const nonTestBefore = before.filter((n) => !n.startsWith('_test_'));

  // Run on a pm-ready with scaffold adapter
  const { relDir, absDir } = makeTempRun('auto-safety');
  fs.writeFileSync(path.join(absDir, '31-pm-claude-task.txt'), 'task', 'utf8');
  runAutonomous(relDir, { maxSteps: 10, maxAgentCalls: 3, agentAdapter: scaffoldAdapter });

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
  const nonTest = allRuns.filter((n) => !n.startsWith('_test_'));
  // After all tests, non-test run count should not have grown
  if (nonTest.length > 0) {
    throw new Error(`unexpected non-test runs: ${nonTest.join(', ')}`);
  }
});

// -------------------------------------------------------------------------
// Test 8: idempotency — rerun does not rewrite artifacts
// -------------------------------------------------------------------------
console.log('\n--- idempotency ---');

test('rerun after artifacts exist skips them and does not overwrite', () => {
  const { relDir, absDir } = makeTempRun('auto-idemp');
  fs.writeFileSync(path.join(absDir, '31-pm-claude-task.txt'), 'task', 'utf8');

  // First run writes artifact
  const r1 = runAutonomous(relDir, { maxSteps: 5, maxAgentCalls: 2, agentAdapter: scaffoldAdapter });
  if (!r1.artifacts_written.includes('10-pm-brief.json')) throw new Error('first run did not write artifact');

  // Record the content
  const content1 = fs.readFileSync(path.join(absDir, '10-pm-brief.json'), 'utf8');

  // Second run should not overwrite
  const r2 = runAutonomous(relDir, { maxSteps: 5, maxAgentCalls: 2, agentAdapter: scaffoldAdapter });
  const content2 = fs.readFileSync(path.join(absDir, '10-pm-brief.json'), 'utf8');

  if (content1 !== content2) throw new Error('artifact was overwritten');
  if (r2.artifacts_written.includes('10-pm-brief.json')) throw new Error('artifact should not appear in second run artifacts_written');
});

// -------------------------------------------------------------------------
// Test 9: output schema contract
// -------------------------------------------------------------------------
console.log('\n--- output schema contract ---');

test('output has all stable contract fields', () => {
  const { relDir } = makeTempRun('auto-contract', { current_stage: 'done' });
  const r = runCmd('run_next_autonomous', relDir);
  if (typeof r.json.ok !== 'boolean') throw new Error('missing ok');
  if (r.json.action !== 'autonomous_complete') throw new Error('missing action=autonomous_complete');
  if (typeof r.json.final_action !== 'string') throw new Error('missing final_action');
  if (typeof r.json.steps_run !== 'number') throw new Error('missing steps_run');
  if (typeof r.json.agent_calls !== 'number') throw new Error('missing agent_calls');
  if (!Array.isArray(r.json.artifacts_written)) throw new Error('missing artifacts_written');
  if (!Array.isArray(r.json.artifacts_skipped)) throw new Error('missing artifacts_skipped');
  if (!Array.isArray(r.json.trace)) throw new Error('missing trace');
});

// -------------------------------------------------------------------------
// Test 10: draft validation
// -------------------------------------------------------------------------
console.log('\n--- draft validation ---');

test('validateDraft rejects draft outside run folder', () => {
  const { absDir } = makeTempRun('auto-val-outside');
  const result = validateDraft('/tmp/evil.draft', '10-pm-brief.json', absDir);
  if (result.valid) throw new Error('should reject draft outside run folder');
});

test('validateDraft rejects when target already exists', () => {
  const { absDir } = makeTempRun('auto-val-exists');
  const draftPath = path.join(absDir, '10-pm-brief.json.draft');
  fs.writeFileSync(draftPath, '{"ticket_id":"X"}', 'utf8');
  fs.writeFileSync(path.join(absDir, '10-pm-brief.json'), '{}', 'utf8');
  const result = validateDraft(draftPath, '10-pm-brief.json', absDir);
  if (result.valid) throw new Error('should reject when target exists');
  fs.unlinkSync(draftPath);
});

test('validateDraft accepts valid JSON draft', () => {
  const { absDir } = makeTempRun('auto-val-ok');
  const schema = dp.loadArtifactSchema('10-pm-brief.json');
  const content = dp.generateMinimalValue(schema);
  content.ticket_id = 'TEST-AUTO';
  const draftPath = path.join(absDir, '10-pm-brief.json.draft');
  fs.writeFileSync(draftPath, JSON.stringify(content, null, 2), 'utf8');
  const result = validateDraft(draftPath, '10-pm-brief.json', absDir);
  if (!result.valid) throw new Error(`should accept valid draft: ${result.errors.join('; ')}`);
  fs.unlinkSync(draftPath);
});

// -------------------------------------------------------------------------
// Test 11: audit log — created when auditLog enabled
// -------------------------------------------------------------------------
console.log('\n--- audit log ---');

test('audit log is created when auditLog option is true', () => {
  const { relDir, absDir } = makeTempRun('auto-audit');
  fs.writeFileSync(path.join(absDir, '31-pm-claude-task.txt'), 'PM task', 'utf8');

  const result = runAutonomous(relDir, {
    maxSteps: 5,
    maxAgentCalls: 2,
    agentAdapter: scaffoldAdapter,
    auditLog: true,
  });

  const logPath = path.join(absDir, AUDIT_FILENAME);
  if (!fs.existsSync(logPath)) throw new Error('audit log file not created');

  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  if (lines.length === 0) throw new Error('audit log is empty');

  // Every line must be valid JSON
  for (const line of lines) {
    const obj = JSON.parse(line);
    if (typeof obj.ts !== 'string') throw new Error('missing ts');
    if (typeof obj.step !== 'number') throw new Error('missing step');
    if (typeof obj.event !== 'string') throw new Error('missing event');
    if (typeof obj.action !== 'string') throw new Error('missing action');
    if (typeof obj.stage !== 'string') throw new Error('missing stage');
    if (typeof obj.detail !== 'string') throw new Error('missing detail');
  }
});

test('audit log is NOT created when auditLog option is false', () => {
  const { relDir, absDir } = makeTempRun('auto-no-audit');
  fs.writeFileSync(path.join(absDir, '31-pm-claude-task.txt'), 'PM task', 'utf8');

  runAutonomous(relDir, {
    maxSteps: 5,
    maxAgentCalls: 2,
    agentAdapter: scaffoldAdapter,
    auditLog: false,
  });

  const logPath = path.join(absDir, AUDIT_FILENAME);
  if (fs.existsSync(logPath)) throw new Error('audit log should not exist when disabled');
});

test('audit log contains agent_invoke and artifact_write events', () => {
  const { relDir, absDir } = makeTempRun('auto-audit-events');
  fs.writeFileSync(path.join(absDir, '31-pm-claude-task.txt'), 'PM task', 'utf8');

  runAutonomous(relDir, {
    maxSteps: 5,
    maxAgentCalls: 2,
    agentAdapter: scaffoldAdapter,
    auditLog: true,
  });

  const logPath = path.join(absDir, AUDIT_FILENAME);
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  const events = lines.map((l) => l.event);
  if (!events.includes('agent_invoke')) throw new Error('missing agent_invoke event');
  if (!events.includes('artifact_write')) throw new Error('missing artifact_write event');
});

test('audit log contains stop event on done stage', () => {
  const { relDir, absDir } = makeTempRun('auto-audit-done', { current_stage: 'done' });

  runAutonomous(relDir, {
    maxSteps: 5,
    agentAdapter: scaffoldAdapter,
    auditLog: true,
  });

  const logPath = path.join(absDir, AUDIT_FILENAME);
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  const stopLines = lines.filter((l) => l.event === 'stop');
  if (stopLines.length === 0) throw new Error('missing stop event');
  if (!stopLines[0].detail.includes('final_action=none')) throw new Error('stop detail should include final_action=none');
});

test('audit log appends on rerun (does not truncate)', () => {
  const { relDir, absDir } = makeTempRun('auto-audit-append');
  fs.writeFileSync(path.join(absDir, '31-pm-claude-task.txt'), 'PM task', 'utf8');

  // First run
  runAutonomous(relDir, {
    maxSteps: 5,
    maxAgentCalls: 2,
    agentAdapter: scaffoldAdapter,
    auditLog: true,
  });

  const logPath = path.join(absDir, AUDIT_FILENAME);
  const linesAfterFirst = fs.readFileSync(logPath, 'utf8').trim().split('\n').length;

  // Second run (idempotent — artifacts already exist)
  runAutonomous(relDir, {
    maxSteps: 5,
    maxAgentCalls: 2,
    agentAdapter: scaffoldAdapter,
    auditLog: true,
  });

  const linesAfterSecond = fs.readFileSync(logPath, 'utf8').trim().split('\n').length;
  if (linesAfterSecond <= linesAfterFirst) throw new Error(`expected more lines after second run: ${linesAfterFirst} → ${linesAfterSecond}`);
});

test('audit log via CLI --audit_log flag', () => {
  const { relDir, absDir } = makeTempRun('auto-audit-cli', { current_stage: 'done' });

  runCmd('run_next_autonomous', relDir, '--audit_log');

  const logPath = path.join(absDir, AUDIT_FILENAME);
  if (!fs.existsSync(logPath)) throw new Error('audit log not created via CLI flag');
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  if (lines.length === 0) throw new Error('audit log is empty via CLI');
  // Validate first line is valid JSON
  const first = JSON.parse(lines[0]);
  if (typeof first.ts !== 'string') throw new Error('invalid log line from CLI');
});

// -------------------------------------------------------------------------
// Test 12: stop signal — .stop file triggers stopped
// -------------------------------------------------------------------------
console.log('\n--- stop signal ---');

test('stop signal triggers final_action stopped', () => {
  const { relDir, absDir } = makeTempRun('auto-stop');
  fs.writeFileSync(path.join(absDir, '31-pm-claude-task.txt'), 'PM task', 'utf8');

  // Create .stop before running
  fs.writeFileSync(path.join(absDir, STOP_FILENAME), '', 'utf8');

  const result = runAutonomous(relDir, {
    maxSteps: 10,
    maxAgentCalls: 5,
    agentAdapter: scaffoldAdapter,
    progress: false,
  });

  if (result.final_action !== 'stopped') throw new Error(`expected stopped, got ${result.final_action}`);
  if (result.agent_calls !== 0) throw new Error('no agent calls expected when stopped');
  if (!result.trace.some((t) => t.includes('stop signal'))) throw new Error('missing stop signal trace');
});

test('stop signal emits audit log stop event', () => {
  const { relDir, absDir } = makeTempRun('auto-stop-audit');
  fs.writeFileSync(path.join(absDir, '31-pm-claude-task.txt'), 'PM task', 'utf8');
  fs.writeFileSync(path.join(absDir, STOP_FILENAME), '', 'utf8');

  runAutonomous(relDir, {
    maxSteps: 5,
    agentAdapter: scaffoldAdapter,
    auditLog: true,
    progress: false,
  });

  const logPath = path.join(absDir, AUDIT_FILENAME);
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const stopLines = lines.filter((l) => l.event === 'stop');
  if (stopLines.length === 0) throw new Error('missing stop event in audit log');
  if (!stopLines[0].detail.includes('.stop')) throw new Error('stop event should mention .stop file');
});

test('stop signal exits 0 via CLI', () => {
  const { relDir, absDir } = makeTempRun('auto-stop-cli');
  fs.writeFileSync(path.join(absDir, STOP_FILENAME), '', 'utf8');

  const r = runCmd('run_next_autonomous', relDir);
  if (r.exitCode !== 0) throw new Error(`expected exit 0, got ${r.exitCode}`);
  if (r.json.final_action !== 'stopped') throw new Error(`expected stopped, got ${r.json.final_action}`);
});

// -------------------------------------------------------------------------
// Test 13: resume — .stop removed, runner continues
// -------------------------------------------------------------------------
console.log('\n--- resume ---');

test('resume after stop removal continues from current state', () => {
  const { relDir, absDir } = makeTempRun('auto-resume');
  fs.writeFileSync(path.join(absDir, '31-pm-claude-task.txt'), 'PM task', 'utf8');

  // First run: stopped
  fs.writeFileSync(path.join(absDir, STOP_FILENAME), '', 'utf8');
  const r1 = runAutonomous(relDir, {
    maxSteps: 5,
    agentAdapter: scaffoldAdapter,
    progress: false,
  });
  if (r1.final_action !== 'stopped') throw new Error(`first run should be stopped, got ${r1.final_action}`);

  // Remove stop signal (resume)
  fs.unlinkSync(path.join(absDir, STOP_FILENAME));

  // Second run: continues and writes artifacts
  const r2 = runAutonomous(relDir, {
    maxSteps: 10,
    maxAgentCalls: 5,
    agentAdapter: scaffoldAdapter,
    progress: false,
  });
  if (r2.final_action === 'stopped') throw new Error('second run should not be stopped');
  if (r2.agent_calls < 1) throw new Error('expected agent calls after resume');
});

// -------------------------------------------------------------------------
// Test 14: progress output goes to stderr, not stdout
// -------------------------------------------------------------------------
console.log('\n--- progress output ---');

test('progress output does not appear in JSON stdout via CLI', () => {
  const { relDir, absDir } = makeTempRun('auto-progress', { current_stage: 'done' });

  const r = runCmd('run_next_autonomous', relDir);
  // stdout must be valid JSON (the ok() wrapper)
  if (!r.json) throw new Error('stdout is not valid JSON');
  if (r.json.action !== 'autonomous_complete') throw new Error('unexpected action');
  // progress lines go to stderr, not stdout — so stdout should be clean JSON
  const lines = r.stdout.trim().split('\n');
  // First line should start with { (JSON)
  if (!lines[0].trim().startsWith('{')) throw new Error(`stdout first line is not JSON: ${lines[0]}`);
});

// -------------------------------------------------------------------------
// Test 15: dashboard summary — last_autonomous_* fields in status.json
// -------------------------------------------------------------------------
console.log('\n--- dashboard summary ---');

test('status.json updated with last_autonomous_* after CLI run', () => {
  const { relDir, absDir } = makeTempRun('auto-dashboard', { current_stage: 'done' });

  runCmd('run_next_autonomous', relDir);

  const status = JSON.parse(fs.readFileSync(path.join(absDir, 'status.json'), 'utf8'));
  if (typeof status.last_autonomous_run_at !== 'string') throw new Error('missing last_autonomous_run_at');
  if (!status.last_autonomous_summary) throw new Error('missing last_autonomous_summary');
  if (status.last_autonomous_summary.final_action !== 'none') {
    throw new Error(`expected final_action=none in summary, got ${status.last_autonomous_summary.final_action}`);
  }
  if (typeof status.last_autonomous_summary.steps_run !== 'number') throw new Error('missing steps_run in summary');
});

test('last_autonomous_summary does not break status command', () => {
  const { relDir, absDir } = makeTempRun('auto-dashboard-compat', { current_stage: 'done' });

  // Run autonomous to write dashboard fields
  runCmd('run_next_autonomous', relDir);

  // Status command should still work
  const r = runCmd('status', relDir);
  if (!r.json || !r.json.ok) throw new Error(`status command failed: ${r.stderr}`);
});

// -------------------------------------------------------------------------
// Test 16: stop/resume shell helpers
// -------------------------------------------------------------------------
console.log('\n--- stop/resume helpers ---');

test('run-next-stop.sh creates .stop file via relative path', () => {
  const { relDir, absDir } = makeTempRun('auto-stop-helper');
  const stopPath = path.join(absDir, STOP_FILENAME);

  execFileSync('bash', [path.join(WORKSPACE_ROOT, 'tools', 'run-next-stop.sh'), relDir], {
    encoding: 'utf8',
    timeout: 5000,
    cwd: WORKSPACE_ROOT,
  });

  if (!fs.existsSync(stopPath)) throw new Error('.stop file not created by helper');
});

test('run-next-resume.sh removes .stop file via relative path', () => {
  const { relDir, absDir } = makeTempRun('auto-resume-helper');
  const stopPath = path.join(absDir, STOP_FILENAME);
  fs.writeFileSync(stopPath, '', 'utf8');

  execFileSync('bash', [path.join(WORKSPACE_ROOT, 'tools', 'run-next-resume.sh'), relDir], {
    encoding: 'utf8',
    timeout: 5000,
    cwd: WORKSPACE_ROOT,
  });

  if (fs.existsSync(stopPath)) throw new Error('.stop file not removed by helper');
});

test('run-next-stop.sh refuses absolute path', () => {
  const { absDir } = makeTempRun('auto-stop-abs');
  let exitCode = 0;
  try {
    execFileSync('bash', [path.join(WORKSPACE_ROOT, 'tools', 'run-next-stop.sh'), absDir], {
      encoding: 'utf8',
      timeout: 5000,
    });
  } catch (e) {
    exitCode = e.status;
  }
  if (exitCode === 0) throw new Error('should reject absolute path');
});

test('run-next-stop.sh refuses path without .claw/runs/ prefix', () => {
  let exitCode = 0;
  try {
    execFileSync('bash', [path.join(WORKSPACE_ROOT, 'tools', 'run-next-stop.sh'), '/tmp/evil'], {
      encoding: 'utf8',
      timeout: 5000,
    });
  } catch (e) {
    exitCode = e.status;
  }
  if (exitCode === 0) throw new Error('should reject /tmp path');
});

test('run-next-stop.sh refuses path traversal', () => {
  let exitCode = 0;
  try {
    execFileSync('bash', [path.join(WORKSPACE_ROOT, 'tools', 'run-next-stop.sh'), '.claw/runs/../../../tmp/evil'], {
      encoding: 'utf8',
      timeout: 5000,
    });
  } catch (e) {
    exitCode = e.status;
  }
  if (exitCode === 0) throw new Error('should reject traversal path');
});

test('run-next-resume.sh refuses absolute path', () => {
  const { absDir } = makeTempRun('auto-resume-abs');
  let exitCode = 0;
  try {
    execFileSync('bash', [path.join(WORKSPACE_ROOT, 'tools', 'run-next-resume.sh'), absDir], {
      encoding: 'utf8',
      timeout: 5000,
    });
  } catch (e) {
    exitCode = e.status;
  }
  if (exitCode === 0) throw new Error('should reject absolute path');
});

// -------------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------------
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
