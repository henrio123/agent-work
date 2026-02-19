#!/usr/bin/env node
'use strict';

/**
 * Tests for responsible_agent field in run status.json.
 * Run: node skills/dev-pipeline/tests/test-responsible-agent.js
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = path.resolve(os.homedir(), 'dev', 'agent-work');
const DP_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'dev-pipeline.js');
const AGENT_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'agent-state.js');

const { normalizeStatus, generateMinimalValue, readStatus } = require(DP_SCRIPT);
const { initAgent } = require(AGENT_SCRIPT);

let passed = 0;
let failed = 0;
const wsTestDirs = [];
const wsTestAgents = [];

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

function createWorkspaceRun(stage, ticketId) {
  const suffix = `_test_resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const runsDir = path.join(WORKSPACE_ROOT, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const runFolder = path.join(runsDir, suffix);
  fs.mkdirSync(runFolder, { recursive: true });
  wsTestDirs.push(runFolder);

  const statusData = {
    ticket_id: ticketId || 'TEST-RESP',
    title: 'Responsible agent test',
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
    ticket_id: ticketId || 'TEST-RESP', title: 'Responsible agent test', project: 'test',
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
  minimal.ticket_id = 'TEST-RESP';
  fs.writeFileSync(path.join(runFolder, '10-pm-brief.json'), JSON.stringify(minimal, null, 2), 'utf8');
}

function cleanup() {
  for (const dir of wsTestDirs) {
    try { fs.rmSync(dir, { recursive: true }); } catch (_) {}
  }
  const agentsDir = path.join(WORKSPACE_ROOT, 'agents');
  for (const id of wsTestAgents) {
    try { fs.rmSync(path.join(agentsDir, id), { recursive: true }); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
console.log('\n--- create_run ---');
// ---------------------------------------------------------------------------

test('create_run without --agent_id sets responsible_agent to null', () => {
  const out = execFileSync('node', [DP_SCRIPT, 'create_run', 'TEST-RA-1', 'Test RA', 'test'], {
    encoding: 'utf8',
  });
  const parsed = JSON.parse(out);
  assert(parsed.ok === true, 'should be ok');
  wsTestDirs.push(parsed.run_folder);

  const status = JSON.parse(fs.readFileSync(path.join(parsed.run_folder, 'status.json'), 'utf8'));
  assert(status.responsible_agent === null, `responsible_agent should be null, got: ${status.responsible_agent}`);
  assert(status.stage_history[0].agent_id === null, `stage_history[0].agent_id should be null, got: ${status.stage_history[0].agent_id}`);
});

test('create_run with --agent_id sets responsible_agent', () => {
  createWorkspaceAgent('_test_ra_pm_cr', 'PM');
  const out = execFileSync('node', [DP_SCRIPT, 'create_run', 'TEST-RA-2', 'Test RA', 'test', '--agent_id', '_test_ra_pm_cr'], {
    encoding: 'utf8',
  });
  const parsed = JSON.parse(out);
  assert(parsed.ok === true, 'should be ok');
  wsTestDirs.push(parsed.run_folder);

  const status = JSON.parse(fs.readFileSync(path.join(parsed.run_folder, 'status.json'), 'utf8'));
  assert(status.responsible_agent === '_test_ra_pm_cr', `responsible_agent should be _test_ra_pm_cr, got: ${status.responsible_agent}`);
});

test('create_run with --agent_id sets agent_id in stage_history', () => {
  createWorkspaceAgent('_test_ra_dev_cr', 'Dev');
  const out = execFileSync('node', [DP_SCRIPT, 'create_run', 'TEST-RA-3', 'Test RA', 'test', '--agent_id', '_test_ra_dev_cr'], {
    encoding: 'utf8',
  });
  const parsed = JSON.parse(out);
  wsTestDirs.push(parsed.run_folder);

  const status = JSON.parse(fs.readFileSync(path.join(parsed.run_folder, 'status.json'), 'utf8'));
  assert(status.stage_history[0].agent_id === '_test_ra_dev_cr',
    `stage_history[0].agent_id should be _test_ra_dev_cr, got: ${status.stage_history[0].agent_id}`);
});

// ---------------------------------------------------------------------------
console.log('\n--- create_run_from_ticket ---');
// ---------------------------------------------------------------------------

test('create_run_from_ticket with --agent_id sets responsible_agent', () => {
  // Create a temporary ticket file
  const ticketsDir = path.join(WORKSPACE_ROOT, 'tickets');
  fs.mkdirSync(ticketsDir, { recursive: true });
  const ticketPath = path.join(ticketsDir, 'TEST-RA-TICKET.md');
  fs.writeFileSync(ticketPath, `---
ticket_id: TEST-RA-TICKET
title: Test Responsible Agent
project: test
---
Body text
`, 'utf8');

  createWorkspaceAgent('_test_ra_pm_crt', 'PM');
  try {
    const out = execFileSync('node', [DP_SCRIPT, 'create_run_from_ticket', 'TEST-RA-TICKET', '--agent_id', '_test_ra_pm_crt'], {
      encoding: 'utf8',
    });
    const parsed = JSON.parse(out);
    assert(parsed.ok === true, 'should be ok');
    wsTestDirs.push(parsed.run_folder);

    const status = JSON.parse(fs.readFileSync(path.join(parsed.run_folder, 'status.json'), 'utf8'));
    assert(status.responsible_agent === '_test_ra_pm_crt',
      `responsible_agent should be _test_ra_pm_crt, got: ${status.responsible_agent}`);
    assert(status.stage_history[0].agent_id === '_test_ra_pm_crt',
      `stage_history[0].agent_id should be _test_ra_pm_crt, got: ${status.stage_history[0].agent_id}`);
  } finally {
    try { fs.unlinkSync(ticketPath); } catch (_) {}
  }
});

// ---------------------------------------------------------------------------
console.log('\n--- advance ---');
// ---------------------------------------------------------------------------

test('advance with --agent_id updates responsible_agent and stage_history', () => {
  createWorkspaceAgent('_test_ra_pm_adv', 'PM');
  const runFolder = createWorkspaceRun('pm-ready');
  createMinimalPMBrief(runFolder);

  const out = execFileSync('node', [DP_SCRIPT, 'advance', runFolder, '--confirm',
    '--agent_id', '_test_ra_pm_adv'], { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  assert(parsed.ok === true, 'should be ok');
  assert(parsed.advanced_to === 'arch-ready', 'should advance to arch-ready');

  const status = JSON.parse(fs.readFileSync(path.join(runFolder, 'status.json'), 'utf8'));
  assert(status.responsible_agent === '_test_ra_pm_adv',
    `responsible_agent should be _test_ra_pm_adv, got: ${status.responsible_agent}`);

  // Find the arch-ready stage_history entry
  const archEntry = status.stage_history.find(e => e.stage === 'arch-ready');
  assert(archEntry, 'should have arch-ready stage_history entry');
  assert(archEntry.agent_id === '_test_ra_pm_adv',
    `arch-ready agent_id should be _test_ra_pm_adv, got: ${archEntry.agent_id}`);
});

test('advance without --agent_id preserves existing responsible_agent', () => {
  createWorkspaceAgent('_test_ra_pm_adv2', 'PM');
  const runFolder = createWorkspaceRun('pm-ready');
  createMinimalPMBrief(runFolder);

  // Set responsible_agent manually
  const statusPath = path.join(runFolder, 'status.json');
  const s = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  s.responsible_agent = 'original-agent';
  fs.writeFileSync(statusPath, JSON.stringify(s, null, 2), 'utf8');

  // Advance without --agent_id
  const out = execFileSync('node', [DP_SCRIPT, 'advance', runFolder, '--confirm'], { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  assert(parsed.ok === true, 'should be ok');

  const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  assert(status.responsible_agent === 'original-agent',
    `responsible_agent should be preserved as original-agent, got: ${status.responsible_agent}`);

  // stage_history entry should have agent_id: null
  const archEntry = status.stage_history.find(e => e.stage === 'arch-ready');
  assert(archEntry, 'should have arch-ready entry');
  assert(archEntry.agent_id === null, `agent_id should be null, got: ${archEntry.agent_id}`);
});

// ---------------------------------------------------------------------------
console.log('\n--- orchestrate_one ---');
// ---------------------------------------------------------------------------

test('orchestrate_one with --agent_id records agent_id in stage_history', () => {
  createWorkspaceAgent('_test_ra_pm_orch', 'PM');
  const runFolder = createWorkspaceRun('pm-ready');
  createMinimalPMBrief(runFolder);

  const out = execFileSync('node', [DP_SCRIPT, 'orchestrate_one', runFolder,
    '--agent_id', '_test_ra_pm_orch'], { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  assert(parsed.ok === true, 'should be ok');

  const status = JSON.parse(fs.readFileSync(path.join(runFolder, 'status.json'), 'utf8'));
  assert(status.responsible_agent === '_test_ra_pm_orch',
    `responsible_agent should be _test_ra_pm_orch, got: ${status.responsible_agent}`);
});

test('orchestrate_one without --agent_id preserves responsible_agent', () => {
  const runFolder = createWorkspaceRun('intake');

  // Set responsible_agent manually
  const statusPath = path.join(runFolder, 'status.json');
  const s = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  s.responsible_agent = 'keep-me';
  fs.writeFileSync(statusPath, JSON.stringify(s, null, 2), 'utf8');

  const out = execFileSync('node', [DP_SCRIPT, 'orchestrate_one', runFolder], { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  assert(parsed.ok === true, 'should be ok');

  // responsible_agent stays unchanged (orchestrate_one on intake doesn't write status)
  const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  assert(status.responsible_agent === 'keep-me',
    `responsible_agent should be keep-me, got: ${status.responsible_agent}`);
});

// ---------------------------------------------------------------------------
console.log('\n--- normalizeStatus backward compat ---');
// ---------------------------------------------------------------------------

test('normalizeStatus adds responsible_agent null to old status', () => {
  const old = {
    ticket_id: 'OLD-1',
    title: 'Old run',
    project: 'test',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    current_stage: 'intake',
    blocked: false,
    blocked_reason: null,
    required_user_input: [],
    stage_history: [{ stage: 'intake', started_at: '2025-01-01T00:00:00Z', finished_at: null, artifact_paths: [] }],
    next_actions: [],
    // No responsible_agent field
  };
  const normalized = normalizeStatus(old);
  assert(normalized.responsible_agent === null,
    `responsible_agent should be null after normalize, got: ${normalized.responsible_agent}`);
});

test('normalizeStatus preserves existing responsible_agent', () => {
  const existing = {
    ticket_id: 'EXIST-1',
    title: 'Existing',
    project: 'test',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    current_stage: 'pm-ready',
    blocked: false,
    blocked_reason: null,
    responsible_agent: 'my-agent',
    required_user_input: [],
    stage_history: [],
    next_actions: [],
  };
  const normalized = normalizeStatus(existing);
  assert(normalized.responsible_agent === 'my-agent',
    `responsible_agent should be my-agent, got: ${normalized.responsible_agent}`);
});

// ---------------------------------------------------------------------------
console.log('\n--- generate_task_pack ---');
// ---------------------------------------------------------------------------

test('generate_task_pack adds agent_id null to stage_history', () => {
  const runFolder = createWorkspaceRun('intake');

  execFileSync('node', [DP_SCRIPT, 'generate_task_pack', runFolder], { encoding: 'utf8' });

  const status = JSON.parse(fs.readFileSync(path.join(runFolder, 'status.json'), 'utf8'));
  const tpgEntry = status.stage_history.find(e => e.stage === 'task-pack-generated');
  assert(tpgEntry, 'should have task-pack-generated entry');
  assert(tpgEntry.agent_id === null, `agent_id should be null, got: ${tpgEntry.agent_id}`);
});

// ---------------------------------------------------------------------------
console.log('\n--- schema validation ---');
// ---------------------------------------------------------------------------

test('status.schema.json requires responsible_agent', () => {
  const schema = JSON.parse(fs.readFileSync(
    path.join(WORKSPACE_ROOT, 'skills/dev-pipeline/references/status.schema.json'), 'utf8'));
  assert(schema.required.includes('responsible_agent'),
    'responsible_agent should be in required array');
  assert(schema.properties.responsible_agent, 'responsible_agent should be in properties');
  assert(JSON.stringify(schema.properties.responsible_agent.type) === JSON.stringify(['string', 'null']),
    'responsible_agent type should be ["string", "null"]');
});

test('status.schema.json stage_history items have agent_id', () => {
  const schema = JSON.parse(fs.readFileSync(
    path.join(WORKSPACE_ROOT, 'skills/dev-pipeline/references/status.schema.json'), 'utf8'));
  const itemProps = schema.properties.stage_history.items.properties;
  assert(itemProps.agent_id, 'stage_history items should have agent_id property');
  assert(JSON.stringify(itemProps.agent_id.type) === JSON.stringify(['string', 'null']),
    'agent_id type should be ["string", "null"]');
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
cleanup();

console.log(`\n========================================`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`========================================`);

process.exit(failed > 0 ? 1 : 0);
