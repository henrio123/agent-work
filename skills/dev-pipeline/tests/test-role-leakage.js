#!/usr/bin/env node
'use strict';

/**
 * P1-06: Role leakage prevention tests.
 *
 * Proves cross-role leakage is impossible via end-to-end CLI-level scenarios.
 * Run: node skills/dev-pipeline/tests/test-role-leakage.js
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
const DP_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'dev-pipeline.js');
const AGENT_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'agent-state.js');

const { checkRoleForStage, STAGE_CONFIG, generateMinimalValue } = require(DP_SCRIPT);
const { initAgent } = require(AGENT_SCRIPT);

let passed = 0;
let failed = 0;
const tmpDirs = [];       // temp dirs outside workspace (for programmatic tests)
const wsTestDirs = [];    // dirs inside workspace (for CLI tests)
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
  const dir = path.join(os.tmpdir(), `_test_leak_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function createWorkspaceRun(stage, ticketId) {
  const suffix = `_test_leak_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const runsDir = path.join(WORKSPACE_ROOT, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const runFolder = path.join(runsDir, suffix);
  fs.mkdirSync(runFolder, { recursive: true });
  wsTestDirs.push(runFolder);

  const statusData = {
    ticket_id: ticketId || 'TEST-LEAK',
    title: 'Role leakage test',
    project: 'test',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    current_stage: stage,
    blocked: false,
    blocked_reason: null,
    responsible_agent: null,
    required_user_input: [],
    stage_history: [{ stage, started_at: new Date().toISOString(), finished_at: null, artifact_paths: [], agent_id: null }],
    next_actions: [],
  };
  fs.writeFileSync(path.join(runFolder, 'status.json'), JSON.stringify(statusData, null, 2), 'utf8');
  fs.writeFileSync(path.join(runFolder, '00-intake.json'), JSON.stringify({
    ticket_id: ticketId || 'TEST-LEAK', title: 'Role leakage test', project: 'test',
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

function createMinimalArtifact(runFolder, schemaName, artifactFilename, overrides) {
  const schema = JSON.parse(fs.readFileSync(
    path.resolve(WORKSPACE_ROOT, 'skills/dev-pipeline/references', schemaName), 'utf8'));
  const minimal = generateMinimalValue(schema);
  if (overrides) Object.assign(minimal, overrides);
  fs.writeFileSync(path.join(runFolder, artifactFilename), JSON.stringify(minimal, null, 2), 'utf8');
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
// Case 1: DEV agent cannot produce QA artifacts
// ---------------------------------------------------------------------------
console.log('\n--- Case 1: DEV agent cannot produce QA artifacts ---');

test('record_artifact rejects Dev agent at qa-ready', () => {
  createWorkspaceAgent('_leak_dev1', 'Dev');
  const runFolder = createWorkspaceRun('qa-ready');
  createMinimalArtifact(runFolder, 'qa-report.schema.json', '50-qa-report.json', { ticket_id: 'TEST-LEAK' });

  let exitedNonZero = false;
  try {
    execFileSync('node', [DP_SCRIPT, 'record_artifact', runFolder,
      path.join(runFolder, '50-qa-report.json'), '--agent_id', '_leak_dev1'], {
      encoding: 'utf8', stdio: 'pipe',
    });
  } catch (e) {
    exitedNonZero = true;
    assert(e.status === 1, 'should exit 1');
    const stderr = e.stderr || '';
    assert(stderr.includes('Role mismatch'), `stderr should mention mismatch: ${stderr}`);
    assert(stderr.includes('Dev'), 'should mention agent role Dev');
    assert(stderr.includes('QA'), 'should mention required role QA');
  }
  assert(exitedNonZero, 'should have failed');
});

test('orchestrate_one rejects Dev agent at qa-ready', () => {
  createWorkspaceAgent('_leak_dev1b', 'Dev');
  const runFolder = createWorkspaceRun('qa-ready');

  let exitedNonZero = false;
  try {
    execFileSync('node', [DP_SCRIPT, 'orchestrate_one', runFolder,
      '--agent_id', '_leak_dev1b'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    exitedNonZero = true;
    assert(e.status === 1, 'should exit 1');
    assert((e.stderr || '').includes('Role mismatch'), 'stderr should mention mismatch');
  }
  assert(exitedNonZero, 'should have failed');
});

// ---------------------------------------------------------------------------
// Case 2: QA agent cannot produce DEV artifacts
// ---------------------------------------------------------------------------
console.log('\n--- Case 2: QA agent cannot produce DEV artifacts ---');

test('record_artifact rejects QA agent at dev-ready', () => {
  createWorkspaceAgent('_leak_qa2', 'QA');
  const runFolder = createWorkspaceRun('dev-ready');
  createMinimalArtifact(runFolder, 'dev-notes.schema.json', '41-dev-notes.json', { ticket_id: 'TEST-LEAK' });

  let exitedNonZero = false;
  try {
    execFileSync('node', [DP_SCRIPT, 'record_artifact', runFolder,
      path.join(runFolder, '41-dev-notes.json'), '--agent_id', '_leak_qa2'], {
      encoding: 'utf8', stdio: 'pipe',
    });
  } catch (e) {
    exitedNonZero = true;
    assert(e.status === 1, 'should exit 1');
    const stderr = e.stderr || '';
    assert(stderr.includes('Role mismatch'), `stderr should mention mismatch: ${stderr}`);
    assert(stderr.includes('QA'), 'should mention agent role QA');
    assert(stderr.includes('Dev'), 'should mention required role Dev');
  }
  assert(exitedNonZero, 'should have failed');
});

test('advance rejects QA agent at dev-ready', () => {
  createWorkspaceAgent('_leak_qa2b', 'QA');
  const runFolder = createWorkspaceRun('dev-ready');
  // Create valid dev artifacts so gates would pass if role check didn't block
  createMinimalArtifact(runFolder, 'dev-notes.schema.json', '41-dev-notes.json', { ticket_id: 'TEST-LEAK' });
  fs.writeFileSync(path.join(runFolder, '40-dev-patch.diff'), '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n', 'utf8');

  let exitedNonZero = false;
  try {
    execFileSync('node', [DP_SCRIPT, 'advance', runFolder, '--confirm',
      '--agent_id', '_leak_qa2b'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    exitedNonZero = true;
    assert(e.status === 1, 'should exit 1');
    assert((e.stderr || '').includes('Role mismatch'), 'stderr should mention mismatch');
  }
  assert(exitedNonZero, 'should have failed');
});

// ---------------------------------------------------------------------------
// Case 3: PM agent cannot produce ARCHITECT artifacts
// ---------------------------------------------------------------------------
console.log('\n--- Case 3: PM agent cannot produce ARCHITECT artifacts ---');

test('record_artifact rejects PM agent at arch-ready', () => {
  createWorkspaceAgent('_leak_pm3', 'PM');
  const runFolder = createWorkspaceRun('arch-ready');
  createMinimalArtifact(runFolder, 'arch-design.schema.json', '20-arch-design.json', { ticket_id: 'TEST-LEAK' });

  let exitedNonZero = false;
  try {
    execFileSync('node', [DP_SCRIPT, 'record_artifact', runFolder,
      path.join(runFolder, '20-arch-design.json'), '--agent_id', '_leak_pm3'], {
      encoding: 'utf8', stdio: 'pipe',
    });
  } catch (e) {
    exitedNonZero = true;
    assert(e.status === 1, 'should exit 1');
    const stderr = e.stderr || '';
    assert(stderr.includes('Role mismatch'), `stderr should mention mismatch: ${stderr}`);
    assert(stderr.includes('PM'), 'should mention agent role PM');
    assert(stderr.includes('Architect'), 'should mention required role Architect');
  }
  assert(exitedNonZero, 'should have failed');
});

test('advance rejects PM agent at arch-ready', () => {
  createWorkspaceAgent('_leak_pm3b', 'PM');
  const runFolder = createWorkspaceRun('arch-ready');
  createMinimalArtifact(runFolder, 'arch-design.schema.json', '20-arch-design.json', { ticket_id: 'TEST-LEAK' });

  let exitedNonZero = false;
  try {
    execFileSync('node', [DP_SCRIPT, 'advance', runFolder, '--confirm',
      '--agent_id', '_leak_pm3b'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    exitedNonZero = true;
    assert(e.status === 1, 'should exit 1');
    assert((e.stderr || '').includes('Role mismatch'), 'stderr should mention mismatch');
  }
  assert(exitedNonZero, 'should have failed');
});

// ---------------------------------------------------------------------------
// Case 4: Agent with no assigned role is rejected
// ---------------------------------------------------------------------------
console.log('\n--- Case 4: Agent with no assigned role is rejected ---');

test('checkRoleForStage rejects agent with empty role at every role-gated stage', () => {
  const agentsDir = makeTempDir();
  initAgent('_leak_norole', '', { agentsDir });

  const roleStages = Object.keys(STAGE_CONFIG);
  for (const stage of roleStages) {
    const result = checkRoleForStage('_leak_norole', stage, { agentsDir });
    assert(result.ok === false, `should reject empty-role agent at ${stage}`);
    assert(result.error.includes('Role mismatch'), `should mention mismatch at ${stage}: ${result.error}`);
  }
});

test('checkRoleForStage rejects agent with null-like role at every role-gated stage', () => {
  const agentsDir = makeTempDir();
  // Manually create agent with null role (bypass initAgent validation).
  // readAgentState validates the state and throws for null role, so
  // checkRoleForStage should propagate this as ok:false or throw.
  const agentDir = path.join(agentsDir, '_leak_nullrole');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'state.json'), JSON.stringify({
    agent_id: '_leak_nullrole',
    role: null,
    current_task: null,
    workload: { runs_started: 0, stages_completed: 0 },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_active_at: new Date().toISOString(),
  }, null, 2), 'utf8');

  const roleStages = Object.keys(STAGE_CONFIG);
  for (const stage of roleStages) {
    let rejected = false;
    try {
      const result = checkRoleForStage('_leak_nullrole', stage, { agentsDir });
      // If it returns without throwing, it must be ok:false
      rejected = result.ok === false;
    } catch (e) {
      // readAgentState throws on invalid state — that's also a rejection
      rejected = true;
    }
    assert(rejected, `should reject null-role agent at ${stage}`);
  }
});

// ---------------------------------------------------------------------------
// Case 5: Role enforcement across stage transitions
// ---------------------------------------------------------------------------
console.log('\n--- Case 5: Role enforcement across stage transitions ---');

test('advance rejects wrong-role agent at every role-gated stage', () => {
  // Create one agent per role that is WRONG for each stage
  createWorkspaceAgent('_leak_cross_dev', 'Dev');

  const stageTests = [
    { stage: 'pm-ready', wrongAgent: '_leak_cross_dev', wrongRole: 'Dev', rightRole: 'PM' },
    { stage: 'arch-ready', wrongAgent: '_leak_cross_dev', wrongRole: 'Dev', rightRole: 'Architect' },
    // dev-ready: Dev is correct, so use QA as wrong
    { stage: 'qa-ready', wrongAgent: '_leak_cross_dev', wrongRole: 'Dev', rightRole: 'QA' },
    { stage: 'review', wrongAgent: '_leak_cross_dev', wrongRole: 'Dev', rightRole: 'Review' },
  ];

  for (const { stage, wrongAgent, wrongRole, rightRole } of stageTests) {
    const runFolder = createWorkspaceRun(stage);

    let exitedNonZero = false;
    try {
      execFileSync('node', [DP_SCRIPT, 'advance', runFolder, '--confirm',
        '--agent_id', wrongAgent], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      exitedNonZero = true;
      assert(e.status === 1, `should exit 1 at ${stage}`);
      const stderr = e.stderr || '';
      assert(stderr.includes('Role mismatch'), `should mention mismatch at ${stage}: ${stderr}`);
      assert(stderr.includes(wrongRole), `should mention wrong role ${wrongRole} at ${stage}`);
      assert(stderr.includes(rightRole), `should mention required role ${rightRole} at ${stage}`);
    }
    assert(exitedNonZero, `should have failed at ${stage}`);
  }
});

test('orchestrate_one rejects wrong-role agent at every role-gated stage', () => {
  createWorkspaceAgent('_leak_cross_qa', 'QA');

  const stages = ['pm-ready', 'arch-ready', 'dev-ready', 'review'];
  for (const stage of stages) {
    const runFolder = createWorkspaceRun(stage);

    let exitedNonZero = false;
    try {
      execFileSync('node', [DP_SCRIPT, 'orchestrate_one', runFolder,
        '--agent_id', '_leak_cross_qa'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      exitedNonZero = true;
      assert(e.status === 1, `should exit 1 at ${stage}`);
      assert((e.stderr || '').includes('Role mismatch'), `should mention mismatch at ${stage}`);
    }
    assert(exitedNonZero, `should have failed at ${stage}`);
  }
});

test('record_artifact rejects wrong-role agent at every role-gated stage', () => {
  createWorkspaceAgent('_leak_cross_rev', 'Review');

  const stageArtifacts = [
    { stage: 'pm-ready', schema: 'pm-brief.schema.json', artifact: '10-pm-brief.json' },
    { stage: 'arch-ready', schema: 'arch-design.schema.json', artifact: '20-arch-design.json' },
    { stage: 'dev-ready', schema: 'dev-notes.schema.json', artifact: '41-dev-notes.json' },
    { stage: 'qa-ready', schema: 'qa-report.schema.json', artifact: '50-qa-report.json' },
  ];

  for (const { stage, schema, artifact } of stageArtifacts) {
    const runFolder = createWorkspaceRun(stage);
    createMinimalArtifact(runFolder, schema, artifact, { ticket_id: 'TEST-LEAK' });

    let exitedNonZero = false;
    try {
      execFileSync('node', [DP_SCRIPT, 'record_artifact', runFolder,
        path.join(runFolder, artifact), '--agent_id', '_leak_cross_rev'], {
        encoding: 'utf8', stdio: 'pipe',
      });
    } catch (e) {
      exitedNonZero = true;
      assert(e.status === 1, `should exit 1 at ${stage}`);
      assert((e.stderr || '').includes('Role mismatch'), `should mention mismatch at ${stage}`);
    }
    assert(exitedNonZero, `should have failed at ${stage}`);
  }
});

// ---------------------------------------------------------------------------
// Case 6: responsible_agent is always populated after transitions
// ---------------------------------------------------------------------------
console.log('\n--- Case 6: responsible_agent populated after transitions ---');

test('create_run --agent_id sets responsible_agent', () => {
  createWorkspaceAgent('_leak_ra_pm', 'PM');

  const out = execFileSync('node', [DP_SCRIPT, 'create_run', 'LEAK-RA', 'RA test', 'test',
    '--agent_id', '_leak_ra_pm'], { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  assert(parsed.ok === true, 'should succeed');

  const runFolder = parsed.run_folder;
  wsTestDirs.push(runFolder);
  const status = JSON.parse(fs.readFileSync(path.join(runFolder, 'status.json'), 'utf8'));
  assert(status.responsible_agent === '_leak_ra_pm', `responsible_agent should be _leak_ra_pm, got: ${status.responsible_agent}`);
  assert(status.stage_history[0].agent_id === '_leak_ra_pm', `stage_history[0].agent_id should be _leak_ra_pm`);
});

test('record_artifact --agent_id sets responsible_agent on validation failure (blocked path)', () => {
  createWorkspaceAgent('_leak_ra_pm2', 'PM');
  const runFolder = createWorkspaceRun('pm-ready');
  // Write an invalid artifact (empty object) so record_artifact blocks the run
  fs.writeFileSync(path.join(runFolder, '10-pm-brief.json'), '{}', 'utf8');

  const out = execFileSync('node', [DP_SCRIPT, 'record_artifact', runFolder,
    path.join(runFolder, '10-pm-brief.json'), '--agent_id', '_leak_ra_pm2'], { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  assert(parsed.ok === true, 'should return ok (with valid:false)');
  assert(parsed.valid === false, 'artifact should be invalid');
  assert(parsed.blocked === true, 'run should be blocked');

  const status = JSON.parse(fs.readFileSync(path.join(runFolder, 'status.json'), 'utf8'));
  assert(status.responsible_agent === '_leak_ra_pm2', `responsible_agent should be _leak_ra_pm2, got: ${status.responsible_agent}`);
  // The blocked stage_history entry should have the agent_id
  const blockedEntry = status.stage_history.find(e => e.stage === 'blocked');
  assert(blockedEntry, 'should have blocked stage_history entry');
  assert(blockedEntry.agent_id === '_leak_ra_pm2', `blocked entry agent_id should be _leak_ra_pm2, got: ${blockedEntry.agent_id}`);
});

test('advance --agent_id sets responsible_agent and stage_history agent_id', () => {
  createWorkspaceAgent('_leak_ra_pm3', 'PM');
  const runFolder = createWorkspaceRun('pm-ready');
  createMinimalArtifact(runFolder, 'pm-brief.schema.json', '10-pm-brief.json', { ticket_id: 'TEST-LEAK' });

  const out = execFileSync('node', [DP_SCRIPT, 'advance', runFolder, '--confirm',
    '--agent_id', '_leak_ra_pm3'], { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  assert(parsed.ok === true, 'should succeed');
  assert(parsed.advanced_to === 'arch-ready', `should advance to arch-ready, got ${parsed.advanced_to}`);

  const status = JSON.parse(fs.readFileSync(path.join(runFolder, 'status.json'), 'utf8'));
  assert(status.responsible_agent === '_leak_ra_pm3', `responsible_agent should be _leak_ra_pm3, got: ${status.responsible_agent}`);

  // Find the arch-ready stage_history entry
  const archEntry = status.stage_history.find(e => e.stage === 'arch-ready');
  assert(archEntry, 'should have arch-ready stage_history entry');
  assert(archEntry.agent_id === '_leak_ra_pm3', `arch-ready agent_id should be _leak_ra_pm3, got: ${archEntry.agent_id}`);
});

test('responsible_agent persists across multi-stage advance chain', () => {
  createWorkspaceAgent('_leak_ra_chain_pm', 'PM');
  createWorkspaceAgent('_leak_ra_chain_arch', 'Architect');

  // Create run at pm-ready with PM agent
  const runFolder = createWorkspaceRun('pm-ready');
  createMinimalArtifact(runFolder, 'pm-brief.schema.json', '10-pm-brief.json', { ticket_id: 'TEST-LEAK' });

  // PM advances pm-ready → arch-ready
  execFileSync('node', [DP_SCRIPT, 'advance', runFolder, '--confirm',
    '--agent_id', '_leak_ra_chain_pm'], { encoding: 'utf8' });

  let status = JSON.parse(fs.readFileSync(path.join(runFolder, 'status.json'), 'utf8'));
  assert(status.responsible_agent === '_leak_ra_chain_pm', 'responsible_agent should be PM after first advance');
  assert(status.current_stage === 'arch-ready', 'should be at arch-ready');

  // Architect records artifact and advances arch-ready → dev-ready
  createMinimalArtifact(runFolder, 'arch-design.schema.json', '20-arch-design.json', { ticket_id: 'TEST-LEAK' });
  execFileSync('node', [DP_SCRIPT, 'record_artifact', runFolder,
    path.join(runFolder, '20-arch-design.json'), '--agent_id', '_leak_ra_chain_arch'], { encoding: 'utf8' });
  execFileSync('node', [DP_SCRIPT, 'advance', runFolder, '--confirm',
    '--agent_id', '_leak_ra_chain_arch'], { encoding: 'utf8' });

  status = JSON.parse(fs.readFileSync(path.join(runFolder, 'status.json'), 'utf8'));
  assert(status.responsible_agent === '_leak_ra_chain_arch', `responsible_agent should be Architect, got: ${status.responsible_agent}`);
  assert(status.current_stage === 'dev-ready', 'should be at dev-ready');

  // Verify all stage_history entries have agent_id
  const pmEntry = status.stage_history.find(e => e.stage === 'pm-ready');
  const archEntry = status.stage_history.find(e => e.stage === 'arch-ready');
  const devEntry = status.stage_history.find(e => e.stage === 'dev-ready');
  assert(archEntry && archEntry.agent_id === '_leak_ra_chain_pm', 'arch-ready entry should have PM agent_id');
  assert(devEntry && devEntry.agent_id === '_leak_ra_chain_arch', 'dev-ready entry should have Architect agent_id');
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
cleanup();

console.log(`\n========================================`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`========================================`);

process.exit(failed > 0 ? 1 : 0);
