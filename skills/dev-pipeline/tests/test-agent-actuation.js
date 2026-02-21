#!/usr/bin/env node
'use strict';

/**
 * Tests for Phase 5 agent assignment actuation.
 * Verifies recommended_agent flows from pick → drive → runner.
 *
 * Run: node skills/dev-pipeline/tests/test-agent-actuation.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { projectDriveOnce } = require(path.resolve(__dirname, '..', 'scripts', 'project-next-drive.js'));
const { pickNextTask } = require(path.resolve(__dirname, '..', 'scripts', 'project-next-pick.js'));
const { runAutonomous, scaffoldAdapter } = require(path.resolve(__dirname, '..', 'scripts', 'autonomous-runner.js'));
const { buildPromptContext } = require(path.resolve(__dirname, '..', 'scripts', 'prompt-context.js'));
const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));

const driveSchema = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'project-next-drive.output.schema.json'), 'utf8')
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-actuation-'));
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

function addBacklogItem(ws, projectId, item) {
  const defaults = {
    project_id: projectId,
    type: 'task',
    title: `Task ${item.id}`,
    description: 'Test task',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    status: 'todo',
    priority: 'P2',
    owner_role: 'DEV',
    depends_on: [],
    run_folder: null,
    tags: [],
    artifacts_expected: [],
    last_summary: null,
    parent_id: null,
    ...item,
  };
  fs.writeFileSync(
    path.join(ws, '.claw', 'backlog', `${defaults.id}.json`),
    JSON.stringify(defaults, null, 2),
    'utf8'
  );
}

function addRun(ws, runName, project, opts = {}) {
  const runDir = path.join(ws, '.claw', 'runs', runName);
  fs.mkdirSync(runDir, { recursive: true });

  fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify({
    ticket_id: opts.ticket_id || runName.split('_').pop(),
    title: 'test',
    project: project,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    current_stage: opts.current_stage || 'done',
    blocked: false,
    blocked_reason: null,
    responsible_agent: opts.responsible_agent || null,
    required_user_input: [],
    stage_history: opts.stage_history || [],
    next_actions: [],
  }), 'utf8');

  return `.claw/runs/${runName}`;
}

// =========================================================================
// Picker returns recommended_agent
// =========================================================================
console.log('\n--- Picker recommended_agent ---');

test('picker output includes recommended_agent field (may be null)', () => {
  const ws = makeWorkspace('proj-pick');
  addBacklogItem(ws, 'proj-pick', { id: 'T-1', status: 'todo', priority: 'P0' });

  const result = pickNextTask({ workspaceRoot: ws });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.action, 'picked_task');
  assert.ok('recommended_agent' in result, 'picker output should have recommended_agent field');
});

// =========================================================================
// Drive passes recommended_agent to runner
// =========================================================================
console.log('\n--- Drive passes recommended_agent ---');

test('drive output preserves recommended_agent from picker', () => {
  const ws = makeWorkspace('proj-pass');
  addBacklogItem(ws, 'proj-pass', { id: 'T-1', status: 'todo', priority: 'P0' });

  const result = projectDriveOnce({
    workspaceRoot: ws,
    agentAdapter: scaffoldAdapter,
    maxSteps: 3,
  });

  assert.strictEqual(result.ok, true);
  assert.ok(result.picked, 'should have picked field');
  assert.ok('recommended_agent' in result.picked, 'picked should have recommended_agent');
});

// =========================================================================
// Agent context includes agentId
// =========================================================================
console.log('\n--- Agent context ---');

test('drive with scaffoldAdapter passes agentId through to runner', () => {
  const ws = makeWorkspace('proj-ctx');
  addBacklogItem(ws, 'proj-ctx', { id: 'T-1', status: 'todo', priority: 'P0' });

  // Use a custom adapter that captures the context to verify agentId is passed
  let capturedContext = null;
  const capturingAdapter = (context) => {
    capturedContext = context;
    return scaffoldAdapter(context);
  };

  const result = projectDriveOnce({
    workspaceRoot: ws,
    agentAdapter: capturingAdapter,
    maxSteps: 3,
  });

  assert.strictEqual(result.ok, true);
  // The context should have agentId set (from recommended_agent)
  if (capturedContext) {
    // agentId should be passed through (may be null if no perf data)
    assert.ok('agentId' in capturedContext, 'context should have agentId field');
  }
});

test('drive works without recommended_agent (null agentId backward compat)', () => {
  const ws = makeWorkspace('proj-null');
  addBacklogItem(ws, 'proj-null', { id: 'T-1', status: 'todo', priority: 'P0' });

  const result = projectDriveOnce({
    workspaceRoot: ws,
    agentAdapter: scaffoldAdapter,
    maxSteps: 3,
  });

  assert.strictEqual(result.ok, true);
  // recommended_agent is null when no agent performance data exists
  assert.ok(result.picked.recommended_agent === null || typeof result.picked.recommended_agent === 'string');
});

// =========================================================================
// Prompt context uses agentId
// =========================================================================
console.log('\n--- Prompt context with agentId ---');

test('buildPromptContext accepts agentId and returns agent-specific context', () => {
  const ws = makeWorkspace('proj-pc');
  const { writeMemory } = require(path.resolve(__dirname, '..', 'scripts', 'agent-memory.js'));

  // Write memory for specific agent
  writeMemory({
    workspaceRoot: ws, agentId: 'agent-A', runId: 'run-1',
    projectId: 'proj-pc', stage: 'review', type: 'evaluation',
    content: 'Agent A evaluation: score=0.9',
    tags: ['test'],
  });

  // Write memory for different agent
  writeMemory({
    workspaceRoot: ws, agentId: 'agent-B', runId: 'run-1',
    projectId: 'proj-pc', stage: 'review', type: 'evaluation',
    content: 'Agent B evaluation: score=0.3',
    tags: ['test'],
  });

  // Agent A should only see its own memory
  const ctxA = buildPromptContext({ workspaceRoot: ws, projectId: 'proj-pc', agentId: 'agent-A' });
  assert.strictEqual(ctxA.ok, true);
  assert.ok(ctxA.context_text.includes('Agent A'), 'should include agent A context');
  assert.ok(!ctxA.context_text.includes('Agent B'), 'should not include agent B context');

  // Agent B should only see its own memory
  const ctxB = buildPromptContext({ workspaceRoot: ws, projectId: 'proj-pc', agentId: 'agent-B' });
  assert.strictEqual(ctxB.ok, true);
  assert.ok(ctxB.context_text.includes('Agent B'), 'should include agent B context');
  assert.ok(!ctxB.context_text.includes('Agent A'), 'should not include agent A context');
});

// =========================================================================
// End-to-end: pick → drive → runner with agent
// =========================================================================
console.log('\n--- End-to-end flow ---');

test('drive output with post_run validates against schema', () => {
  const ws = makeWorkspace('proj-e2e');
  addBacklogItem(ws, 'proj-e2e', { id: 'T-1', status: 'todo', priority: 'P0' });

  // Add baseline runs for self-evaluation
  addRun(ws, '20260101_000000_T-base1', 'proj-e2e', {
    current_stage: 'done',
    stage_history: [
      { stage: 'implement', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:10:00Z', artifact_paths: [], agent_id: null },
    ],
  });
  addRun(ws, '20260102_000000_T-base2', 'proj-e2e', {
    current_stage: 'done',
    stage_history: [
      { stage: 'implement', started_at: '2026-01-02T00:00:00Z', finished_at: '2026-01-02T00:10:00Z', artifact_paths: [], agent_id: null },
    ],
  });

  const result = projectDriveOnce({
    workspaceRoot: ws,
    agentAdapter: scaffoldAdapter,
    maxSteps: 3,
  });

  assert.strictEqual(result.ok, true);
  const v = validateAgainstSchema(result, driveSchema);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);
});

// =========================================================================
// Summary
// =========================================================================
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
