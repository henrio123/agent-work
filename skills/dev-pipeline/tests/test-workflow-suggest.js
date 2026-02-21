#!/usr/bin/env node
'use strict';

/**
 * Tests for workflow-suggest.js (Phase 4, Epic 3).
 *
 * Run: node skills/dev-pipeline/tests/test-workflow-suggest.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { generateWorkflowSuggestions } = require(path.resolve(__dirname, '..', 'scripts', 'workflow-suggest.js'));
const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));

const schema = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'workflow-suggestions.output.schema.json'), 'utf8')
);

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'workflow-suggest.js');
const SHELL = path.resolve(__dirname, '..', '..', '..', 'tools', 'workflow-suggest.sh');

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-suggest-'));
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

function makeWorkspace(projectId) {
  const ws = fs.mkdtempSync(path.join(TMP, 'ws-'));
  const clawDir = path.join(ws, '.claw');
  fs.mkdirSync(path.join(clawDir, 'backlog'), { recursive: true });
  fs.mkdirSync(path.join(clawDir, 'runs'), { recursive: true });
  fs.mkdirSync(path.join(clawDir, 'task-packs'), { recursive: true });

  fs.writeFileSync(path.join(clawDir, 'project.json'), JSON.stringify({
    project_id: projectId, title: `Test ${projectId}`, description: 'test',
    repo_path: ws, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  }), 'utf8');

  return ws;
}

function addRun(ws, runName, project, opts = {}) {
  const runDir = path.join(ws, '.claw', 'runs', runName);
  fs.mkdirSync(runDir, { recursive: true });

  fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify({
    ticket_id: opts.ticket_id || runName.split('_').pop(),
    title: 'test', project: project,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    current_stage: opts.current_stage || 'done',
    blocked: false, blocked_reason: null, responsible_agent: null,
    required_user_input: [], stage_history: opts.stage_history || [], next_actions: [],
  }), 'utf8');

  if (opts.qa) fs.writeFileSync(path.join(runDir, '50-qa-report.json'), JSON.stringify(opts.qa), 'utf8');
  if (opts.review) fs.writeFileSync(path.join(runDir, '60-review-report.json'), JSON.stringify(opts.review), 'utf8');
}

// =========================================================================
// No runs
// =========================================================================
console.log('\n--- No runs ---');

test('no runs produces empty suggestions', () => {
  const ws = makeWorkspace('proj-empty');
  const result = generateWorkflowSuggestions({ workspaceRoot: ws, projectId: 'proj-empty' });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.action, 'suggestions_generated');
  assert.strictEqual(result.suggestions.length, 0);
  assert.strictEqual(result.summary.total_suggestions, 0);
});

test('no runs validates against schema', () => {
  const ws = makeWorkspace('proj-val');
  const result = generateWorkflowSuggestions({ workspaceRoot: ws, projectId: 'proj-val' });
  const v = validateAgainstSchema(result, schema);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);
});

// =========================================================================
// All pass — no suggestions
// =========================================================================
console.log('\n--- All pass ---');

test('all-pass project produces no suggestions', () => {
  const ws = makeWorkspace('proj-clean');
  for (let i = 1; i <= 5; i++) {
    addRun(ws, `2026010${i}_000000_T-${i}`, 'proj-clean', {
      current_stage: 'done',
      stage_history: [
        { stage: 'implement', started_at: `2026-01-0${i}T00:00:00Z`, finished_at: `2026-01-0${i}T00:10:00Z`, artifact_paths: [], agent_id: null },
      ],
      qa: { ticket_id: `T-${i}`, tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
      review: { ticket_id: `T-${i}`, stage_compliance: true, artifact_validation: true, verdict: 'approved' },
    });
  }

  const result = generateWorkflowSuggestions({ workspaceRoot: ws, projectId: 'proj-clean' });
  assert.strictEqual(result.suggestions.length, 0);
});

// =========================================================================
// High QA failure
// =========================================================================
console.log('\n--- High QA failure ---');

test('detects recurring QA failures above 30%', () => {
  const ws = makeWorkspace('proj-qafl');
  for (let i = 1; i <= 5; i++) {
    const fail = i <= 3; // 3 out of 5 fail = 60%
    addRun(ws, `2026010${i}_000000_T-${i}`, 'proj-qafl', {
      current_stage: 'done',
      qa: { ticket_id: `T-${i}`, tests_run: 5, tests_passed: fail ? 1 : 5, tests_failed: fail ? 4 : 0, verdict: fail ? 'fail' : 'pass' },
      review: { ticket_id: `T-${i}`, stage_compliance: true, artifact_validation: true, verdict: 'approved' },
    });
  }

  const result = generateWorkflowSuggestions({ workspaceRoot: ws, projectId: 'proj-qafl' });
  const qaSug = result.suggestions.find(s => s.category === 'recurring_qa_failure');
  assert.ok(qaSug, 'Should detect recurring QA failure');
  assert.strictEqual(qaSug.confidence, 'high');
  assert.ok(qaSug.evidence.length > 0);
});

// =========================================================================
// Bottleneck stage
// =========================================================================
console.log('\n--- Bottleneck stage ---');

test('detects bottleneck stage (>2x median)', () => {
  const ws = makeWorkspace('proj-bottle');
  for (let i = 1; i <= 5; i++) {
    addRun(ws, `2026010${i}_000000_T-${i}`, 'proj-bottle', {
      current_stage: 'done',
      stage_history: [
        { stage: 'intake', started_at: `2026-01-0${i}T00:00:00Z`, finished_at: `2026-01-0${i}T00:01:00Z`, artifact_paths: [], agent_id: null },
        { stage: 'implement', started_at: `2026-01-0${i}T00:01:00Z`, finished_at: `2026-01-0${i}T00:02:00Z`, artifact_paths: [], agent_id: null },
        { stage: 'validate', started_at: `2026-01-0${i}T00:02:00Z`, finished_at: `2026-01-0${i}T01:02:00Z`, artifact_paths: [], agent_id: null },
      ],
      qa: { ticket_id: `T-${i}`, tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
    });
  }

  const result = generateWorkflowSuggestions({ workspaceRoot: ws, projectId: 'proj-bottle' });
  const bSug = result.suggestions.find(s => s.category === 'bottleneck_stage');
  assert.ok(bSug, 'Should detect bottleneck');
  assert.ok(bSug.description.includes('validate'));
});

// =========================================================================
// High rejection rate
// =========================================================================
console.log('\n--- High rejection rate ---');

test('detects high review rejection/changes rate', () => {
  const ws = makeWorkspace('proj-rej');
  for (let i = 1; i <= 5; i++) {
    const verdict = i <= 3 ? 'changes_requested' : 'approved';
    addRun(ws, `2026010${i}_000000_T-${i}`, 'proj-rej', {
      current_stage: 'done',
      qa: { ticket_id: `T-${i}`, tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
      review: {
        ticket_id: `T-${i}`, stage_compliance: true, artifact_validation: true,
        verdict,
        policy_violations: verdict === 'changes_requested' ? ['lint'] : [],
      },
    });
  }

  const result = generateWorkflowSuggestions({ workspaceRoot: ws, projectId: 'proj-rej' });
  const rSug = result.suggestions.find(s => s.category === 'high_rejection_rate');
  assert.ok(rSug, 'Should detect high rejection rate');
  assert.strictEqual(rSug.confidence, 'high');
});

// =========================================================================
// Quality trend
// =========================================================================
console.log('\n--- Quality trend ---');

test('detects declining quality trend (last 3 runs)', () => {
  const ws = makeWorkspace('proj-trend');

  // Run 1: good
  addRun(ws, '20260101_000000_T-1', 'proj-trend', {
    current_stage: 'done',
    qa: { ticket_id: 'T-1', tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
    review: { ticket_id: 'T-1', stage_compliance: true, artifact_validation: true, verdict: 'approved' },
  });

  // Runs 2-4: all bad
  for (let i = 2; i <= 4; i++) {
    addRun(ws, `2026010${i}_000000_T-${i}`, 'proj-trend', {
      current_stage: 'done',
      qa: { ticket_id: `T-${i}`, tests_run: 5, tests_passed: 1, tests_failed: 4, verdict: 'fail' },
      review: { ticket_id: `T-${i}`, stage_compliance: true, artifact_validation: true, verdict: 'rejected' },
    });
  }

  const result = generateWorkflowSuggestions({ workspaceRoot: ws, projectId: 'proj-trend' });
  const tSug = result.suggestions.find(s => s.category === 'quality_trend');
  assert.ok(tSug, 'Should detect quality trend');
  assert.strictEqual(tSug.priority, 'P0');
});

// =========================================================================
// Confidence scoring
// =========================================================================
console.log('\n--- Confidence scoring ---');

test('fewer than 5 runs gives medium confidence', () => {
  const ws = makeWorkspace('proj-conf');
  for (let i = 1; i <= 3; i++) {
    addRun(ws, `2026010${i}_000000_T-${i}`, 'proj-conf', {
      current_stage: 'done',
      qa: { ticket_id: `T-${i}`, tests_run: 5, tests_passed: 1, tests_failed: 4, verdict: 'fail' },
      review: { ticket_id: `T-${i}`, stage_compliance: true, artifact_validation: true, verdict: 'approved' },
    });
  }

  const result = generateWorkflowSuggestions({ workspaceRoot: ws, projectId: 'proj-conf' });
  const qaSug = result.suggestions.find(s => s.category === 'recurring_qa_failure');
  assert.ok(qaSug, 'Should still detect with 3 runs');
  assert.strictEqual(qaSug.confidence, 'medium');
});

// =========================================================================
// Schema validation with suggestions
// =========================================================================
console.log('\n--- Schema validation ---');

test('result with suggestions validates against schema', () => {
  const ws = makeWorkspace('proj-sv');
  for (let i = 1; i <= 5; i++) {
    addRun(ws, `2026010${i}_000000_T-${i}`, 'proj-sv', {
      current_stage: 'done',
      stage_history: [
        { stage: 'implement', started_at: `2026-01-0${i}T00:00:00Z`, finished_at: `2026-01-0${i}T00:10:00Z`, artifact_paths: [], agent_id: null },
      ],
      qa: { ticket_id: `T-${i}`, tests_run: 5, tests_passed: 1, tests_failed: 4, verdict: 'fail',
        issues: [{ description: 'Bug', severity: 'high' }] },
      review: { ticket_id: `T-${i}`, stage_compliance: true, artifact_validation: true, verdict: 'changes_requested',
        policy_violations: ['lint'], comments: ['Fix'] },
    });
  }

  const result = generateWorkflowSuggestions({ workspaceRoot: ws, projectId: 'proj-sv' });
  const v = validateAgainstSchema(result, schema);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);
  assert.ok(result.suggestions.length > 0);
});

// =========================================================================
// Summary counts
// =========================================================================
console.log('\n--- Summary counts ---');

test('summary by_category and by_confidence match suggestions', () => {
  const ws = makeWorkspace('proj-summ');
  for (let i = 1; i <= 5; i++) {
    addRun(ws, `2026010${i}_000000_T-${i}`, 'proj-summ', {
      current_stage: 'done',
      qa: { ticket_id: `T-${i}`, tests_run: 5, tests_passed: 1, tests_failed: 4, verdict: 'fail' },
      review: { ticket_id: `T-${i}`, stage_compliance: true, artifact_validation: true, verdict: 'rejected' },
    });
  }

  const result = generateWorkflowSuggestions({ workspaceRoot: ws, projectId: 'proj-summ' });
  let catTotal = 0;
  for (const v of Object.values(result.summary.by_category)) catTotal += v;
  assert.strictEqual(catTotal, result.summary.total_suggestions);

  let confTotal = 0;
  for (const v of Object.values(result.summary.by_confidence)) confTotal += v;
  assert.strictEqual(confTotal, result.summary.total_suggestions);
});

// =========================================================================
// CLI
// =========================================================================
console.log('\n--- CLI ---');

test('CLI outputs valid JSON', () => {
  const ws = makeWorkspace('proj-cli');
  const stdout = execFileSync('node', [SCRIPT, '--project', 'proj-cli'], {
    encoding: 'utf8', timeout: 10000,
    env: { ...process.env, WORKSPACE_ROOT: ws },
  });
  const parsed = JSON.parse(stdout);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.action, 'suggestions_generated');
});

// =========================================================================
// Summary
// =========================================================================
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
