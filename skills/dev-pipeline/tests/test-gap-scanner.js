#!/usr/bin/env node
'use strict';

/**
 * Tests for gap-scanner.js (Phase 4, Epic 4).
 *
 * Run: node skills/dev-pipeline/tests/test-gap-scanner.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { scanGaps } = require(path.resolve(__dirname, '..', 'scripts', 'gap-scanner.js'));
const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));

const schema = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'gap-scanner.output.schema.json'), 'utf8')
);

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'gap-scanner.js');
const SHELL = path.resolve(__dirname, '..', '..', '..', 'tools', 'gap-scanner.sh');

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-scan-'));
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

function makeWorkspace(projectId) {
  const ws = fs.mkdtempSync(path.join(TMP, 'ws-'));
  const clawDir = path.join(ws, '.claw');
  fs.mkdirSync(path.join(clawDir, 'backlog'), { recursive: true });
  fs.mkdirSync(path.join(clawDir, 'runs'), { recursive: true });
  fs.mkdirSync(path.join(clawDir, 'task-packs'), { recursive: true });
  fs.mkdirSync(path.join(clawDir, 'tickets'), { recursive: true });

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
  if (opts.research) fs.writeFileSync(path.join(runDir, '18-research-findings.json'), JSON.stringify(opts.research), 'utf8');

  return `.claw/runs/${runName}`;
}

// =========================================================================
// No gaps
// =========================================================================
console.log('\n--- No gaps ---');

test('clean project with no issues returns empty gaps', () => {
  const ws = makeWorkspace('proj-clean');
  addRun(ws, '20260101_000000_T-1', 'proj-clean', {
    current_stage: 'done',
    qa: { ticket_id: 'T-1', tests_run: 5, tests_passed: 5, tests_failed: 0, verdict: 'pass' },
    review: { ticket_id: 'T-1', stage_compliance: true, artifact_validation: true, verdict: 'approved' },
  });

  const result = scanGaps({ workspaceRoot: ws, projectId: 'proj-clean' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.action, 'gaps_scanned');
  assert.strictEqual(result.gaps.length, 0);
  assert.strictEqual(result.summary.total_gaps, 0);
  assert.strictEqual(result.summary.auto_created_count, 0);
});

test('empty project validates against schema', () => {
  const ws = makeWorkspace('proj-val');
  const result = scanGaps({ workspaceRoot: ws, projectId: 'proj-val' });
  const v = validateAgainstSchema(result, schema);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);
});

// =========================================================================
// QA issues
// =========================================================================
console.log('\n--- QA issues ---');

test('detects high/critical QA issues without follow-up', () => {
  const ws = makeWorkspace('proj-qa');
  addRun(ws, '20260101_000000_T-1', 'proj-qa', {
    current_stage: 'done',
    qa: {
      ticket_id: 'T-1', tests_run: 5, tests_passed: 2, tests_failed: 3, verdict: 'fail',
      issues: [
        { description: 'Critical bug in auth', severity: 'critical' },
        { description: 'Minor style issue', severity: 'low' },
        { description: 'High priority memory leak', severity: 'high' },
      ],
    },
  });

  const result = scanGaps({ workspaceRoot: ws, projectId: 'proj-qa' });
  assert.strictEqual(result.gaps.length, 2); // Only high + critical
  assert.ok(result.gaps.every(g => g.type === 'qa_issue_no_followup'));
  assert.ok(result.gaps.some(g => g.severity === 'critical'));
  assert.ok(result.gaps.some(g => g.severity === 'high'));
});

// =========================================================================
// Review changes
// =========================================================================
console.log('\n--- Review changes ---');

test('detects unaddressed review changes', () => {
  const ws = makeWorkspace('proj-rev');
  addRun(ws, '20260101_000000_T-1', 'proj-rev', {
    current_stage: 'done',
    review: {
      ticket_id: 'T-1', stage_compliance: true, artifact_validation: true,
      verdict: 'changes_requested',
      policy_violations: ['missing-tests'],
    },
  });

  const result = scanGaps({ workspaceRoot: ws, projectId: 'proj-rev' });
  assert.ok(result.gaps.some(g => g.type === 'review_changes_unaddressed'));
  assert.ok(result.gaps.find(g => g.type === 'review_changes_unaddressed').severity === 'high');
});

// =========================================================================
// Research questions
// =========================================================================
console.log('\n--- Research questions ---');

test('detects open research questions', () => {
  const ws = makeWorkspace('proj-res');
  addRun(ws, '20260101_000000_T-1', 'proj-res', {
    current_stage: 'done',
    research: {
      ticket_id: 'T-1', hypotheses: [], methods: [], findings: [],
      conclusion: 'Partial', open_questions: ['How to scale?', 'What about caching?'],
    },
  });

  const result = scanGaps({ workspaceRoot: ws, projectId: 'proj-res' });
  const resGaps = result.gaps.filter(g => g.type === 'research_open_question');
  assert.strictEqual(resGaps.length, 2);
  assert.ok(resGaps.every(g => g.severity === 'medium'));
});

// =========================================================================
// Unresolved task pack questions
// =========================================================================
console.log('\n--- Unresolved questions ---');

test('detects unresolved task pack questions', () => {
  const ws = makeWorkspace('proj-tp');
  const taskPackDir = path.join(ws, '.claw', 'task-packs');
  fs.writeFileSync(path.join(taskPackDir, 'T-1.json'), JSON.stringify({
    ticket_id: 'T-1',
    open_questions: ['What is the API format?'],
  }), 'utf8');

  const result = scanGaps({ workspaceRoot: ws, projectId: 'proj-tp' });
  const tpGaps = result.gaps.filter(g => g.type === 'unresolved_question');
  assert.strictEqual(tpGaps.length, 1);
  assert.strictEqual(tpGaps[0].severity, 'low');
});

// =========================================================================
// Auto-create
// =========================================================================
console.log('\n--- Auto-create ---');

test('autoCreate creates backlog items via createTicketAndBacklog', () => {
  const ws = makeWorkspace('proj-auto');
  addRun(ws, '20260101_000000_T-1', 'proj-auto', {
    current_stage: 'done',
    qa: {
      ticket_id: 'T-1', tests_run: 5, tests_passed: 2, tests_failed: 3, verdict: 'fail',
      issues: [{ description: 'Critical bug', severity: 'critical' }],
    },
  });

  const result = scanGaps({ workspaceRoot: ws, projectId: 'proj-auto', autoCreate: true });
  assert.strictEqual(result.summary.auto_created_count, 1);
  assert.ok(result.gaps[0].auto_created_ticket);

  // Verify backlog item was written
  const backlogDir = path.join(ws, '.claw', 'backlog');
  const files = fs.readdirSync(backlogDir).filter(f => f.endsWith('.json'));
  assert.ok(files.length >= 1, 'Should have created a backlog item');
});

// =========================================================================
// Idempotency
// =========================================================================
console.log('\n--- Idempotency ---');

test('auto-create is idempotent (no duplicate backlog items)', () => {
  const ws = makeWorkspace('proj-idem');
  addRun(ws, '20260101_000000_T-1', 'proj-idem', {
    current_stage: 'done',
    qa: {
      ticket_id: 'T-1', tests_run: 5, tests_passed: 2, tests_failed: 3, verdict: 'fail',
      issues: [{ description: 'Bug X', severity: 'high' }],
    },
  });

  // First scan with auto-create
  scanGaps({ workspaceRoot: ws, projectId: 'proj-idem', autoCreate: true });

  // Second scan — gap should not be detected since backlog item now exists
  const result2 = scanGaps({ workspaceRoot: ws, projectId: 'proj-idem', autoCreate: true });
  assert.strictEqual(result2.summary.auto_created_count, 0);
});

// =========================================================================
// Severity mapping
// =========================================================================
console.log('\n--- Severity ---');

test('gap severity matches source issue severity', () => {
  const ws = makeWorkspace('proj-sev');
  addRun(ws, '20260101_000000_T-1', 'proj-sev', {
    current_stage: 'done',
    qa: {
      ticket_id: 'T-1', tests_run: 5, tests_passed: 2, tests_failed: 3, verdict: 'fail',
      issues: [{ description: 'A', severity: 'critical' }, { description: 'B', severity: 'high' }],
    },
  });

  const result = scanGaps({ workspaceRoot: ws, projectId: 'proj-sev' });
  const bySev = result.summary.by_severity;
  assert.strictEqual(bySev.critical, 1);
  assert.strictEqual(bySev.high, 1);
});

// =========================================================================
// Read-only without auto_create
// =========================================================================
console.log('\n--- Read-only ---');

test('without autoCreate, no files are written', () => {
  const ws = makeWorkspace('proj-ro');
  addRun(ws, '20260101_000000_T-1', 'proj-ro', {
    current_stage: 'done',
    qa: {
      ticket_id: 'T-1', tests_run: 5, tests_passed: 2, tests_failed: 3, verdict: 'fail',
      issues: [{ description: 'Critical bug', severity: 'critical' }],
    },
  });

  const backlogDir = path.join(ws, '.claw', 'backlog');
  const beforeFiles = fs.readdirSync(backlogDir);

  const result = scanGaps({ workspaceRoot: ws, projectId: 'proj-ro' });
  assert.ok(result.gaps.length > 0);
  assert.strictEqual(result.summary.auto_created_count, 0);

  const afterFiles = fs.readdirSync(backlogDir);
  assert.strictEqual(beforeFiles.length, afterFiles.length, 'No files should be created in read-only mode');
});

// =========================================================================
// Schema validation with data
// =========================================================================
console.log('\n--- Schema validation ---');

test('full result validates against schema', () => {
  const ws = makeWorkspace('proj-sv');
  addRun(ws, '20260101_000000_T-1', 'proj-sv', {
    current_stage: 'done',
    qa: {
      ticket_id: 'T-1', tests_run: 5, tests_passed: 2, tests_failed: 3, verdict: 'fail',
      issues: [{ description: 'Bug', severity: 'high' }],
    },
    review: {
      ticket_id: 'T-1', stage_compliance: true, artifact_validation: true,
      verdict: 'changes_requested',
    },
    research: {
      ticket_id: 'T-1', hypotheses: [], methods: [], findings: [],
      conclusion: 'Partial', open_questions: ['Question 1'],
    },
  });

  const result = scanGaps({ workspaceRoot: ws, projectId: 'proj-sv' });
  const v = validateAgainstSchema(result, schema);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);
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
  assert.strictEqual(parsed.action, 'gaps_scanned');
});

// =========================================================================
// Summary
// =========================================================================
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
