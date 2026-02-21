#!/usr/bin/env node
'use strict';

/**
 * Tests for artifact-index.js — global artifact index scanner.
 * Run: node skills/dev-pipeline/tests/test-artifact-index.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { buildArtifactIndex } = require('../scripts/artifact-index.js');
const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));

const OUTPUT_SCHEMA = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'artifact-index.output.schema.json'), 'utf8')
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'art-idx-'));
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

function makeWorkspace() {
  const ws = fs.mkdtempSync(path.join(TMP, 'ws-'));
  fs.mkdirSync(path.join(ws, '.claw', 'runs'), { recursive: true });
  return ws;
}

function addRun(ws, runName, project, artifacts) {
  const runDir = path.join(ws, '.claw', 'runs', runName);
  fs.mkdirSync(runDir, { recursive: true });
  // Write status.json with project
  fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify({
    ticket_id: runName.split('_').pop(),
    title: 'test',
    project: project,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    current_stage: 'done',
    blocked: false,
    blocked_reason: null,
    responsible_agent: null,
    required_user_input: [],
    stage_history: [],
    next_actions: [],
  }), 'utf8');
  // Write artifact files
  for (const [name, content] of Object.entries(artifacts || {})) {
    fs.writeFileSync(path.join(runDir, name), content, 'utf8');
  }
}

// =========================================================================
// Empty / missing workspace
// =========================================================================
console.log('\n--- Empty workspace ---');

test('workspace with no runs returns empty artifacts', () => {
  const ws = makeWorkspace();
  const r = buildArtifactIndex({ workspaceRoot: ws });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.artifacts, []);
  assert.strictEqual(r.summary.total_artifacts, 0);
  assert.strictEqual(r.summary.runs_scanned, 0);
});

test('workspace without .claw/runs/ returns empty', () => {
  const ws = fs.mkdtempSync(path.join(TMP, 'no-runs-'));
  const r = buildArtifactIndex({ workspaceRoot: ws });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.artifacts, []);
});

test('empty output validates against schema', () => {
  const ws = makeWorkspace();
  const r = buildArtifactIndex({ workspaceRoot: ws });
  const v = validateAgainstSchema(r, OUTPUT_SCHEMA);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);
});

// =========================================================================
// Single run scanning
// =========================================================================
console.log('\n--- Single run scanning ---');

test('scans a run with core artifacts', () => {
  const ws = makeWorkspace();
  addRun(ws, '20260101_000000_T1', 'proj-a', {
    '10-pm-brief.json': '{}',
    '20-arch-design.json': '{}',
    '40-dev-patch.diff': 'diff',
    '41-dev-notes.json': '{}',
    '50-qa-report.json': '{}',
    '60-review-report.json': '{}',
  });

  const r = buildArtifactIndex({ workspaceRoot: ws });
  assert.strictEqual(r.summary.runs_scanned, 1);
  // 6 artifacts + status.json (metadata) = 7
  assert.ok(r.summary.total_artifacts >= 7);
  assert.ok(r.summary.by_type['analysis'] >= 1);
  assert.ok(r.summary.by_type['design'] >= 1);
  assert.ok(r.summary.by_type['implementation'] >= 2);
  assert.ok(r.summary.by_type['test-result'] >= 1);
  assert.ok(r.summary.by_type['review-verdict'] >= 1);
});

test('run_id is populated from folder name', () => {
  const ws = makeWorkspace();
  addRun(ws, '20260101_000000_T1', 'proj-a', { '10-pm-brief.json': '{}' });

  const r = buildArtifactIndex({ workspaceRoot: ws });
  const brief = r.artifacts.find(a => a.artifact_file === '10-pm-brief.json');
  assert.strictEqual(brief.run_id, '20260101_000000_T1');
});

test('project_id comes from status.json', () => {
  const ws = makeWorkspace();
  addRun(ws, '20260101_000000_T1', 'my-project', { '10-pm-brief.json': '{}' });

  const r = buildArtifactIndex({ workspaceRoot: ws });
  const brief = r.artifacts.find(a => a.artifact_file === '10-pm-brief.json');
  assert.strictEqual(brief.project_id, 'my-project');
});

test('project_id defaults to "unknown" when status.json missing', () => {
  const ws = makeWorkspace();
  const runDir = path.join(ws, '.claw', 'runs', '20260101_000000_T2');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, '10-pm-brief.json'), '{}');

  const r = buildArtifactIndex({ workspaceRoot: ws });
  const brief = r.artifacts.find(a => a.artifact_file === '10-pm-brief.json');
  assert.strictEqual(brief.project_id, 'unknown');
});

test('output validates against schema', () => {
  const ws = makeWorkspace();
  addRun(ws, '20260101_000000_T1', 'proj-a', {
    '10-pm-brief.json': '{}',
    '50-qa-report.json': '{}',
  });

  const r = buildArtifactIndex({ workspaceRoot: ws });
  const v = validateAgainstSchema(r, OUTPUT_SCHEMA);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);
});

// =========================================================================
// Multiple runs
// =========================================================================
console.log('\n--- Multiple runs ---');

test('scans multiple runs across projects', () => {
  const ws = makeWorkspace();
  addRun(ws, '20260101_000000_T1', 'proj-a', { '10-pm-brief.json': '{}' });
  addRun(ws, '20260102_000000_T2', 'proj-b', { '20-arch-design.json': '{}' });

  const r = buildArtifactIndex({ workspaceRoot: ws });
  assert.strictEqual(r.summary.runs_scanned, 2);
  assert.ok(r.summary.by_project['proj-a'] >= 1);
  assert.ok(r.summary.by_project['proj-b'] >= 1);
});

test('artifacts sorted by run_id then semantic_type then artifact_file', () => {
  const ws = makeWorkspace();
  addRun(ws, '20260102_000000_T2', 'proj-a', { '10-pm-brief.json': '{}' });
  addRun(ws, '20260101_000000_T1', 'proj-a', { '50-qa-report.json': '{}', '10-pm-brief.json': '{}' });

  const r = buildArtifactIndex({ workspaceRoot: ws });
  // Filter to just the role artifacts for clarity
  const role = r.artifacts.filter(a => ['analysis', 'test-result'].includes(a.semantic_type));
  // Run T1 should come before T2 (alpha sort)
  const firstRun = role[0].run_id;
  assert.strictEqual(firstRun, '20260101_000000_T1');
});

// =========================================================================
// Filtering
// =========================================================================
console.log('\n--- Filtering ---');

test('filterType returns only matching semantic_type', () => {
  const ws = makeWorkspace();
  addRun(ws, '20260101_000000_T1', 'proj-a', {
    '10-pm-brief.json': '{}',
    '50-qa-report.json': '{}',
    '60-review-report.json': '{}',
  });

  const r = buildArtifactIndex({ workspaceRoot: ws, filterType: 'analysis' });
  assert.ok(r.artifacts.length > 0);
  assert.ok(r.artifacts.every(a => a.semantic_type === 'analysis'));
});

test('filterProject returns only matching project_id', () => {
  const ws = makeWorkspace();
  addRun(ws, '20260101_000000_T1', 'proj-a', { '10-pm-brief.json': '{}' });
  addRun(ws, '20260102_000000_T2', 'proj-b', { '10-pm-brief.json': '{}' });

  const r = buildArtifactIndex({ workspaceRoot: ws, filterProject: 'proj-b' });
  assert.ok(r.artifacts.length > 0);
  assert.ok(r.artifacts.every(a => a.project_id === 'proj-b'));
});

test('filterStage returns only matching stage', () => {
  const ws = makeWorkspace();
  addRun(ws, '20260101_000000_T1', 'proj-a', {
    '10-pm-brief.json': '{}',
    '50-qa-report.json': '{}',
  });

  const r = buildArtifactIndex({ workspaceRoot: ws, filterStage: 'validate' });
  assert.ok(r.artifacts.length > 0);
  assert.ok(r.artifacts.every(a => a.stage === 'validate'));
});

test('multiple filters combine (AND)', () => {
  const ws = makeWorkspace();
  addRun(ws, '20260101_000000_T1', 'proj-a', { '10-pm-brief.json': '{}', '50-qa-report.json': '{}' });
  addRun(ws, '20260102_000000_T2', 'proj-b', { '10-pm-brief.json': '{}' });

  const r = buildArtifactIndex({ workspaceRoot: ws, filterType: 'analysis', filterProject: 'proj-a' });
  assert.ok(r.artifacts.length > 0);
  assert.ok(r.artifacts.every(a => a.semantic_type === 'analysis' && a.project_id === 'proj-a'));
});

test('filter with no matches returns empty', () => {
  const ws = makeWorkspace();
  addRun(ws, '20260101_000000_T1', 'proj-a', { '10-pm-brief.json': '{}' });

  const r = buildArtifactIndex({ workspaceRoot: ws, filterType: 'audit' });
  assert.deepStrictEqual(r.artifacts, []);
  assert.strictEqual(r.summary.total_artifacts, 0);
});

// =========================================================================
// Capability artifacts
// =========================================================================
console.log('\n--- Capability artifacts ---');

test('capability artifacts (15-19 range) classified as audit', () => {
  const ws = makeWorkspace();
  addRun(ws, '20260101_000000_T1', 'proj-a', {
    '15-ux-audit.json': '{}',
    '16-security-audit.json': '{}',
  });

  const r = buildArtifactIndex({ workspaceRoot: ws, filterType: 'audit' });
  assert.strictEqual(r.artifacts.length, 2);
});

// =========================================================================
// Read-only safety
// =========================================================================
console.log('\n--- Read-only safety ---');

test('does not create any files', () => {
  const ws = makeWorkspace();
  addRun(ws, '20260101_000000_T1', 'proj-a', { '10-pm-brief.json': '{}' });

  // Snapshot .claw contents before
  const before = JSON.stringify(fs.readdirSync(path.join(ws, '.claw', 'runs', '20260101_000000_T1')).sort());

  buildArtifactIndex({ workspaceRoot: ws });

  // After should be identical
  const after = JSON.stringify(fs.readdirSync(path.join(ws, '.claw', 'runs', '20260101_000000_T1')).sort());
  assert.strictEqual(before, after);
});

// =========================================================================
// Determinism
// =========================================================================
console.log('\n--- Determinism ---');

test('same workspace produces same artifacts (excluding generated_at)', () => {
  const ws = makeWorkspace();
  addRun(ws, '20260101_000000_T1', 'proj-a', { '10-pm-brief.json': '{}', '50-qa-report.json': '{}' });

  const r1 = buildArtifactIndex({ workspaceRoot: ws });
  const r2 = buildArtifactIndex({ workspaceRoot: ws });

  // Artifacts arrays should be identical
  assert.deepStrictEqual(r1.artifacts, r2.artifacts);
  assert.deepStrictEqual(r1.summary, r2.summary);
});

// =========================================================================
// Summary
// =========================================================================
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
