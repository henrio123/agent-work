#!/usr/bin/env node
'use strict';

/**
 * Tests for agent-state.js — persistent agent state contract.
 * Run: node skills/dev-pipeline/tests/test-agent-state.js
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = path.resolve(os.homedir(), 'dev', 'agent-work');
const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'agent-state.js');
const SHELL = path.join(WORKSPACE_ROOT, 'tools', 'agent-state.sh');
const SCHEMA_PATH = path.resolve(__dirname, '..', 'schemas', 'agent-state.schema.json');

const {
  readAgentState,
  writeAgentState,
  initAgent,
  updateWorkload,
  assignTask,
  clearTask,
  listAgents,
  safePath,
} = require(SCRIPT);

const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));

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

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertThrows(fn, pattern) {
  let threw = false;
  try { fn(); } catch (e) { threw = true; if (pattern && !e.message.includes(pattern)) throw new Error(`Expected error containing "${pattern}", got: ${e.message}`); }
  if (!threw) throw new Error('Expected function to throw');
}

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `_test_agent_state_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
console.log('\n--- initAgent ---');
// ---------------------------------------------------------------------------

test('initAgent creates directory and valid state.json', () => {
  const dir = makeTempDir();
  const state = initAgent('agent-pm', 'PM', { agentsDir: dir });
  assert(state.agent_id === 'agent-pm', 'agent_id mismatch');
  assert(state.role === 'PM', 'role mismatch');
  assert(state.current_task === null, 'current_task should be null');
  assert(state.workload.runs_started === 0, 'runs_started should be 0');
  assert(state.workload.stages_completed === 0, 'stages_completed should be 0');
  assert(typeof state.created_at === 'string', 'created_at should be string');
  assert(typeof state.last_active_at === 'string', 'last_active_at should be string');

  const fp = path.join(dir, 'agent-pm', 'state.json');
  assert(fs.existsSync(fp), 'state.json should exist on disk');
});

test('initAgent errors on duplicate', () => {
  const dir = makeTempDir();
  initAgent('agent-dup', 'Dev', { agentsDir: dir });
  assertThrows(() => initAgent('agent-dup', 'Dev', { agentsDir: dir }), 'already exists');
});

// ---------------------------------------------------------------------------
console.log('\n--- readAgentState ---');
// ---------------------------------------------------------------------------

test('readAgentState returns null for missing agent', () => {
  const dir = makeTempDir();
  const state = readAgentState('nonexistent', { agentsDir: dir });
  assert(state === null, 'should return null');
});

test('readAgentState returns parsed state for existing agent', () => {
  const dir = makeTempDir();
  initAgent('agent-read', 'QA', { agentsDir: dir });
  const state = readAgentState('agent-read', { agentsDir: dir });
  assert(state !== null, 'should not be null');
  assert(state.agent_id === 'agent-read', 'agent_id mismatch');
  assert(state.role === 'QA', 'role mismatch');
});

// ---------------------------------------------------------------------------
console.log('\n--- writeAgentState ---');
// ---------------------------------------------------------------------------

test('writeAgentState validates against schema (rejects invalid)', () => {
  const dir = makeTempDir();
  assertThrows(() => writeAgentState('bad', { agent_id: 'bad' }, { agentsDir: dir }), 'Validation failed');
});

test('writeAgentState writes valid state', () => {
  const dir = makeTempDir();
  const ts = new Date().toISOString();
  const state = {
    agent_id: 'agent-write',
    role: 'Architect',
    current_task: null,
    workload: { runs_started: 0, stages_completed: 0 },
    created_at: ts,
    updated_at: ts,
    last_active_at: ts,
  };
  writeAgentState('agent-write', state, { agentsDir: dir });
  const fp = path.join(dir, 'agent-write', 'state.json');
  assert(fs.existsSync(fp), 'state.json should exist');
  const read = JSON.parse(fs.readFileSync(fp, 'utf8'));
  assert(read.agent_id === 'agent-write', 'should match written state');
});

// ---------------------------------------------------------------------------
console.log('\n--- updateWorkload ---');
// ---------------------------------------------------------------------------

test('updateWorkload increments runs_started', () => {
  const dir = makeTempDir();
  initAgent('agent-wl1', 'PM', { agentsDir: dir });
  const state = updateWorkload('agent-wl1', 'runs_started', 1, { agentsDir: dir });
  assert(state.workload.runs_started === 1, 'runs_started should be 1');
});

test('updateWorkload increments stages_completed', () => {
  const dir = makeTempDir();
  initAgent('agent-wl2', 'Dev', { agentsDir: dir });
  updateWorkload('agent-wl2', 'stages_completed', 1, { agentsDir: dir });
  const state = updateWorkload('agent-wl2', 'stages_completed', 2, { agentsDir: dir });
  assert(state.workload.stages_completed === 3, 'stages_completed should be 3');
});

test('updateWorkload rejects invalid field name', () => {
  const dir = makeTempDir();
  initAgent('agent-wl3', 'QA', { agentsDir: dir });
  assertThrows(() => updateWorkload('agent-wl3', 'bad_field', 1, { agentsDir: dir }), 'Invalid workload field');
});

test('updateWorkload errors for missing agent', () => {
  const dir = makeTempDir();
  assertThrows(() => updateWorkload('ghost', 'runs_started', 1, { agentsDir: dir }), 'not found');
});

// ---------------------------------------------------------------------------
console.log('\n--- assignTask / clearTask ---');
// ---------------------------------------------------------------------------

test('assignTask sets current_task', () => {
  const dir = makeTempDir();
  initAgent('agent-assign', 'PM', { agentsDir: dir });
  const state = assignTask('agent-assign', 'TASK-001', { agentsDir: dir });
  assert(state.current_task === 'TASK-001', 'current_task mismatch');
});

test('clearTask nulls current_task', () => {
  const dir = makeTempDir();
  initAgent('agent-clear', 'Dev', { agentsDir: dir });
  assignTask('agent-clear', 'TASK-002', { agentsDir: dir });
  const state = clearTask('agent-clear', { agentsDir: dir });
  assert(state.current_task === null, 'current_task should be null');
});

test('assignTask errors for missing agent', () => {
  const dir = makeTempDir();
  assertThrows(() => assignTask('ghost', 'TASK-X', { agentsDir: dir }), 'not found');
});

test('clearTask errors for missing agent', () => {
  const dir = makeTempDir();
  assertThrows(() => clearTask('ghost', { agentsDir: dir }), 'not found');
});

// ---------------------------------------------------------------------------
console.log('\n--- listAgents ---');
// ---------------------------------------------------------------------------

test('listAgents returns all agents sorted by agent_id', () => {
  const dir = makeTempDir();
  initAgent('beta', 'Dev', { agentsDir: dir });
  initAgent('alpha', 'PM', { agentsDir: dir });
  initAgent('gamma', 'QA', { agentsDir: dir });
  const list = listAgents({ agentsDir: dir });
  assert(list.length === 3, 'should have 3 agents');
  assert(list[0].agent_id === 'alpha', 'first should be alpha');
  assert(list[1].agent_id === 'beta', 'second should be beta');
  assert(list[2].agent_id === 'gamma', 'third should be gamma');
});

test('listAgents returns empty array when no agents', () => {
  const dir = makeTempDir();
  const list = listAgents({ agentsDir: dir });
  assert(Array.isArray(list) && list.length === 0, 'should be empty array');
});

test('listAgents returns empty array when directory does not exist', () => {
  const dir = path.join(os.tmpdir(), '_nonexistent_agents_' + Date.now());
  const list = listAgents({ agentsDir: dir });
  assert(Array.isArray(list) && list.length === 0, 'should be empty array');
});

test('listAgents includes correct summary fields', () => {
  const dir = makeTempDir();
  initAgent('agent-ls', 'Review', { agentsDir: dir });
  assignTask('agent-ls', 'T-100', { agentsDir: dir });
  updateWorkload('agent-ls', 'runs_started', 3, { agentsDir: dir });
  const list = listAgents({ agentsDir: dir });
  const a = list[0];
  assert(a.agent_id === 'agent-ls', 'agent_id');
  assert(a.role === 'Review', 'role');
  assert(a.current_task === 'T-100', 'current_task');
  assert(a.workload.runs_started === 3, 'runs_started');
  assert(typeof a.last_active_at === 'string', 'last_active_at');
});

// ---------------------------------------------------------------------------
console.log('\n--- schema validation ---');
// ---------------------------------------------------------------------------

test('output validates against agent-state.schema.json', () => {
  const dir = makeTempDir();
  const state = initAgent('agent-schema', 'Architect', { agentsDir: dir });
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const result = validateAgainstSchema(state, schema);
  assert(result.ok, `schema validation failed: ${JSON.stringify(result.details)}`);
});

test('schema rejects extra properties', () => {
  const dir = makeTempDir();
  const state = initAgent('agent-extra', 'PM', { agentsDir: dir });
  state.extra_field = 'bad';
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const result = validateAgainstSchema(state, schema);
  assert(!result.ok, 'should reject extra properties');
});

// ---------------------------------------------------------------------------
console.log('\n--- CLI ---');
// ---------------------------------------------------------------------------

test('CLI init creates agent', () => {
  const dir = makeTempDir();
  // CLI uses real WORKSPACE_ROOT, so we test via programmatic init + CLI read pattern
  // Instead, test the real CLI with a unique agent name and clean up after
  const agentId = `_test_cli_${Date.now()}`;
  const agentsRealDir = path.join(WORKSPACE_ROOT, 'agents');
  try {
    const out = execFileSync('node', [SCRIPT, 'init', agentId, 'Dev'], { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    assert(parsed.ok === true, 'ok should be true');
    assert(parsed.agent_id === agentId, 'agent_id mismatch');
    assert(parsed.state.role === 'Dev', 'role mismatch');
  } finally {
    // cleanup
    const agDir = path.join(agentsRealDir, agentId);
    if (fs.existsSync(agDir)) fs.rmSync(agDir, { recursive: true });
  }
});

test('CLI read outputs valid JSON', () => {
  const agentId = `_test_cli_read_${Date.now()}`;
  const agentsRealDir = path.join(WORKSPACE_ROOT, 'agents');
  try {
    execFileSync('node', [SCRIPT, 'init', agentId, 'QA'], { encoding: 'utf8' });
    const out = execFileSync('node', [SCRIPT, 'read', agentId], { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    assert(parsed.ok === true, 'ok should be true');
    assert(parsed.state.agent_id === agentId, 'agent_id');
  } finally {
    const agDir = path.join(agentsRealDir, agentId);
    if (fs.existsSync(agDir)) fs.rmSync(agDir, { recursive: true });
  }
});

test('CLI list outputs valid JSON', () => {
  const out = execFileSync('node', [SCRIPT, 'list'], { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  assert(parsed.ok === true, 'ok should be true');
  assert(Array.isArray(parsed.agents), 'agents should be array');
});

test('CLI init duplicate exits 1', () => {
  const agentId = `_test_cli_dup_${Date.now()}`;
  const agentsRealDir = path.join(WORKSPACE_ROOT, 'agents');
  try {
    execFileSync('node', [SCRIPT, 'init', agentId, 'PM'], { encoding: 'utf8' });
    let exitedNonZero = false;
    try {
      execFileSync('node', [SCRIPT, 'init', agentId, 'PM'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      exitedNonZero = true;
      assert(e.status === 1, 'should exit 1');
    }
    assert(exitedNonZero, 'second init should have failed');
  } finally {
    const agDir = path.join(agentsRealDir, agentId);
    if (fs.existsSync(agDir)) fs.rmSync(agDir, { recursive: true });
  }
});

test('CLI read missing agent exits 1', () => {
  let exitedNonZero = false;
  try {
    execFileSync('node', [SCRIPT, 'read', '_nonexistent_agent_xyz'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    exitedNonZero = true;
    assert(e.status === 1, 'should exit 1');
  }
  assert(exitedNonZero, 'should have failed');
});

// ---------------------------------------------------------------------------
console.log('\n--- shell wrapper ---');
// ---------------------------------------------------------------------------

test('shell wrapper is executable and outputs JSON', () => {
  const out = execFileSync('bash', [SHELL, 'list'], { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  assert(parsed.ok === true, 'ok should be true');
  assert(Array.isArray(parsed.agents), 'agents should be array');
});

// ---------------------------------------------------------------------------
console.log('\n--- safePath ---');
// ---------------------------------------------------------------------------

test('safePath rejects paths outside workspace', () => {
  assertThrows(() => safePath('/tmp/evil'), 'Path outside workspace');
});

test('safePath rejects path traversal', () => {
  assertThrows(() => safePath('../../../etc/passwd'), 'Path outside workspace');
});

test('safePath accepts valid workspace path', () => {
  const result = safePath('agents/test');
  assert(result.startsWith(WORKSPACE_ROOT), 'should be inside workspace');
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
for (const dir of tmpDirs) {
  try { fs.rmSync(dir, { recursive: true }); } catch (_) {}
}

console.log(`\n========================================`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`========================================`);

process.exit(failed > 0 ? 1 : 0);
