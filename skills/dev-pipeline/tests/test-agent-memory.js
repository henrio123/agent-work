#!/usr/bin/env node
'use strict';

/**
 * Tests for agent-memory.js — append-only agent memory persistence.
 * Run: node skills/dev-pipeline/tests/test-agent-memory.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { writeMemory, readMemory } = require('../scripts/agent-memory.js');
const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));

const ENTRY_SCHEMA = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'agent-memory.schema.json'), 'utf8')
);
const INDEX_SCHEMA = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'agent-memory-index.output.schema.json'), 'utf8')
);

let passed = 0;
let failed = 0;

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mem-'));
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

function makeWorkspace() {
  const ws = fs.mkdtempSync(path.join(TMP, 'ws-'));
  fs.mkdirSync(path.join(ws, '.claw', 'agents'), { recursive: true });
  return ws;
}

function baseOpts(ws) {
  return {
    workspaceRoot: ws,
    agentId: 'agent-1',
    runId: '20260101_000000_T1',
    projectId: 'proj-a',
    stage: 'analyze',
    type: 'observation',
    content: 'Test observation',
    tags: ['test'],
  };
}

// =========================================================================
// Write + Read round-trip
// =========================================================================
console.log('\n--- Write + Read round-trip ---');

test('write returns a valid entry with all fields', () => {
  const ws = makeWorkspace();
  const entry = writeMemory(baseOpts(ws));

  assert.ok(entry.id, 'id should be populated');
  assert.strictEqual(entry.agent_id, 'agent-1');
  assert.strictEqual(entry.run_id, '20260101_000000_T1');
  assert.strictEqual(entry.project_id, 'proj-a');
  assert.strictEqual(entry.stage, 'analyze');
  assert.strictEqual(entry.type, 'observation');
  assert.strictEqual(entry.content, 'Test observation');
  assert.deepStrictEqual(entry.tags, ['test']);
  assert.ok(entry.created_at);
});

test('written entry validates against entry schema', () => {
  const ws = makeWorkspace();
  const entry = writeMemory(baseOpts(ws));
  const v = validateAgainstSchema(entry, ENTRY_SCHEMA);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);
});

test('write creates file on disk', () => {
  const ws = makeWorkspace();
  writeMemory(baseOpts(ws));

  const memDir = path.join(ws, '.claw', 'agents', 'agent-1', 'memory');
  assert.ok(fs.existsSync(memDir), 'memory directory should exist');
  const files = fs.readdirSync(memDir);
  assert.strictEqual(files.length, 1, 'should have one memory file');
  assert.ok(files[0].endsWith('.json'));
});

test('read returns what was written', () => {
  const ws = makeWorkspace();
  const entry = writeMemory(baseOpts(ws));

  const result = readMemory({ agentId: 'agent-1', workspaceRoot: ws });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.agent_id, 'agent-1');
  assert.strictEqual(result.total_entries, 1);
  assert.strictEqual(result.entries.length, 1);
  assert.strictEqual(result.entries[0].id, entry.id);
  assert.strictEqual(result.entries[0].content, 'Test observation');
});

test('read output validates against index schema', () => {
  const ws = makeWorkspace();
  writeMemory(baseOpts(ws));

  const result = readMemory({ agentId: 'agent-1', workspaceRoot: ws });
  const v = validateAgainstSchema(result, INDEX_SCHEMA);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);
});

// =========================================================================
// Append-only guarantee
// =========================================================================
console.log('\n--- Append-only guarantee ---');

test('multiple writes accumulate (never overwrite)', () => {
  const ws = makeWorkspace();
  const opts = baseOpts(ws);

  const e1 = writeMemory({ ...opts, content: 'First observation' });
  const e2 = writeMemory({ ...opts, content: 'Second observation', stage: 'plan' });
  const e3 = writeMemory({ ...opts, content: 'Third observation', type: 'lesson' });

  const result = readMemory({ agentId: 'agent-1', workspaceRoot: ws });
  assert.strictEqual(result.total_entries, 3);

  // All three entries should be present
  const ids = result.entries.map(e => e.id);
  assert.ok(ids.includes(e1.id));
  assert.ok(ids.includes(e2.id));
  assert.ok(ids.includes(e3.id));
});

test('entries are sorted chronologically (oldest first)', () => {
  const ws = makeWorkspace();
  const opts = baseOpts(ws);

  writeMemory({ ...opts, content: 'First' });
  writeMemory({ ...opts, content: 'Second' });
  writeMemory({ ...opts, content: 'Third' });

  const result = readMemory({ agentId: 'agent-1', workspaceRoot: ws });
  assert.strictEqual(result.entries[0].content, 'First');
  assert.strictEqual(result.entries[1].content, 'Second');
  assert.strictEqual(result.entries[2].content, 'Third');
});

// =========================================================================
// Filtering
// =========================================================================
console.log('\n--- Filtering ---');

test('filterType returns only matching entries', () => {
  const ws = makeWorkspace();
  const opts = baseOpts(ws);

  writeMemory({ ...opts, type: 'observation', content: 'Obs 1' });
  writeMemory({ ...opts, type: 'lesson', content: 'Lesson 1' });
  writeMemory({ ...opts, type: 'observation', content: 'Obs 2' });
  writeMemory({ ...opts, type: 'warning', content: 'Warn 1' });

  const result = readMemory({ agentId: 'agent-1', workspaceRoot: ws, filterType: 'observation' });
  assert.strictEqual(result.total_entries, 2);
  assert.ok(result.entries.every(e => e.type === 'observation'));
});

test('filterProject returns only matching entries', () => {
  const ws = makeWorkspace();
  const opts = baseOpts(ws);

  writeMemory({ ...opts, projectId: 'proj-a', content: 'A1' });
  writeMemory({ ...opts, projectId: 'proj-b', content: 'B1' });
  writeMemory({ ...opts, projectId: 'proj-a', content: 'A2' });

  const result = readMemory({ agentId: 'agent-1', workspaceRoot: ws, filterProject: 'proj-b' });
  assert.strictEqual(result.total_entries, 1);
  assert.strictEqual(result.entries[0].project_id, 'proj-b');
});

test('filterStage returns only matching entries', () => {
  const ws = makeWorkspace();
  const opts = baseOpts(ws);

  writeMemory({ ...opts, stage: 'analyze', content: 'S1' });
  writeMemory({ ...opts, stage: 'plan', content: 'S2' });
  writeMemory({ ...opts, stage: 'analyze', content: 'S3' });

  const result = readMemory({ agentId: 'agent-1', workspaceRoot: ws, filterStage: 'plan' });
  assert.strictEqual(result.total_entries, 1);
  assert.strictEqual(result.entries[0].stage, 'plan');
});

test('multiple filters combine (AND)', () => {
  const ws = makeWorkspace();
  const opts = baseOpts(ws);

  writeMemory({ ...opts, type: 'observation', projectId: 'proj-a', content: 'Match' });
  writeMemory({ ...opts, type: 'lesson', projectId: 'proj-a', content: 'No match type' });
  writeMemory({ ...opts, type: 'observation', projectId: 'proj-b', content: 'No match project' });

  const result = readMemory({
    agentId: 'agent-1', workspaceRoot: ws,
    filterType: 'observation', filterProject: 'proj-a',
  });
  assert.strictEqual(result.total_entries, 1);
  assert.strictEqual(result.entries[0].content, 'Match');
});

// =========================================================================
// Limit
// =========================================================================
console.log('\n--- Limit ---');

test('limit returns most recent N entries', () => {
  const ws = makeWorkspace();
  const opts = baseOpts(ws);

  writeMemory({ ...opts, content: 'Old 1' });
  writeMemory({ ...opts, content: 'Old 2' });
  writeMemory({ ...opts, content: 'Recent 1' });
  writeMemory({ ...opts, content: 'Recent 2' });

  const result = readMemory({ agentId: 'agent-1', workspaceRoot: ws, limit: 2 });
  assert.strictEqual(result.total_entries, 4); // total_entries reflects count before limiting
  assert.strictEqual(result.entries.length, 2);
  assert.strictEqual(result.entries[0].content, 'Recent 1');
  assert.strictEqual(result.entries[1].content, 'Recent 2');
});

// =========================================================================
// by_type counts
// =========================================================================
console.log('\n--- by_type counts ---');

test('by_type counts are accurate', () => {
  const ws = makeWorkspace();
  const opts = baseOpts(ws);

  writeMemory({ ...opts, type: 'observation', content: 'O1' });
  writeMemory({ ...opts, type: 'observation', content: 'O2' });
  writeMemory({ ...opts, type: 'lesson', content: 'L1' });
  writeMemory({ ...opts, type: 'pattern', content: 'P1' });

  const result = readMemory({ agentId: 'agent-1', workspaceRoot: ws });
  assert.strictEqual(result.by_type.observation, 2);
  assert.strictEqual(result.by_type.lesson, 1);
  assert.strictEqual(result.by_type.pattern, 1);
});

// =========================================================================
// Empty / missing memory
// =========================================================================
console.log('\n--- Empty / missing memory ---');

test('read with no memory returns empty', () => {
  const ws = makeWorkspace();
  const result = readMemory({ agentId: 'nonexistent', workspaceRoot: ws });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.total_entries, 0);
  assert.deepStrictEqual(result.entries, []);
  assert.deepStrictEqual(result.by_type, {});
});

test('empty read output validates against index schema', () => {
  const ws = makeWorkspace();
  const result = readMemory({ agentId: 'nonexistent', workspaceRoot: ws });
  const v = validateAgainstSchema(result, INDEX_SCHEMA);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);
});

// =========================================================================
// Persistence across separate calls (simulating Run N → Run N+1)
// =========================================================================
console.log('\n--- Persistence across runs ---');

test('memory persists across separate read calls', () => {
  const ws = makeWorkspace();

  // Run N: write observation
  writeMemory({
    workspaceRoot: ws,
    agentId: 'agent-1',
    runId: 'run-N',
    projectId: 'proj-a',
    stage: 'analyze',
    type: 'observation',
    content: 'Completed analyze in Run N',
    tags: ['analyze', 'T1'],
  });

  // Run N+1: separate invocation reads it back
  const result = readMemory({ agentId: 'agent-1', workspaceRoot: ws });
  assert.strictEqual(result.total_entries, 1);
  assert.strictEqual(result.entries[0].run_id, 'run-N');
  assert.strictEqual(result.entries[0].content, 'Completed analyze in Run N');
});

// =========================================================================
// Validation errors
// =========================================================================
console.log('\n--- Validation errors ---');

test('rejects content over 2000 chars', () => {
  const ws = makeWorkspace();
  const opts = baseOpts(ws);
  const longContent = 'x'.repeat(2001);

  assert.throws(
    () => writeMemory({ ...opts, content: longContent }),
    /exceeds 2000/
  );
});

test('rejects missing required fields', () => {
  const ws = makeWorkspace();
  assert.throws(() => writeMemory({ workspaceRoot: ws }), /agent_id is required/);
  assert.throws(() => writeMemory({ workspaceRoot: ws, agentId: 'a' }), /run_id is required/);
});

test('rejects invalid type', () => {
  const ws = makeWorkspace();
  const opts = baseOpts(ws);

  assert.throws(
    () => writeMemory({ ...opts, type: 'invalid-type' }),
    /Validation failed/
  );
});

// =========================================================================
// Memory types
// =========================================================================
console.log('\n--- Memory types ---');

test('all four memory types are accepted', () => {
  const ws = makeWorkspace();
  const opts = baseOpts(ws);

  for (const type of ['observation', 'lesson', 'pattern', 'warning']) {
    const entry = writeMemory({ ...opts, type, content: `${type} entry` });
    assert.strictEqual(entry.type, type);
  }

  const result = readMemory({ agentId: 'agent-1', workspaceRoot: ws });
  assert.strictEqual(result.total_entries, 4);
});

// =========================================================================
// Tags
// =========================================================================
console.log('\n--- Tags ---');

test('tags are preserved in round-trip', () => {
  const ws = makeWorkspace();
  const opts = baseOpts(ws);

  writeMemory({ ...opts, tags: ['analyze', 'T1', 'critical'] });

  const result = readMemory({ agentId: 'agent-1', workspaceRoot: ws });
  assert.deepStrictEqual(result.entries[0].tags, ['analyze', 'T1', 'critical']);
});

test('empty tags array is valid', () => {
  const ws = makeWorkspace();
  const opts = baseOpts(ws);

  const entry = writeMemory({ ...opts, tags: [] });
  assert.deepStrictEqual(entry.tags, []);
});

// =========================================================================
// Summary
// =========================================================================
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
