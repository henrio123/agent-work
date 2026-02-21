#!/usr/bin/env node
'use strict';

/**
 * Tests for Phase 5 dashboard fields.
 *
 * Run: node skills/dev-pipeline/tests/test-dashboard-phase5.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { buildDashboard } = require(path.resolve(__dirname, '..', 'scripts', 'project-dashboard.js'));
const { writeMemory } = require(path.resolve(__dirname, '..', 'scripts', 'agent-memory.js'));
const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));

const schema = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'project-dashboard.output.schema.json'), 'utf8')
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-p5-'));
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

function makeWorkspace(projectId) {
  const ws = fs.mkdtempSync(path.join(TMP, 'ws-'));
  const clawDir = path.join(ws, '.claw');
  fs.mkdirSync(path.join(clawDir, 'backlog'), { recursive: true });
  fs.mkdirSync(path.join(clawDir, 'runs'), { recursive: true });
  fs.mkdirSync(path.join(clawDir, 'task-packs'), { recursive: true });
  fs.mkdirSync(path.join(clawDir, 'agents'), { recursive: true });

  fs.writeFileSync(path.join(clawDir, 'project.json'), JSON.stringify({
    project_id: projectId,
    title: `Test ${projectId}`,
    description: 'test',
    repo_path: ws,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }), 'utf8');

  return ws;
}

// =========================================================================
// Post-run hooks enabled
// =========================================================================
console.log('\n--- Post-run hooks status ---');

test('post_run_hooks_enabled is true (module exists)', () => {
  const ws = makeWorkspace('proj-hooks');
  const result = buildDashboard({ workspaceRoot: ws });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.summary.post_run_hooks_enabled, true);
});

// =========================================================================
// Adaptive loop status
// =========================================================================
console.log('\n--- Adaptive loop status ---');

test('adaptive_loop_status is available (module exists)', () => {
  const ws = makeWorkspace('proj-loop');
  const result = buildDashboard({ workspaceRoot: ws });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.summary.adaptive_loop_status, 'available');
});

// =========================================================================
// Last self-evaluation (no data)
// =========================================================================
console.log('\n--- Last self-evaluation ---');

test('last_self_evaluation is null when no evaluations exist', () => {
  const ws = makeWorkspace('proj-noeval');
  const result = buildDashboard({ workspaceRoot: ws });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.summary.last_self_evaluation, null);
});

test('last_self_evaluation populated when evaluation memory exists', () => {
  const ws = makeWorkspace('proj-eval');

  writeMemory({
    workspaceRoot: ws, agentId: 'agent-01', runId: 'run-1',
    projectId: 'proj-eval', stage: 'review', type: 'evaluation',
    content: 'Self-evaluation: score=0.85, 0 worse deviations, 0 suggestions.',
    tags: ['self-evaluation'],
  });

  const result = buildDashboard({ workspaceRoot: ws });
  assert.strictEqual(result.ok, true);
  assert.ok(result.summary.last_self_evaluation !== null, 'should have last_self_evaluation');
  assert.strictEqual(result.summary.last_self_evaluation.quality_score, 0.85);
  assert.strictEqual(result.summary.last_self_evaluation.agent_id, 'agent-01');
});

// =========================================================================
// Schema validation
// =========================================================================
console.log('\n--- Schema validation ---');

test('dashboard with Phase 5 fields validates against schema', () => {
  const ws = makeWorkspace('proj-sv');

  writeMemory({
    workspaceRoot: ws, agentId: 'agent-sv', runId: 'run-1',
    projectId: 'proj-sv', stage: 'review', type: 'evaluation',
    content: 'Self-evaluation: score=0.7, 1 worse deviations, 2 suggestions.',
    tags: ['self-evaluation'],
  });

  const result = buildDashboard({ workspaceRoot: ws });
  const v = validateAgainstSchema(result, schema);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);
});

test('empty dashboard validates against schema', () => {
  const ws = makeWorkspace('proj-sv2');
  const result = buildDashboard({ workspaceRoot: ws });
  const v = validateAgainstSchema(result, schema);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);
});

// =========================================================================
// Summary
// =========================================================================
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
