#!/usr/bin/env node
'use strict';

/**
 * Tests for artifact-classify.js — deterministic artifact classification.
 * Run: node skills/dev-pipeline/tests/test-artifact-classify.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { classifyArtifact, classifyRunArtifacts, getSemanticTypes } = require('../scripts/artifact-classify.js');

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-'));
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

// =========================================================================
// getSemanticTypes
// =========================================================================
console.log('\n--- getSemanticTypes ---');

test('returns all 8 semantic types', () => {
  const types = getSemanticTypes();
  assert.strictEqual(types.length, 8);
  assert.deepStrictEqual(types, [
    'analysis', 'audit', 'design', 'implementation',
    'metadata', 'review-verdict', 'task', 'test-result',
  ]);
});

test('types are sorted alphabetically', () => {
  const types = getSemanticTypes();
  const sorted = [...types].sort();
  assert.deepStrictEqual(types, sorted);
});

// =========================================================================
// Core artifact classification
// =========================================================================
console.log('\n--- Core artifact classification ---');

test('10-pm-brief.json → analysis', () => {
  const r = classifyArtifact('10-pm-brief.json');
  assert.strictEqual(r.semantic_type, 'analysis');
  assert.strictEqual(r.stage, 'analyze');
  assert.strictEqual(r.schema_file, 'pm-brief.schema.json');
  assert.strictEqual(r.capability, null);
});

test('20-arch-design.json → design', () => {
  const r = classifyArtifact('20-arch-design.json');
  assert.strictEqual(r.semantic_type, 'design');
  assert.strictEqual(r.stage, 'plan');
  assert.strictEqual(r.schema_file, 'arch-design.schema.json');
});

test('40-dev-patch.diff → implementation', () => {
  const r = classifyArtifact('40-dev-patch.diff');
  assert.strictEqual(r.semantic_type, 'implementation');
  assert.strictEqual(r.stage, 'implement');
  assert.strictEqual(r.schema_file, null);
});

test('41-dev-notes.json → implementation', () => {
  const r = classifyArtifact('41-dev-notes.json');
  assert.strictEqual(r.semantic_type, 'implementation');
  assert.strictEqual(r.stage, 'implement');
  assert.strictEqual(r.schema_file, 'dev-notes.schema.json');
});

test('50-qa-report.json → test-result', () => {
  const r = classifyArtifact('50-qa-report.json');
  assert.strictEqual(r.semantic_type, 'test-result');
  assert.strictEqual(r.stage, 'validate');
  assert.strictEqual(r.schema_file, 'qa-report.schema.json');
});

test('60-review-report.json → review-verdict', () => {
  const r = classifyArtifact('60-review-report.json');
  assert.strictEqual(r.semantic_type, 'review-verdict');
  assert.strictEqual(r.stage, 'review');
  assert.strictEqual(r.schema_file, 'review-report.schema.json');
});

// =========================================================================
// Metadata artifacts
// =========================================================================
console.log('\n--- Metadata artifacts ---');

test('00-intake.json → metadata', () => {
  const r = classifyArtifact('00-intake.json');
  assert.strictEqual(r.semantic_type, 'metadata');
  assert.strictEqual(r.stage, 'intake');
});

test('run-manifest.json → metadata', () => {
  const r = classifyArtifact('run-manifest.json');
  assert.strictEqual(r.semantic_type, 'metadata');
  assert.strictEqual(r.stage, 'intake');
});

test('status.json → metadata', () => {
  const r = classifyArtifact('status.json');
  assert.strictEqual(r.semantic_type, 'metadata');
  assert.strictEqual(r.stage, null);
});

// =========================================================================
// Task files
// =========================================================================
console.log('\n--- Task files ---');

test('31-analyze-task.txt → task', () => {
  const r = classifyArtifact('31-analyze-task.txt');
  assert.strictEqual(r.semantic_type, 'task');
  assert.strictEqual(r.stage, null);
});

test('33-implement-task.txt → task', () => {
  const r = classifyArtifact('33-implement-task.txt');
  assert.strictEqual(r.semantic_type, 'task');
});

test('36-ux-audit-task.txt → task', () => {
  const r = classifyArtifact('36-ux-audit-task.txt');
  assert.strictEqual(r.semantic_type, 'task');
});

test('30-dev-claude-task.txt → task', () => {
  const r = classifyArtifact('30-dev-claude-task.txt');
  assert.strictEqual(r.semantic_type, 'task');
});

// =========================================================================
// Capability artifacts
// =========================================================================
console.log('\n--- Capability artifacts ---');

test('15-ux-audit.json → audit (no context)', () => {
  const r = classifyArtifact('15-ux-audit.json');
  assert.strictEqual(r.semantic_type, 'audit');
  assert.strictEqual(r.stage, null);
  assert.strictEqual(r.schema_file, null);
  assert.strictEqual(r.capability, null);
});

test('16-security-audit.json → audit (no context)', () => {
  const r = classifyArtifact('16-security-audit.json');
  assert.strictEqual(r.semantic_type, 'audit');
});

test('17-performance-audit.json → audit (no context)', () => {
  const r = classifyArtifact('17-performance-audit.json');
  assert.strictEqual(r.semantic_type, 'audit');
});

test('15-ux-audit.json with capability context enriches stage and schema', () => {
  const ctx = {
    artifactSchemaMap: { '15-ux-audit.json': 'ux-audit.schema.json' },
    stageConfig: {
      'analyze': { requiredArtifacts: ['10-pm-brief.json'], next: 'ux-audit' },
      'ux-audit': { requiredArtifacts: ['15-ux-audit.json'], next: 'plan' },
      'plan': { requiredArtifacts: ['20-arch-design.json'], next: 'implement' },
    },
  };
  const r = classifyArtifact('15-ux-audit.json', ctx);
  assert.strictEqual(r.semantic_type, 'audit');
  assert.strictEqual(r.stage, 'ux-audit');
  assert.strictEqual(r.schema_file, 'ux-audit.schema.json');
});

test('16-security-audit.json with capability context enriches stage', () => {
  const ctx = {
    artifactSchemaMap: { '16-security-audit.json': 'security-audit.schema.json' },
    stageConfig: {
      'security-audit': { requiredArtifacts: ['16-security-audit.json'], next: 'plan' },
    },
  };
  const r = classifyArtifact('16-security-audit.json', ctx);
  assert.strictEqual(r.stage, 'security-audit');
  assert.strictEqual(r.schema_file, 'security-audit.schema.json');
});

// =========================================================================
// Unknown / unrecognized files
// =========================================================================
console.log('\n--- Unknown files ---');

test('random.txt → null', () => {
  assert.strictEqual(classifyArtifact('random.txt'), null);
});

test('README.md → null', () => {
  assert.strictEqual(classifyArtifact('README.md'), null);
});

test('.stop → null', () => {
  assert.strictEqual(classifyArtifact('.stop'), null);
});

test('autonomous-audit.jsonl → null', () => {
  assert.strictEqual(classifyArtifact('autonomous-audit.jsonl'), null);
});

test('70-unknown.json → null (outside capability range)', () => {
  assert.strictEqual(classifyArtifact('70-unknown.json'), null);
});

// =========================================================================
// classifyRunArtifacts
// =========================================================================
console.log('\n--- classifyRunArtifacts ---');

test('empty directory returns empty array', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'empty-'));
  const r = classifyRunArtifacts(dir);
  assert.deepStrictEqual(r, []);
});

test('nonexistent directory returns empty array', () => {
  const r = classifyRunArtifacts(path.join(TMP, 'nope'));
  assert.deepStrictEqual(r, []);
});

test('classifies all files in a run folder', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'run-'));
  fs.writeFileSync(path.join(dir, 'status.json'), '{}');
  fs.writeFileSync(path.join(dir, '00-intake.json'), '{}');
  fs.writeFileSync(path.join(dir, '10-pm-brief.json'), '{"x":1}');
  fs.writeFileSync(path.join(dir, '20-arch-design.json'), '{}');
  fs.writeFileSync(path.join(dir, '40-dev-patch.diff'), 'diff');
  fs.writeFileSync(path.join(dir, '41-dev-notes.json'), '{}');
  fs.writeFileSync(path.join(dir, '50-qa-report.json'), '{}');
  fs.writeFileSync(path.join(dir, '60-review-report.json'), '{}');
  fs.writeFileSync(path.join(dir, '31-analyze-task.txt'), 'task');
  fs.writeFileSync(path.join(dir, '.stop'), '');
  fs.writeFileSync(path.join(dir, 'random.log'), 'noise');

  const results = classifyRunArtifacts(dir);

  // Should classify 9 files (not .stop or random.log)
  assert.strictEqual(results.length, 9);

  // Check types present
  const types = [...new Set(results.map(r => r.semantic_type))];
  assert.ok(types.includes('analysis'));
  assert.ok(types.includes('design'));
  assert.ok(types.includes('implementation'));
  assert.ok(types.includes('test-result'));
  assert.ok(types.includes('review-verdict'));
  assert.ok(types.includes('metadata'));
  assert.ok(types.includes('task'));
});

test('results are sorted by semantic_type then artifact_file', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'sort-'));
  fs.writeFileSync(path.join(dir, '60-review-report.json'), '{}');
  fs.writeFileSync(path.join(dir, '10-pm-brief.json'), '{}');
  fs.writeFileSync(path.join(dir, '00-intake.json'), '{}');

  const results = classifyRunArtifacts(dir);
  assert.strictEqual(results[0].semantic_type, 'analysis');
  assert.strictEqual(results[1].semantic_type, 'metadata');
  assert.strictEqual(results[2].semantic_type, 'review-verdict');
});

test('size_bytes is populated', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'size-'));
  fs.writeFileSync(path.join(dir, '10-pm-brief.json'), '{"hello":"world"}');

  const results = classifyRunArtifacts(dir);
  assert.strictEqual(results.length, 1);
  assert.ok(results[0].size_bytes > 0);
});

test('capability artifacts classified in run folder', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'cap-'));
  fs.writeFileSync(path.join(dir, '15-ux-audit.json'), '{}');
  fs.writeFileSync(path.join(dir, '16-security-audit.json'), '{}');

  const results = classifyRunArtifacts(dir);
  assert.strictEqual(results.length, 2);
  assert.ok(results.every(r => r.semantic_type === 'audit'));
});

test('capability context enriches run folder classification', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'ctx-'));
  fs.writeFileSync(path.join(dir, '15-ux-audit.json'), '{}');

  const ctx = {
    artifactSchemaMap: { '15-ux-audit.json': 'ux-audit.schema.json' },
    stageConfig: {
      'ux-audit': { requiredArtifacts: ['15-ux-audit.json'], next: 'plan' },
    },
  };

  const results = classifyRunArtifacts(dir, ctx);
  assert.strictEqual(results[0].stage, 'ux-audit');
  assert.strictEqual(results[0].schema_file, 'ux-audit.schema.json');
});

// =========================================================================
// Schema validation
// =========================================================================
console.log('\n--- Schema validation ---');

test('classification output matches artifact-classification.schema.json structure', () => {
  const schemaPath = path.resolve(__dirname, '..', 'schemas', 'artifact-classification.schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

  // Verify all semantic_type values from classifier are in schema enum
  const types = getSemanticTypes();
  const enumValues = schema.properties.semantic_type.enum;
  assert.deepStrictEqual(types, enumValues);
});

test('classifyArtifact output has all required schema fields (except run/project/created_at)', () => {
  const r = classifyArtifact('10-pm-brief.json');
  assert.ok('semantic_type' in r);
  assert.ok('stage' in r);
  assert.ok('schema_file' in r);
  assert.ok('capability' in r);
});

// =========================================================================
// Edge cases
// =========================================================================
console.log('\n--- Edge cases ---');

test('path with directory prefix strips to basename', () => {
  const r = classifyArtifact('/some/path/to/10-pm-brief.json');
  assert.strictEqual(r.semantic_type, 'analysis');
});

test('18-future-audit.json → audit (within capability range)', () => {
  const r = classifyArtifact('18-future-audit.json');
  assert.strictEqual(r.semantic_type, 'audit');
});

test('19-something.json → audit (edge of capability range)', () => {
  const r = classifyArtifact('19-something.json');
  assert.strictEqual(r.semantic_type, 'audit');
});

test('14-not-capability.json → null (below capability range)', () => {
  assert.strictEqual(classifyArtifact('14-not-capability.json'), null);
});

// =========================================================================
// Summary
// =========================================================================
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
