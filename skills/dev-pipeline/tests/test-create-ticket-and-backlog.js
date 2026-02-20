#!/usr/bin/env node
'use strict';

/**
 * Tests for create-ticket-and-backlog.js — atomic ticket + backlog creation.
 * Run: node skills/dev-pipeline/tests/test-create-ticket-and-backlog.js
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createTicketAndBacklog } = require(path.resolve(__dirname, '..', 'scripts', 'create-ticket-and-backlog.js'));
const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));

const backlogSchema = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'backlog-item.schema.json'), 'utf8')
);

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

function makeTempWorkspace() {
  const wsRoot = path.join(os.tmpdir(), `_test_ctab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const ticketsDir = path.join(wsRoot, '.claw', 'tickets');
  const backlogDir = path.join(wsRoot, '.claw', 'backlog');
  fs.mkdirSync(ticketsDir, { recursive: true });
  fs.mkdirSync(backlogDir, { recursive: true });
  tmpDirs.push(wsRoot);

  // Write project.json at .claw/project.json
  fs.writeFileSync(path.join(wsRoot, '.claw', 'project.json'), JSON.stringify({
    project_id: 'test-proj',
    title: 'Test project test-proj',
    description: 'Description for test-proj',
    repo_path: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }, null, 2), 'utf8');

  return { wsRoot, ticketsDir, backlogDir };
}

function baseParams(overrides = {}) {
  return {
    ticket_id: 'T-TEST-01',
    title: 'Test ticket for unit testing',
    project_id: 'test-proj',
    description: 'A test description that is long enough to pass validation checks in the system',
    type: 'dev',
    priority: 'P1',
    owner_role: 'DEV',
    goal: 'Verify that create-ticket-and-backlog works correctly end to end',
    steps: ['Write the test', 'Run the test', 'Verify output'],
    ...overrides,
  };
}

function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
process.on('exit', cleanup);

// ---------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------
console.log('\n--- happy path ---');

test('creates both ticket and backlog files', () => {
  const { ticketsDir, backlogDir } = makeTempWorkspace();

  const result = createTicketAndBacklog(baseParams(), { ticketsDir, backlogDir });
  assert(result.ok === true, `expected ok: true, got error: ${result.error}`);
  assert(result.action === 'created', 'expected action: created');
  assert(result.ticket_id === 'T-TEST-01', 'expected ticket_id');
  assert(fs.existsSync(result.ticket_path), 'ticket file should exist');
  assert(fs.existsSync(result.backlog_path), 'backlog file should exist');
});

test('ticket has correct frontmatter', () => {
  const { ticketsDir, backlogDir } = makeTempWorkspace();

  createTicketAndBacklog(baseParams(), { ticketsDir, backlogDir });
  const content = fs.readFileSync(path.join(ticketsDir, 'T-TEST-01.md'), 'utf8');
  assert(content.includes('ticket_id: T-TEST-01'), 'missing ticket_id in frontmatter');
  assert(content.includes('title: Test ticket'), 'missing title in frontmatter');
  assert(content.includes('project: test-proj'), 'missing project in frontmatter');
  assert(content.includes('## Goal'), 'missing Goal heading');
  assert(content.includes('## Steps'), 'missing Steps heading');
});

test('backlog item validates against schema', () => {
  const { ticketsDir, backlogDir } = makeTempWorkspace();

  createTicketAndBacklog(baseParams(), { ticketsDir, backlogDir });
  const data = JSON.parse(fs.readFileSync(path.join(backlogDir, 'T-TEST-01.json'), 'utf8'));
  const schemaResult = validateAgainstSchema(data, backlogSchema);
  assert(schemaResult.ok, `schema validation failed: ${JSON.stringify(schemaResult.details)}`);
});

test('respects optional fields (tags, depends_on, parent_id, phase, stop_condition)', () => {
  const { ticketsDir, backlogDir } = makeTempWorkspace();

  const result = createTicketAndBacklog(baseParams({
    ticket_id: 'T-OPT-01',
    tags: ['feature', 'urgent'],
    depends_on: ['T-OTHER'],
    parent_id: 'EPIC-1',
    phase: 'Phase 1',
    stop_condition: 'All tests pass',
  }), { ticketsDir, backlogDir });
  assert(result.ok === true, `expected ok: true, got: ${result.error}`);

  const data = JSON.parse(fs.readFileSync(result.backlog_path, 'utf8'));
  assert(JSON.stringify(data.tags) === '["feature","urgent"]', 'tags mismatch');
  assert(JSON.stringify(data.depends_on) === '["T-OTHER"]', 'depends_on mismatch');
  assert(data.parent_id === 'EPIC-1', 'parent_id mismatch');
  assert(data.phase === 'Phase 1', 'phase mismatch');
  assert(data.stop_condition === 'All tests pass', 'stop_condition mismatch');
});

test('creates backlog dir when it does not exist', () => {
  const wsRoot = path.join(os.tmpdir(), `_test_ctab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const ticketsDir = path.join(wsRoot, '.claw', 'tickets');
  const backlogDir = path.join(wsRoot, '.claw', 'backlog');
  // Only create tickets dir, NOT backlog dir
  fs.mkdirSync(ticketsDir, { recursive: true });
  tmpDirs.push(wsRoot);

  const result = createTicketAndBacklog(baseParams({ project_id: 'new-proj' }), { ticketsDir, backlogDir });
  assert(result.ok === true, `expected ok: true, got: ${result.error}`);
  assert(fs.existsSync(path.join(backlogDir, 'T-TEST-01.json')), 'backlog dir should be created');
});

test('backlog item defaults: status=todo, run_folder=null', () => {
  const { ticketsDir, backlogDir } = makeTempWorkspace();

  createTicketAndBacklog(baseParams(), { ticketsDir, backlogDir });
  const data = JSON.parse(fs.readFileSync(path.join(backlogDir, 'T-TEST-01.json'), 'utf8'));
  assert(data.status === 'todo', 'status should default to todo');
  assert(data.run_folder === null, 'run_folder should default to null');
});

test('steps as comma-separated string', () => {
  const { ticketsDir, backlogDir } = makeTempWorkspace();

  const result = createTicketAndBacklog(baseParams({
    ticket_id: 'T-CSV-01',
    steps: 'Step one, Step two, Step three',
  }), { ticketsDir, backlogDir });
  assert(result.ok === true, `expected ok: true, got: ${result.error}`);

  const content = fs.readFileSync(result.ticket_path, 'utf8');
  assert(content.includes('1. Step one'), 'missing step 1');
  assert(content.includes('2. Step two'), 'missing step 2');
  assert(content.includes('3. Step three'), 'missing step 3');
});

// ---------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------
console.log('\n--- conflict detection ---');

test('rejects duplicate ticket_id', () => {
  const { ticketsDir, backlogDir } = makeTempWorkspace();

  // Create first
  createTicketAndBacklog(baseParams(), { ticketsDir, backlogDir });

  // Try duplicate
  const result = createTicketAndBacklog(baseParams(), { ticketsDir, backlogDir });
  assert(result.ok === false, 'expected ok: false');
  assert(result.error.includes('already exists'), `unexpected error: ${result.error}`);
});

test('rejects duplicate backlog item', () => {
  const { ticketsDir, backlogDir } = makeTempWorkspace();

  // Pre-create backlog item but not ticket
  fs.writeFileSync(path.join(backlogDir, 'T-TEST-01.json'), '{}', 'utf8');

  const result = createTicketAndBacklog(baseParams(), { ticketsDir, backlogDir });
  assert(result.ok === false, 'expected ok: false');
  assert(result.error.includes('Backlog item already exists'), `unexpected error: ${result.error}`);
});

// ---------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------
console.log('\n--- validation errors ---');

test('rejects missing required field (ticket_id)', () => {
  const { ticketsDir, backlogDir } = makeTempWorkspace();
  const params = baseParams();
  delete params.ticket_id;

  const result = createTicketAndBacklog(params, { ticketsDir, backlogDir });
  assert(result.ok === false, 'expected ok: false');
  assert(result.error.includes('ticket_id'), `unexpected error: ${result.error}`);
});

test('rejects missing required field (goal)', () => {
  const { ticketsDir, backlogDir } = makeTempWorkspace();
  const params = baseParams();
  delete params.goal;

  const result = createTicketAndBacklog(params, { ticketsDir, backlogDir });
  assert(result.ok === false, 'expected ok: false');
  assert(result.error.includes('goal'), `unexpected error: ${result.error}`);
});

test('rejects invalid type', () => {
  const { ticketsDir, backlogDir } = makeTempWorkspace();

  const result = createTicketAndBacklog(baseParams({ type: 'invalid' }), { ticketsDir, backlogDir });
  assert(result.ok === false, 'expected ok: false');
  assert(result.error.includes('Invalid type'), `unexpected error: ${result.error}`);
});

test('rejects invalid priority', () => {
  const { ticketsDir, backlogDir } = makeTempWorkspace();

  const result = createTicketAndBacklog(baseParams({ priority: 'P9' }), { ticketsDir, backlogDir });
  assert(result.ok === false, 'expected ok: false');
  assert(result.error.includes('Invalid priority'), `unexpected error: ${result.error}`);
});

test('rejects invalid owner_role', () => {
  const { ticketsDir, backlogDir } = makeTempWorkspace();

  const result = createTicketAndBacklog(baseParams({ owner_role: 'CEO' }), { ticketsDir, backlogDir });
  assert(result.ok === false, 'expected ok: false');
  assert(result.error.includes('Invalid owner_role'), `unexpected error: ${result.error}`);
});

// ---------------------------------------------------------------
// Summary
// ---------------------------------------------------------------
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
