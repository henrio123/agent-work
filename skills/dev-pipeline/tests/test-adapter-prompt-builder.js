#!/usr/bin/env node
'use strict';

/**
 * Tests for adapter-prompt-builder.js (Phase 6 — Epics 1 & 2).
 *
 * Covers:
 *   - buildAdapterPrompt: task file present/missing, agent identity, schema descriptions,
 *     adaptive context, truncation, template_used flag, backward compat
 *   - buildArtifactContext: correct deps per stage, JSON/diff read, per-artifact truncation,
 *     total budget, missing artifacts silently skipped, unknown stage returns empty,
 *     artifacts_included list, prompt includes artifact sections
 *   - buildRetryPrompt: format, truncation, error list
 *
 * Run: node skills/dev-pipeline/tests/test-adapter-prompt-builder.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  buildAdapterPrompt,
  buildArtifactContext,
  buildRetryPrompt,
  STAGE_ARTIFACT_DEPS,
} = require(path.resolve(__dirname, '..', 'scripts', 'adapter-prompt-builder.js'));

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

function makeTempRunFolder(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `apb-${name}-`));
  tmpDirs.push(dir);

  // Create basic status/intake
  fs.writeFileSync(path.join(dir, '00-intake.json'), JSON.stringify({
    ticket_id: 'T-01', title: 'Test', project: 'test-proj',
    created_at: '2026-01-01T00:00:00Z', source: 'test',
  }, null, 2), 'utf8');

  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
    ticket_id: 'T-01', title: 'Test', project: 'test-proj',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    current_stage: 'analyze', blocked: false, blocked_reason: null,
    required_user_input: [], stage_history: [], next_actions: [],
  }, null, 2), 'utf8');

  return dir;
}

function makeContext(runFolder, overrides = {}) {
  return {
    runFolder,
    role: 'Analyst',
    missingArtifacts: ['10-pm-brief.json'],
    currentStage: 'analyze',
    status: {
      ticket_id: 'T-01', title: 'Test', project: 'test-proj',
      current_stage: 'analyze',
    },
    agentId: null,
    ...overrides,
  };
}

function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
process.on('exit', cleanup);

// =========================================================================
// STAGE_ARTIFACT_DEPS constant
// =========================================================================
console.log('\n--- STAGE_ARTIFACT_DEPS ---');

test('STAGE_ARTIFACT_DEPS has entries for all 5 stages', () => {
  assert.ok(STAGE_ARTIFACT_DEPS.analyze);
  assert.ok(STAGE_ARTIFACT_DEPS.plan);
  assert.ok(STAGE_ARTIFACT_DEPS.implement);
  assert.ok(STAGE_ARTIFACT_DEPS.validate);
  assert.ok(STAGE_ARTIFACT_DEPS.review);
});

test('analyze depends on 00-intake.json', () => {
  assert.deepStrictEqual(STAGE_ARTIFACT_DEPS.analyze, ['00-intake.json']);
});

test('implement depends on arch-design and pm-brief', () => {
  assert.deepStrictEqual(STAGE_ARTIFACT_DEPS.implement, ['20-arch-design.json', '10-pm-brief.json']);
});

// =========================================================================
// buildArtifactContext
// =========================================================================
console.log('\n--- buildArtifactContext ---');

test('returns empty for unknown stage', () => {
  const dir = makeTempRunFolder('unk');
  const result = buildArtifactContext(dir, 'unknown-stage');
  assert.strictEqual(result.text, '');
  assert.deepStrictEqual(result.artifacts_included, []);
  assert.strictEqual(result.total_chars, 0);
  assert.strictEqual(result.truncated, false);
});

test('reads JSON artifact for analyze stage', () => {
  const dir = makeTempRunFolder('json');
  const result = buildArtifactContext(dir, 'analyze');
  assert.ok(result.artifacts_included.includes('00-intake.json'));
  assert.ok(result.text.includes('Prior Artifact: 00-intake.json'));
  assert.ok(result.text.includes('T-01'));
});

test('reads diff artifact for validate stage', () => {
  const dir = makeTempRunFolder('diff');
  // Write required artifacts
  fs.writeFileSync(path.join(dir, '10-pm-brief.json'), '{"ticket_id":"T-01"}', 'utf8');
  fs.writeFileSync(path.join(dir, '20-arch-design.json'), '{"ticket_id":"T-01"}', 'utf8');
  fs.writeFileSync(path.join(dir, '40-dev-patch.diff'), 'diff --git a/f b/f\n+line\n', 'utf8');
  fs.writeFileSync(path.join(dir, '41-dev-notes.json'), '{"ticket_id":"T-01"}', 'utf8');

  const result = buildArtifactContext(dir, 'validate');
  assert.ok(result.artifacts_included.includes('40-dev-patch.diff'));
  assert.ok(result.text.includes('diff --git'));
});

test('missing artifacts are silently skipped', () => {
  const dir = makeTempRunFolder('miss');
  // plan needs 10-pm-brief.json and 00-intake.json; 10-pm-brief.json is missing
  const result = buildArtifactContext(dir, 'plan');
  assert.ok(result.artifacts_included.includes('00-intake.json'));
  assert.ok(!result.artifacts_included.includes('10-pm-brief.json'));
});

test('per-artifact truncation works', () => {
  const dir = makeTempRunFolder('trunc');
  const bigContent = JSON.stringify({ ticket_id: 'T-01', data: 'x'.repeat(5000) });
  fs.writeFileSync(path.join(dir, '00-intake.json'), bigContent, 'utf8');

  const result = buildArtifactContext(dir, 'analyze', { maxPerArtifactChars: 100 });
  assert.ok(result.text.includes('[truncated]'));
  assert.ok(result.text.length < 500);
});

test('total budget stops adding artifacts', () => {
  const dir = makeTempRunFolder('budget');
  fs.writeFileSync(path.join(dir, '10-pm-brief.json'), JSON.stringify({ ticket_id: 'T-01', data: 'x'.repeat(200) }), 'utf8');
  // 00-intake.json already exists from makeTempRunFolder

  const result = buildArtifactContext(dir, 'plan', { maxTotalChars: 100 });
  // Should have stopped after first artifact exceeded budget
  assert.ok(result.artifacts_included.length <= 1);
  assert.strictEqual(result.truncated, true);
});

// =========================================================================
// buildAdapterPrompt
// =========================================================================
console.log('\n--- buildAdapterPrompt ---');

test('prompt includes agent identity without agentId', () => {
  const dir = makeTempRunFolder('no-agent');
  const ctx = makeContext(dir);
  const result = buildAdapterPrompt(ctx);
  assert.ok(result.prompt.includes('You are a Analyst agent'));
  assert.ok(result.prompt.includes('T-01'));
});

test('prompt includes agent identity with agentId', () => {
  const dir = makeTempRunFolder('with-agent');
  const ctx = makeContext(dir, { agentId: 'agent-42' });
  const result = buildAdapterPrompt(ctx);
  assert.ok(result.prompt.includes('You are agent agent-42'));
});

test('template_used is false when no task file', () => {
  const dir = makeTempRunFolder('no-template');
  const ctx = makeContext(dir);
  const result = buildAdapterPrompt(ctx);
  assert.strictEqual(result.template_used, false);
});

test('template_used is true when task file exists', () => {
  const dir = makeTempRunFolder('has-template');
  // Write a task file matching STAGE_CONFIG.analyze.taskFile = '31-analyze-task.txt'
  fs.writeFileSync(path.join(dir, '31-analyze-task.txt'), 'GOAL\nDo analysis.\nSTEPS\n1. Read intake.\n', 'utf8');
  const ctx = makeContext(dir);
  const result = buildAdapterPrompt(ctx);
  assert.strictEqual(result.template_used, true);
  assert.ok(result.prompt.includes('GOAL'));
  assert.ok(result.prompt.includes('Do analysis'));
});

test('prompt includes schema descriptions', () => {
  const dir = makeTempRunFolder('schema');
  const ctx = makeContext(dir);
  const result = buildAdapterPrompt(ctx);
  assert.ok(result.prompt.includes('10-pm-brief.json'));
  assert.ok(result.prompt.includes('required fields'));
});

test('prompt includes prior artifact context', () => {
  const dir = makeTempRunFolder('art-ctx');
  // 00-intake.json already written by makeTempRunFolder
  const ctx = makeContext(dir);
  const result = buildAdapterPrompt(ctx);
  assert.ok(result.artifact_context_length > 0);
  assert.ok(result.prompt.includes('Prior Artifacts'));
});

test('prompt truncation enforces maxPromptChars', () => {
  const dir = makeTempRunFolder('max-chars');
  fs.writeFileSync(path.join(dir, '31-analyze-task.txt'), 'X'.repeat(40000), 'utf8');
  const ctx = makeContext(dir);
  const result = buildAdapterPrompt(ctx, { maxPromptChars: 5000 });
  assert.ok(result.prompt.length <= 5000);
  assert.ok(result.prompt.includes('[prompt truncated]'));
});

test('backward compat: prompt always includes Requirements section', () => {
  const dir = makeTempRunFolder('compat');
  const ctx = makeContext(dir);
  const result = buildAdapterPrompt(ctx);
  assert.ok(result.prompt.includes('Requirements:'));
  assert.ok(result.prompt.includes('Each JSON artifact must be valid'));
});

test('prompt includes project and stage info', () => {
  const dir = makeTempRunFolder('info');
  const ctx = makeContext(dir);
  const result = buildAdapterPrompt(ctx);
  assert.ok(result.prompt.includes('Project: test-proj'));
  assert.ok(result.prompt.includes('Current stage: analyze'));
});

// =========================================================================
// buildRetryPrompt
// =========================================================================
console.log('\n--- buildRetryPrompt ---');

test('retry prompt includes retry count', () => {
  const result = buildRetryPrompt({
    draftContent: '{"bad": true}',
    validationErrors: ['$.ticket_id: required field missing'],
    retryNum: 1,
    maxRetries: 2,
    artifactName: '10-pm-brief.json',
  });
  assert.ok(result.prompt.includes('RETRY 1/2'));
  assert.ok(result.prompt.includes('10-pm-brief.json'));
});

test('retry prompt includes errors', () => {
  const result = buildRetryPrompt({
    draftContent: '{}',
    validationErrors: ['error-one', 'error-two'],
    retryNum: 1,
    maxRetries: 2,
    artifactName: 'x.json',
  });
  assert.ok(result.prompt.includes('- error-one'));
  assert.ok(result.prompt.includes('- error-two'));
});

test('retry prompt truncates long draft content', () => {
  const result = buildRetryPrompt({
    draftContent: 'x'.repeat(5000),
    validationErrors: ['e1'],
    retryNum: 1,
    maxRetries: 1,
    artifactName: 'y.json',
  });
  assert.ok(result.prompt.includes('[truncated]'));
  assert.ok(result.prompt.length < 5000);
});

test('retry prompt handles empty draft', () => {
  const result = buildRetryPrompt({
    draftContent: '',
    validationErrors: ['empty'],
    retryNum: 1,
    maxRetries: 1,
    artifactName: 'z.json',
  });
  assert.ok(result.prompt.includes('VALIDATION FAILED'));
});

// =========================================================================
// Summary
// =========================================================================
console.log(`\n========================================`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`========================================`);

process.exit(failed > 0 ? 1 : 0);
