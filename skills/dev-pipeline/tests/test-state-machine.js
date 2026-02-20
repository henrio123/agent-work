#!/usr/bin/env node
'use strict';

/**
 * State machine regression tests for dev-pipeline orchestration.
 * Run: node skills/dev-pipeline/tests/test-state-machine.js
 *
 * Tests use in-memory status objects and the exported pure functions.
 * No run folders are created or modified.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  TOOL_VERSION, STAGE_CONFIG, ARTIFACT_SCHEMA_MAP,
  getNextStageInfo, normalizeStatus, validateSchema,
} = require('../scripts/dev-pipeline.js');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');

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

// Helper: create a minimal status at a given stage
function makeStatus(stage, opts = {}) {
  return normalizeStatus({
    ticket_id: 'TEST-1',
    title: 'Test ticket',
    project: 'test',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    current_stage: stage,
    blocked: opts.blocked || false,
    blocked_reason: opts.blocked_reason || null,
    required_user_input: opts.required_user_input || [],
    stage_history: opts.stage_history || [{ stage, started_at: '2026-01-01T00:00:00.000Z', finished_at: null, artifact_paths: [] }],
    next_actions: [],
  });
}

// We need a temporary run folder with real artifacts to test getNextStageInfo
// against the filesystem. Create it in /tmp to avoid polluting runs/.
const TMP_RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-test-'));
const cleanup = () => { try { fs.rmSync(TMP_RUN, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

// Write minimal artifacts for gate testing
function writeArtifact(name, content) {
  fs.writeFileSync(path.join(TMP_RUN, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
}

// -------------------------------------------------------------------------
// Test group 1: STAGE_CONFIG structure
// -------------------------------------------------------------------------
console.log('\n--- STAGE_CONFIG structure ---');

test('STAGE_CONFIG has all 6 role stages', () => {
  const expected = ['pm-ready', 'ux-ready', 'arch-ready', 'dev-ready', 'qa-ready', 'review'];
  for (const stage of expected) {
    assert.ok(STAGE_CONFIG[stage], `missing ${stage}`);
  }
});

test('Each stage has role, requiredArtifacts, taskFile, template, next', () => {
  for (const [stage, config] of Object.entries(STAGE_CONFIG)) {
    assert.ok(config.role, `${stage} missing role`);
    assert.ok(Array.isArray(config.requiredArtifacts), `${stage} missing requiredArtifacts`);
    assert.ok(config.taskFile, `${stage} missing taskFile`);
    assert.ok(config.template, `${stage} missing template`);
    assert.ok(config.next, `${stage} missing next`);
  }
});

test('Stage chain is linear: pm-ready → ux-ready → arch-ready → dev-ready → qa-ready → review → done', () => {
  let stage = 'pm-ready';
  const visited = [];
  while (stage !== 'done') {
    visited.push(stage);
    const config = STAGE_CONFIG[stage];
    assert.ok(config, `no config for ${stage}`);
    stage = config.next;
  }
  assert.deepStrictEqual(visited, ['pm-ready', 'ux-ready', 'arch-ready', 'dev-ready', 'qa-ready', 'review']);
});

// -------------------------------------------------------------------------
// Test group 2: getNextStageInfo — correct computation for each stage
// -------------------------------------------------------------------------
console.log('\n--- getNextStageInfo computation ---');

test('done → next_stage is null', () => {
  const status = makeStatus('done');
  const info = getNextStageInfo(TMP_RUN, status);
  assert.strictEqual(info.next_stage, null);
});

test('blocked → next_stage is null, blocked true', () => {
  const status = makeStatus('blocked', { blocked: true });
  const info = getNextStageInfo(TMP_RUN, status);
  assert.strictEqual(info.next_stage, null);
  assert.strictEqual(info.blocked, true);
});

test('intake → next is task-pack-generated', () => {
  const status = makeStatus('intake');
  const info = getNextStageInfo(TMP_RUN, status);
  assert.strictEqual(info.next_stage, 'task-pack-generated');
  assert.strictEqual(info.action, 'generate_task_pack');
});

test('task-pack-generated → next is pm-ready', () => {
  const status = makeStatus('task-pack-generated');
  const info = getNextStageInfo(TMP_RUN, status);
  assert.strictEqual(info.next_stage, 'pm-ready');
  assert.strictEqual(info.role, 'PM');
});

test('pm-ready without artifacts → gates_pass false, missing artifacts', () => {
  const status = makeStatus('pm-ready');
  const info = getNextStageInfo(TMP_RUN, status);
  assert.strictEqual(info.gates_pass, false);
  assert.ok(info.missing_artifacts.includes('10-pm-brief.json'));
});

test('pm-ready with valid artifact → gates_pass true, next ux-ready', () => {
  writeArtifact('10-pm-brief.json', {
    ticket_id: 'TEST-1', title: 't', project: 'p',
    problem_statement: 'x', scope: 'y', acceptance_criteria: [],
  });
  const status = makeStatus('pm-ready');
  const info = getNextStageInfo(TMP_RUN, status);
  assert.strictEqual(info.gates_pass, true);
  assert.strictEqual(info.next_stage, 'ux-ready');
});

test('arch-ready without artifact → gates_pass false', () => {
  const status = makeStatus('arch-ready');
  const info = getNextStageInfo(TMP_RUN, status);
  assert.strictEqual(info.gates_pass, false);
});

test('arch-ready with valid artifact → gates_pass true, next dev-ready', () => {
  writeArtifact('20-arch-design.json', {
    ticket_id: 'TEST-1', approach: 'a', components: [], file_changes: [],
  });
  const status = makeStatus('arch-ready');
  const info = getNextStageInfo(TMP_RUN, status);
  assert.strictEqual(info.gates_pass, true);
  assert.strictEqual(info.next_stage, 'dev-ready');
});

test('dev-ready needs both diff and notes', () => {
  const status = makeStatus('dev-ready');
  const info = getNextStageInfo(TMP_RUN, status);
  assert.strictEqual(info.gates_pass, false);
  assert.ok(info.missing_artifacts.length > 0);
});

test('dev-ready with both artifacts → gates_pass true', () => {
  writeArtifact('40-dev-patch.diff', 'diff --git a/foo b/foo\n+bar\n');
  writeArtifact('41-dev-notes.json', { ticket_id: 'TEST-1', files_changed: [], summary: 's' });
  const status = makeStatus('dev-ready');
  const info = getNextStageInfo(TMP_RUN, status);
  assert.strictEqual(info.gates_pass, true);
  assert.strictEqual(info.next_stage, 'qa-ready');
});

test('qa-ready with valid report → gates_pass true', () => {
  writeArtifact('50-qa-report.json', {
    ticket_id: 'TEST-1', tests_run: 1, tests_passed: 1, tests_failed: 0, verdict: 'pass',
  });
  const status = makeStatus('qa-ready');
  const info = getNextStageInfo(TMP_RUN, status);
  assert.strictEqual(info.gates_pass, true);
  assert.strictEqual(info.next_stage, 'review');
});

test('review with valid report → gates_pass true, next done', () => {
  writeArtifact('60-review-report.json', {
    ticket_id: 'TEST-1', stage_compliance: true, artifact_validation: true, verdict: 'approved',
  });
  const status = makeStatus('review');
  const info = getNextStageInfo(TMP_RUN, status);
  assert.strictEqual(info.gates_pass, true);
  assert.strictEqual(info.next_stage, 'done');
});

// -------------------------------------------------------------------------
// Test group 3: Idempotency — calling getNextStageInfo twice gives same result
// -------------------------------------------------------------------------
console.log('\n--- Idempotency ---');

test('getNextStageInfo is idempotent (pm-ready, gates pass)', () => {
  const status = makeStatus('pm-ready');
  const a = getNextStageInfo(TMP_RUN, status);
  const b = getNextStageInfo(TMP_RUN, status);
  assert.deepStrictEqual(a, b);
});

test('getNextStageInfo is idempotent (dev-ready, gates fail)', () => {
  // Remove diff to make gates fail
  try { fs.unlinkSync(path.join(TMP_RUN, '40-dev-patch.diff')); } catch {}
  const status = makeStatus('dev-ready');
  const a = getNextStageInfo(TMP_RUN, status);
  const b = getNextStageInfo(TMP_RUN, status);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.gates_pass, false);
  // Restore for later tests
  writeArtifact('40-dev-patch.diff', 'diff --git a/foo b/foo\n+bar\n');
});

// -------------------------------------------------------------------------
// Test group 4: Advance refusal when artifacts missing
// -------------------------------------------------------------------------
console.log('\n--- Advance refusal ---');

test('advance gate check: arch-ready fails without 20-arch-design.json removed', () => {
  const saved = path.join(TMP_RUN, '20-arch-design.json');
  const backup = fs.readFileSync(saved, 'utf8');
  fs.unlinkSync(saved);
  const status = makeStatus('arch-ready');
  const info = getNextStageInfo(TMP_RUN, status);
  assert.strictEqual(info.gates_pass, false);
  assert.ok(info.missing_artifacts.includes('20-arch-design.json'));
  // Restore
  fs.writeFileSync(saved, backup, 'utf8');
});

test('invalid JSON artifact fails validation', () => {
  const badPath = path.join(TMP_RUN, '50-qa-report.json');
  const backup = fs.readFileSync(badPath, 'utf8');
  fs.writeFileSync(badPath, '{ not valid json }}}', 'utf8');
  const status = makeStatus('qa-ready');
  const info = getNextStageInfo(TMP_RUN, status);
  assert.strictEqual(info.gates_pass, false);
  assert.ok(info.invalid_artifacts.length > 0);
  // Restore
  fs.writeFileSync(badPath, backup, 'utf8');
});

test('empty diff artifact fails validation', () => {
  const diffPath = path.join(TMP_RUN, '40-dev-patch.diff');
  const backup = fs.readFileSync(diffPath, 'utf8');
  fs.writeFileSync(diffPath, '', 'utf8');
  const status = makeStatus('dev-ready');
  const info = getNextStageInfo(TMP_RUN, status);
  assert.strictEqual(info.gates_pass, false);
  // Restore
  fs.writeFileSync(diffPath, backup, 'utf8');
});

// -------------------------------------------------------------------------
// Test group 5: generate_role_pack never advances stage
// -------------------------------------------------------------------------
console.log('\n--- generate_role_pack no-advance guarantee ---');

test('STAGE_CONFIG stages are separate from transition stages', () => {
  // The key guarantee: generate_role_pack reads status.current_stage
  // and generates a task file for that stage only. It looks up
  // STAGE_CONFIG[current_stage] which only matches role stages.
  // Stages like intake, task-pack-generated, done, blocked are NOT in STAGE_CONFIG.
  assert.strictEqual(STAGE_CONFIG['intake'], undefined);
  assert.strictEqual(STAGE_CONFIG['task-pack-generated'], undefined);
  assert.strictEqual(STAGE_CONFIG['done'], undefined);
  assert.strictEqual(STAGE_CONFIG['blocked'], undefined);
});

test('generate_role_pack cannot access non-role stages', () => {
  // This verifies the invariant that cmdGenerateRolePack uses:
  //   const config = STAGE_CONFIG[status.current_stage];
  //   if (!config) fail(...)
  // So for non-role stages, it always fails before doing anything.
  for (const nonRole of ['intake', 'task-pack-generated', 'done', 'blocked']) {
    assert.strictEqual(STAGE_CONFIG[nonRole], undefined,
      `${nonRole} should NOT be in STAGE_CONFIG`);
  }
});

// -------------------------------------------------------------------------
// Test group 6: normalizeStatus migration
// -------------------------------------------------------------------------
console.log('\n--- normalizeStatus migration ---');

test('project_name migrates to project', () => {
  const s = normalizeStatus({ project_name: 'old', current_stage: 'intake' });
  assert.strictEqual(s.project, 'old');
  assert.strictEqual(s.project_name, undefined);
});

test('status field migrates to current_stage', () => {
  const s = normalizeStatus({ status: 'review' });
  assert.strictEqual(s.current_stage, 'review');
  assert.strictEqual(s.status, undefined);
});

test('string required_user_input migrates to objects', () => {
  const s = normalizeStatus({ current_stage: 'intake', required_user_input: ['question?'] });
  assert.strictEqual(s.required_user_input.length, 1);
  assert.strictEqual(s.required_user_input[0].prompt, 'question?');
  assert.strictEqual(s.required_user_input[0].status, 'pending');
  assert.ok(s.required_user_input[0].id);
});

test('missing arrays default to empty', () => {
  const s = normalizeStatus({ current_stage: 'intake' });
  assert.ok(Array.isArray(s.stage_history));
  assert.ok(Array.isArray(s.next_actions));
  assert.ok(Array.isArray(s.required_user_input));
});

test('blocked defaults to false', () => {
  const s = normalizeStatus({ current_stage: 'intake' });
  assert.strictEqual(s.blocked, false);
  assert.strictEqual(s.blocked_reason, null);
});

// -------------------------------------------------------------------------
// Test group 7: TOOL_VERSION
// -------------------------------------------------------------------------
console.log('\n--- Version ---');

test('TOOL_VERSION is a valid semver', () => {
  assert.ok(/^\d+\.\d+\.\d+$/.test(TOOL_VERSION), `${TOOL_VERSION} not semver`);
});

// -------------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------------
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
