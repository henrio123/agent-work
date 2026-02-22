#!/usr/bin/env node
'use strict';

/**
 * Tests for Phase 7 dashboard fields (Epic 7).
 *
 * Covers:
 *   - post_patch_tests_enabled field
 *   - auto_commit_enabled field
 *   - backlog_auto_completion_enabled field
 *   - agent_recommendation_enabled field
 *   - Schema validation of Phase 7 fields
 *
 * Run: node skills/dev-pipeline/tests/test-dashboard-phase7.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { buildDashboard } = require(path.resolve(__dirname, '..', 'scripts', 'project-dashboard.js'));
const dp = require(path.resolve(__dirname, '..', 'scripts', 'dev-pipeline.js'));

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

function makeTempWorkspace(name) {
  const dir = path.join(os.tmpdir(), `test-dash7-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const clawDir = path.join(dir, '.claw');
  fs.mkdirSync(path.join(clawDir, 'backlog'), { recursive: true });
  fs.mkdirSync(path.join(clawDir, 'runs'), { recursive: true });
  fs.mkdirSync(path.join(clawDir, 'task-packs'), { recursive: true });
  tmpDirs.push(dir);

  // Minimal project.json
  fs.writeFileSync(path.join(clawDir, 'project.json'), JSON.stringify({
    project_id: 'test-proj',
    title: 'Test Project',
    description: 'Phase 7 dashboard test',
  }, null, 2), 'utf8');

  return dir;
}

function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// ── Tests ──

test('dashboard includes Phase 7 feature flags', () => {
  const ws = makeTempWorkspace('flags');
  const result = buildDashboard({ workspaceRoot: ws });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(typeof result.summary.post_patch_tests_enabled, 'boolean');
  assert.strictEqual(typeof result.summary.auto_commit_enabled, 'boolean');
  assert.strictEqual(typeof result.summary.backlog_auto_completion_enabled, 'boolean');
  assert.strictEqual(typeof result.summary.agent_recommendation_enabled, 'boolean');
});

test('post_patch_tests_enabled is true when module exists', () => {
  const ws = makeTempWorkspace('ppv-true');
  const result = buildDashboard({ workspaceRoot: ws });
  // post-patch-verify.js exists in the codebase
  assert.strictEqual(result.summary.post_patch_tests_enabled, true);
});

test('auto_commit_enabled is true when module exists', () => {
  const ws = makeTempWorkspace('ac-true');
  const result = buildDashboard({ workspaceRoot: ws });
  // auto-commit.js exists in the codebase
  assert.strictEqual(result.summary.auto_commit_enabled, true);
});

test('backlog_auto_completion_enabled is true when module exists', () => {
  const ws = makeTempWorkspace('bac-true');
  const result = buildDashboard({ workspaceRoot: ws });
  // backlog-update-status.js exists in the codebase
  assert.strictEqual(result.summary.backlog_auto_completion_enabled, true);
});

test('agent_recommendation_enabled is true when module exists', () => {
  const ws = makeTempWorkspace('ar-true');
  const result = buildDashboard({ workspaceRoot: ws });
  // agent-performance.js exists in the codebase
  assert.strictEqual(result.summary.agent_recommendation_enabled, true);
});

test('Phase 7 fields pass schema validation', () => {
  const ws = makeTempWorkspace('schema');
  const result = buildDashboard({ workspaceRoot: ws });
  assert.strictEqual(result.ok, true);

  // Load and validate against schema
  const schemaPath = path.resolve(__dirname, '..', 'schemas', 'project-dashboard.output.schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

  // Check summary has all Phase 7 fields that schema requires
  const summarySchema = schema.properties.summary;
  const required = summarySchema.required || [];
  for (const field of ['post_patch_tests_enabled', 'auto_commit_enabled', 'backlog_auto_completion_enabled', 'agent_recommendation_enabled']) {
    assert.ok(field in result.summary, `summary missing field: ${field}`);
    // Validate types match schema
    const propSchema = summarySchema.properties[field];
    assert.ok(propSchema, `schema missing property definition for: ${field}`);
    assert.strictEqual(typeof result.summary[field], 'boolean', `${field} should be boolean`);
  }
});

// ── Cleanup ──
cleanup();

console.log('');
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
