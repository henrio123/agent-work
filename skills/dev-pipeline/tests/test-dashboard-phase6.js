#!/usr/bin/env node
'use strict';

/**
 * Tests for Phase 6 dashboard fields.
 *
 * Run: node skills/dev-pipeline/tests/test-dashboard-phase6.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { buildDashboard } = require(path.resolve(__dirname, '..', 'scripts', 'project-dashboard.js'));
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-p6-'));
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
// Phase 6 feature flags
// =========================================================================
console.log('\n--- Phase 6 feature flags ---');

test('template_enrichment_enabled is true (module exists)', () => {
  const ws = makeWorkspace('proj-p6-te');
  const result = buildDashboard({ workspaceRoot: ws });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.summary.template_enrichment_enabled, true);
});

test('artifact_context_enabled is true (module exists)', () => {
  const ws = makeWorkspace('proj-p6-ac');
  const result = buildDashboard({ workspaceRoot: ws });
  assert.strictEqual(result.summary.artifact_context_enabled, true);
});

test('retry_loop_enabled is true (module exists)', () => {
  const ws = makeWorkspace('proj-p6-rl');
  const result = buildDashboard({ workspaceRoot: ws });
  assert.strictEqual(result.summary.retry_loop_enabled, true);
});

test('auto_patch_enabled is true (module exists)', () => {
  const ws = makeWorkspace('proj-p6-ap');
  const result = buildDashboard({ workspaceRoot: ws });
  assert.strictEqual(result.summary.auto_patch_enabled, true);
});

test('dashboard output validates against updated schema', () => {
  const ws = makeWorkspace('proj-p6-schema');
  const result = buildDashboard({ workspaceRoot: ws });
  const validation = validateAgainstSchema(result, schema);
  assert.strictEqual(validation.ok, true, `Schema errors: ${JSON.stringify(validation.details || [])}`);
});

test('Phase 6 fields coexist with Phase 5 fields', () => {
  const ws = makeWorkspace('proj-p6-coexist');
  const result = buildDashboard({ workspaceRoot: ws });
  // Phase 5 fields
  assert.strictEqual(typeof result.summary.post_run_hooks_enabled, 'boolean');
  assert.ok(['available', 'unavailable'].includes(result.summary.adaptive_loop_status));
  // Phase 6 fields
  assert.strictEqual(typeof result.summary.template_enrichment_enabled, 'boolean');
  assert.strictEqual(typeof result.summary.artifact_context_enabled, 'boolean');
  assert.strictEqual(typeof result.summary.retry_loop_enabled, 'boolean');
  assert.strictEqual(typeof result.summary.auto_patch_enabled, 'boolean');
});

// =========================================================================
// Summary
// =========================================================================
console.log(`\n========================================`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`========================================`);

process.exit(failed > 0 ? 1 : 0);
