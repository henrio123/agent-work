#!/usr/bin/env node
'use strict';

/**
 * Tests for prompt-context.js (Phase 5, Epic 2).
 *
 * Run: node skills/dev-pipeline/tests/test-prompt-context.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { buildPromptContext } = require(path.resolve(__dirname, '..', 'scripts', 'prompt-context.js'));
const { writeMemory } = require(path.resolve(__dirname, '..', 'scripts', 'agent-memory.js'));
const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));

const schema = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'prompt-context.output.schema.json'), 'utf8')
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-ctx-'));
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
    required_user_input: [],
    stage_history: opts.stage_history || [],
    next_actions: [],
  }), 'utf8');

  if (opts.qa) {
    fs.writeFileSync(path.join(runDir, '50-qa-report.json'), JSON.stringify(opts.qa), 'utf8');
  }
  if (opts.review) {
    fs.writeFileSync(path.join(runDir, '60-review-report.json'), JSON.stringify(opts.review), 'utf8');
  }

  return `.claw/runs/${runName}`;
}

// =========================================================================
// Empty memory
// =========================================================================
console.log('\n--- Empty memory ---');

test('no context when no memory and no suggestions', () => {
  const ws = makeWorkspace('proj-empty');

  const result = buildPromptContext({
    workspaceRoot: ws, projectId: 'proj-empty', agentId: 'agent-01',
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.action, 'no_context');
  assert.strictEqual(result.context_text, '');
  assert.strictEqual(result.memory_entries_used, 0);
  assert.strictEqual(result.workflow_suggestions_used, 0);
});

test('no context when no agentId', () => {
  const ws = makeWorkspace('proj-noagent');

  const result = buildPromptContext({ workspaceRoot: ws, projectId: 'proj-noagent' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.context_text, '');
});

// =========================================================================
// With evaluations
// =========================================================================
console.log('\n--- With evaluations ---');

test('includes evaluation memory entries', () => {
  const ws = makeWorkspace('proj-eval');

  writeMemory({
    workspaceRoot: ws, agentId: 'agent-01', runId: 'run-1',
    projectId: 'proj-eval', stage: 'review', type: 'evaluation',
    content: 'Self-evaluation: score=0.85, 0 worse deviations',
    tags: ['self-evaluation'],
  });

  const result = buildPromptContext({
    workspaceRoot: ws, projectId: 'proj-eval', agentId: 'agent-01',
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.action, 'context_built');
  assert.ok(result.context_text.includes('[evaluation]'));
  assert.ok(result.context_text.includes('score=0.85'));
  assert.ok(result.memory_entries_used >= 1);
});

// =========================================================================
// With lessons
// =========================================================================
console.log('\n--- With lessons ---');

test('includes lesson memory entries', () => {
  const ws = makeWorkspace('proj-lesson');

  writeMemory({
    workspaceRoot: ws, agentId: 'agent-02', runId: 'run-1',
    projectId: 'proj-lesson', stage: 'qa', type: 'lesson',
    content: 'QA frequently flags missing error handling',
    tags: ['qa'],
  });

  const result = buildPromptContext({
    workspaceRoot: ws, projectId: 'proj-lesson', agentId: 'agent-02',
  });
  assert.strictEqual(result.ok, true);
  assert.ok(result.context_text.includes('[lesson]'));
  assert.ok(result.context_text.includes('error handling'));
});

// =========================================================================
// With warnings
// =========================================================================
console.log('\n--- With warnings ---');

test('includes warning memory entries', () => {
  const ws = makeWorkspace('proj-warn');

  writeMemory({
    workspaceRoot: ws, agentId: 'agent-03', runId: 'run-1',
    projectId: 'proj-warn', stage: 'review', type: 'warning',
    content: 'Review rejection rate is 25% — pay attention to code style',
    tags: ['review'],
  });

  const result = buildPromptContext({
    workspaceRoot: ws, projectId: 'proj-warn', agentId: 'agent-03',
  });
  assert.strictEqual(result.ok, true);
  assert.ok(result.context_text.includes('[warning]'));
  assert.ok(result.context_text.includes('rejection rate'));
});

// =========================================================================
// With workflow suggestions
// =========================================================================
console.log('\n--- With workflow suggestions ---');

test('includes workflow suggestions when available', () => {
  const ws = makeWorkspace('proj-wf');

  // Need enough runs with failures to trigger workflow suggestions
  for (let i = 1; i <= 5; i++) {
    addRun(ws, `2026010${i}_000000_T-${i}`, 'proj-wf', {
      current_stage: 'done',
      stage_history: [
        { stage: 'implement', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:10:00Z', artifact_paths: [], agent_id: null },
      ],
      qa: { ticket_id: `T-${i}`, tests_run: 5, tests_passed: 1, tests_failed: 4, verdict: 'fail',
        issues: [{ description: 'X', severity: 'high' }] },
      review: { ticket_id: `T-${i}`, stage_compliance: true, artifact_validation: true, verdict: 'approved' },
    });
  }

  const result = buildPromptContext({
    workspaceRoot: ws, projectId: 'proj-wf', agentId: 'agent-04',
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.action, 'context_built');
  assert.ok(result.workflow_suggestions_used >= 1, `Expected suggestions, got ${result.workflow_suggestions_used}`);
  assert.ok(result.context_text.includes('Workflow suggestions'));
});

// =========================================================================
// Truncation
// =========================================================================
console.log('\n--- Truncation ---');

test('truncates context to max 2000 chars', () => {
  const ws = makeWorkspace('proj-trunc');

  // Write many long memory entries
  for (let i = 0; i < 20; i++) {
    writeMemory({
      workspaceRoot: ws, agentId: 'agent-05', runId: `run-${i}`,
      projectId: 'proj-trunc', stage: 'review', type: 'evaluation',
      content: `Evaluation ${i}: ${'x'.repeat(200)}`,
      tags: ['test'],
    });
  }

  const result = buildPromptContext({
    workspaceRoot: ws, projectId: 'proj-trunc', agentId: 'agent-05',
  });
  assert.strictEqual(result.ok, true);
  assert.ok(result.context_length <= 2000, `Context too long: ${result.context_length}`);
});

// =========================================================================
// Schema validation
// =========================================================================
console.log('\n--- Schema validation ---');

test('context_built result validates against schema', () => {
  const ws = makeWorkspace('proj-sv');

  writeMemory({
    workspaceRoot: ws, agentId: 'agent-06', runId: 'run-1',
    projectId: 'proj-sv', stage: 'review', type: 'evaluation',
    content: 'Self-evaluation: score=0.9',
    tags: ['test'],
  });

  const result = buildPromptContext({
    workspaceRoot: ws, projectId: 'proj-sv', agentId: 'agent-06',
  });
  const v = validateAgainstSchema(result, schema);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);
});

test('no_context result validates against schema', () => {
  const ws = makeWorkspace('proj-sv2');
  const result = buildPromptContext({
    workspaceRoot: ws, projectId: 'proj-sv2', agentId: 'agent-07',
  });
  const v = validateAgainstSchema(result, schema);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);
});

// =========================================================================
// Backward compat
// =========================================================================
console.log('\n--- Backward compat ---');

test('no context = same prompt (backward compatible)', () => {
  const ws = makeWorkspace('proj-bc');
  const result = buildPromptContext({
    workspaceRoot: ws, projectId: 'proj-bc', agentId: 'agent-08',
  });
  assert.strictEqual(result.context_text, '');
});

// =========================================================================
// Combined context
// =========================================================================
console.log('\n--- Combined context ---');

test('combines memory entries and workflow suggestions', () => {
  const ws = makeWorkspace('proj-combo');

  writeMemory({
    workspaceRoot: ws, agentId: 'agent-09', runId: 'run-1',
    projectId: 'proj-combo', stage: 'review', type: 'evaluation',
    content: 'Score=0.7',
    tags: ['test'],
  });

  writeMemory({
    workspaceRoot: ws, agentId: 'agent-09', runId: 'run-2',
    projectId: 'proj-combo', stage: 'qa', type: 'lesson',
    content: 'Always add tests',
    tags: ['test'],
  });

  // Need runs with failures for workflow suggestions
  for (let i = 1; i <= 5; i++) {
    addRun(ws, `2026010${i}_000000_T-${i}`, 'proj-combo', {
      current_stage: 'done',
      stage_history: [
        { stage: 'implement', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:10:00Z', artifact_paths: [], agent_id: null },
      ],
      qa: { ticket_id: `T-${i}`, tests_run: 5, tests_passed: 1, tests_failed: 4, verdict: 'fail',
        issues: [{ description: 'X', severity: 'high' }] },
    });
  }

  const result = buildPromptContext({
    workspaceRoot: ws, projectId: 'proj-combo', agentId: 'agent-09',
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.action, 'context_built');
  assert.ok(result.context_text.includes('Prior insights'));
  assert.ok(result.context_text.includes('Workflow suggestions'));
  assert.ok(result.memory_entries_used >= 2);
  assert.ok(result.workflow_suggestions_used >= 1);
});

// =========================================================================
// Summary
// =========================================================================
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
