#!/usr/bin/env node
'use strict';

/**
 * Tests for role-to-stage enforcement via --agent_id flag.
 * Run: node skills/dev-pipeline/tests/test-role-enforcement.js
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = path.resolve(os.homedir(), 'dev', 'agent-work');
const DP_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'dev-pipeline.js');
const AGENT_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'agent-state.js');
const RUNNER_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'autonomous-runner.js');

const { checkRoleForStage, STAGE_CONFIG, generateMinimalValue } = require(DP_SCRIPT);
const { initAgent } = require(AGENT_SCRIPT);
const { runAutonomous, scaffoldAdapter } = require(RUNNER_SCRIPT);

let passed = 0;
let failed = 0;
const tmpDirs = [];       // temp dirs outside workspace (for programmatic tests)
const wsTestDirs = [];    // dirs inside workspace (for CLI/runner tests)
const wsTestAgents = [];  // agents in real workspace (for cleanup)

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

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `_test_role_enf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

// Create a test run inside WORKSPACE_ROOT/runs/ so CLI commands and safePath work
function createWorkspaceRun(stage, ticketId) {
  const suffix = `_test_role_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const runsDir = path.join(WORKSPACE_ROOT, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const runFolder = path.join(runsDir, suffix);
  fs.mkdirSync(runFolder, { recursive: true });
  wsTestDirs.push(runFolder);

  const statusData = {
    ticket_id: ticketId || 'TEST-ROLE',
    title: 'Role enforcement test',
    project: 'test',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    current_stage: stage,
    blocked: false,
    blocked_reason: null,
    required_user_input: [],
    stage_history: [{ stage, started_at: new Date().toISOString(), finished_at: null, artifact_paths: [] }],
    next_actions: [],
  };
  fs.writeFileSync(path.join(runFolder, 'status.json'), JSON.stringify(statusData, null, 2), 'utf8');
  fs.writeFileSync(path.join(runFolder, '00-intake.json'), JSON.stringify({
    ticket_id: ticketId || 'TEST-ROLE', title: 'Role enforcement test', project: 'test',
    created_at: new Date().toISOString(), source: 'test',
  }, null, 2), 'utf8');

  return runFolder;
}

function createWorkspaceAgent(agentId, role) {
  const fp = path.join(WORKSPACE_ROOT, 'agents', agentId, 'state.json');
  if (!fs.existsSync(fp)) {
    initAgent(agentId, role);
    wsTestAgents.push(agentId);
  }
}

function createMinimalPMBrief(runFolder) {
  const schema = JSON.parse(fs.readFileSync(
    path.resolve(WORKSPACE_ROOT, 'skills/dev-pipeline/references/pm-brief.schema.json'), 'utf8'));
  const minimal = generateMinimalValue(schema);
  minimal.ticket_id = 'TEST-ROLE';
  fs.writeFileSync(path.join(runFolder, '10-pm-brief.json'), JSON.stringify(minimal, null, 2), 'utf8');
}

function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true }); } catch (_) {}
  }
  for (const dir of wsTestDirs) {
    try { fs.rmSync(dir, { recursive: true }); } catch (_) {}
  }
  const agentsDir = path.join(WORKSPACE_ROOT, 'agents');
  for (const id of wsTestAgents) {
    try { fs.rmSync(path.join(agentsDir, id), { recursive: true }); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
console.log('\n--- checkRoleForStage ---');
// ---------------------------------------------------------------------------

test('returns ok with skipped when no agent_id (backward compat)', () => {
  const result = checkRoleForStage(null, 'pm-ready');
  assert(result.ok === true, 'should be ok');
  assert(result.skipped === true, 'should be skipped');
});

test('returns ok with skipped for non-role stage (intake)', () => {
  const result = checkRoleForStage('any-agent', 'intake');
  assert(result.ok === true, 'should be ok');
  assert(result.skipped === true, 'should be skipped');
});

test('returns ok with skipped for non-role stage (task-pack-generated)', () => {
  const result = checkRoleForStage('any-agent', 'task-pack-generated');
  assert(result.ok === true, 'should be ok');
});

test('returns ok with skipped for non-role stage (done)', () => {
  const result = checkRoleForStage('any-agent', 'done');
  assert(result.ok === true, 'should be ok');
});

test('returns ok with skipped for non-role stage (blocked)', () => {
  const result = checkRoleForStage('any-agent', 'blocked');
  assert(result.ok === true, 'should be ok');
});

test('returns ok for correct role (PM at pm-ready)', () => {
  const agentsDir = makeTempDir();
  initAgent('_test_pm_check', 'PM', { agentsDir });
  const result = checkRoleForStage('_test_pm_check', 'pm-ready', { agentsDir });
  assert(result.ok === true, 'should be ok');
  assert(result.role === 'PM', 'role should be PM');
  assert(result.stage === 'pm-ready', 'stage should be pm-ready');
});

test('returns ok for correct role (Dev at dev-ready)', () => {
  const agentsDir = makeTempDir();
  initAgent('_test_dev_check', 'Dev', { agentsDir });
  const result = checkRoleForStage('_test_dev_check', 'dev-ready', { agentsDir });
  assert(result.ok === true, 'should be ok');
});

test('returns error for wrong role (DEV agent at pm-ready)', () => {
  const agentsDir = makeTempDir();
  initAgent('_test_wrong_role', 'Dev', { agentsDir });
  const result = checkRoleForStage('_test_wrong_role', 'pm-ready', { agentsDir });
  assert(result.ok === false, 'should not be ok');
  assert(result.error.includes('Role mismatch'), `error should mention mismatch: ${result.error}`);
  assert(result.error.includes('Dev'), 'should mention agent role');
  assert(result.error.includes('PM'), 'should mention required role');
});

test('returns error for wrong role (QA agent at arch-ready)', () => {
  const agentsDir = makeTempDir();
  initAgent('_test_qa_wrong', 'QA', { agentsDir });
  const result = checkRoleForStage('_test_qa_wrong', 'arch-ready', { agentsDir });
  assert(result.ok === false, 'should not be ok');
  assert(result.error.includes('Architect'), 'should mention required Architect role');
});

test('returns error for nonexistent agent', () => {
  const agentsDir = makeTempDir();
  const result = checkRoleForStage('_nonexistent_agent', 'pm-ready', { agentsDir });
  assert(result.ok === false, 'should not be ok');
  assert(result.error.includes('not found'), `error should mention not found: ${result.error}`);
});

test('checks all 5 STAGE_CONFIG roles', () => {
  const agentsDir = makeTempDir();
  const roles = [
    { stage: 'pm-ready', role: 'PM' },
    { stage: 'arch-ready', role: 'Architect' },
    { stage: 'dev-ready', role: 'Dev' },
    { stage: 'qa-ready', role: 'QA' },
    { stage: 'review', role: 'Review' },
  ];
  for (const { stage, role } of roles) {
    const agentId = `_test_role_${role.toLowerCase()}`;
    initAgent(agentId, role, { agentsDir });
    const result = checkRoleForStage(agentId, stage, { agentsDir });
    assert(result.ok === true, `${role} at ${stage} should be ok`);
  }
});

// ---------------------------------------------------------------------------
console.log('\n--- CLI record_artifact ---');
// ---------------------------------------------------------------------------

test('record_artifact rejects wrong role via --agent_id', () => {
  createWorkspaceAgent('_test_cli_dev_re', 'Dev');
  const runFolder = createWorkspaceRun('pm-ready');
  createMinimalPMBrief(runFolder);

  let exitedNonZero = false;
  try {
    execFileSync('node', [DP_SCRIPT, 'record_artifact', runFolder,
      path.join(runFolder, '10-pm-brief.json'), '--agent_id', '_test_cli_dev_re'], {
      encoding: 'utf8', stdio: 'pipe',
    });
  } catch (e) {
    exitedNonZero = true;
    assert(e.status === 1, 'should exit 1');
    const stderr = e.stderr || '';
    assert(stderr.includes('Role mismatch'), `stderr should mention mismatch: ${stderr}`);
  }
  assert(exitedNonZero, 'should have failed');
});

test('record_artifact accepts correct role via --agent_id', () => {
  createWorkspaceAgent('_test_cli_pm_re', 'PM');
  const runFolder = createWorkspaceRun('pm-ready');
  createMinimalPMBrief(runFolder);

  const out = execFileSync('node', [DP_SCRIPT, 'record_artifact', runFolder,
    path.join(runFolder, '10-pm-brief.json'), '--agent_id', '_test_cli_pm_re'], {
    encoding: 'utf8',
  });
  const parsed = JSON.parse(out);
  assert(parsed.ok === true, 'should be ok');
  assert(parsed.valid === true, 'artifact should be valid');
});

test('record_artifact works without --agent_id (backward compat)', () => {
  const runFolder = createWorkspaceRun('pm-ready');
  createMinimalPMBrief(runFolder);

  const out = execFileSync('node', [DP_SCRIPT, 'record_artifact', runFolder,
    path.join(runFolder, '10-pm-brief.json')], { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  assert(parsed.ok === true, 'should be ok');
});

// ---------------------------------------------------------------------------
console.log('\n--- CLI advance ---');
// ---------------------------------------------------------------------------

test('advance rejects wrong role via --agent_id', () => {
  createWorkspaceAgent('_test_cli_dev_adv', 'Dev');
  const runFolder = createWorkspaceRun('pm-ready');
  createMinimalPMBrief(runFolder);

  let exitedNonZero = false;
  try {
    execFileSync('node', [DP_SCRIPT, 'advance', runFolder, '--confirm',
      '--agent_id', '_test_cli_dev_adv'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    exitedNonZero = true;
    assert(e.status === 1, 'should exit 1');
    const stderr = e.stderr || '';
    assert(stderr.includes('Role mismatch'), `stderr should mention mismatch: ${stderr}`);
  }
  assert(exitedNonZero, 'should have failed');
});

test('advance accepts correct role via --agent_id', () => {
  createWorkspaceAgent('_test_cli_pm_adv', 'PM');
  const runFolder = createWorkspaceRun('pm-ready');
  createMinimalPMBrief(runFolder);

  const out = execFileSync('node', [DP_SCRIPT, 'advance', runFolder, '--confirm',
    '--agent_id', '_test_cli_pm_adv'], { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  assert(parsed.ok === true, 'should be ok');
  assert(parsed.advanced_to === 'arch-ready', 'should advance to arch-ready');
});

// ---------------------------------------------------------------------------
console.log('\n--- CLI orchestrate_one ---');
// ---------------------------------------------------------------------------

test('orchestrate_one rejects wrong role via --agent_id', () => {
  createWorkspaceAgent('_test_cli_qa_orch', 'QA');
  const runFolder = createWorkspaceRun('pm-ready');

  let exitedNonZero = false;
  try {
    execFileSync('node', [DP_SCRIPT, 'orchestrate_one', runFolder,
      '--agent_id', '_test_cli_qa_orch'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    exitedNonZero = true;
    assert(e.status === 1, 'should exit 1');
    const stderr = e.stderr || '';
    assert(stderr.includes('Role mismatch'), `stderr should mention mismatch: ${stderr}`);
  }
  assert(exitedNonZero, 'should have failed');
});

test('orchestrate_one skips enforcement for non-role stages (intake)', () => {
  createWorkspaceAgent('_test_cli_dev_orch', 'Dev');
  const runFolder = createWorkspaceRun('intake');

  const out = execFileSync('node', [DP_SCRIPT, 'orchestrate_one', runFolder,
    '--agent_id', '_test_cli_dev_orch'], { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  assert(parsed.ok === true, 'should be ok (no enforcement on intake)');
  assert(parsed.action === 'needs_task_pack', 'should report needs_task_pack');
});

// ---------------------------------------------------------------------------
console.log('\n--- autonomous runner ---');
// ---------------------------------------------------------------------------

test('autonomous runner passes --agent_id to record_artifact', () => {
  createWorkspaceAgent('_test_auto_pm', 'PM');
  const runFolder = createWorkspaceRun('pm-ready');
  fs.writeFileSync(path.join(runFolder, '31-pm-claude-task.txt'), 'test task', 'utf8');

  const result = runAutonomous(runFolder, {
    maxSteps: 5,
    maxAgentCalls: 1,
    agentAdapter: scaffoldAdapter,
    agentId: '_test_auto_pm',
    progress: false,
  });

  assert(result.action === 'autonomous_complete', 'should complete');
  assert(result.artifacts_written.length > 0, 'should have written artifacts');
  assert(result.trace.some(t => t.includes('recorded artifact')), 'should have recorded via record_artifact');
});

test('autonomous runner rejects wrong role when recording', () => {
  createWorkspaceAgent('_test_auto_dev_wrong', 'Dev');
  const runFolder = createWorkspaceRun('pm-ready');
  fs.writeFileSync(path.join(runFolder, '31-pm-claude-task.txt'), 'test task', 'utf8');

  const result = runAutonomous(runFolder, {
    maxSteps: 5,
    maxAgentCalls: 1,
    agentAdapter: scaffoldAdapter,
    agentId: '_test_auto_dev_wrong',
    progress: false,
  });

  assert(result.action === 'autonomous_complete', 'should complete');
  // Artifact write (file copy) succeeds, but record_artifact should fail with role mismatch
  assert(result.trace.some(t => t.includes('record_artifact validation failed')),
    `trace should show record_artifact failure: ${JSON.stringify(result.trace)}`);
});

test('autonomous runner works without agentId (backward compat)', () => {
  const runFolder = createWorkspaceRun('pm-ready');
  fs.writeFileSync(path.join(runFolder, '31-pm-claude-task.txt'), 'test task', 'utf8');

  const result = runAutonomous(runFolder, {
    maxSteps: 5,
    maxAgentCalls: 1,
    agentAdapter: scaffoldAdapter,
    progress: false,
  });

  assert(result.action === 'autonomous_complete', 'should complete');
  assert(result.artifacts_written.length > 0, 'should have written artifacts');
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
cleanup();

console.log(`\n========================================`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`========================================`);

process.exit(failed > 0 ? 1 : 0);
