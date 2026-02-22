#!/usr/bin/env node
'use strict';

/**
 * Tests for Phase 6 validation retry loop (Epic 3).
 *
 * Covers:
 *   - Adapter that fails then succeeds on retry
 *   - maxRetries=0 disables retry
 *   - Audit log has retry events
 *   - retries_attempted count in result
 *   - All retries fail → still writes valid drafts
 *
 * Run: node skills/dev-pipeline/tests/test-validation-retry.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
const RUNS_DIR = path.join(WORKSPACE_ROOT, '.claw', 'runs');
fs.mkdirSync(RUNS_DIR, { recursive: true });

const { runAutonomous, AUDIT_FILENAME } = require(path.resolve(__dirname, '..', 'scripts', 'autonomous-runner.js'));
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

function makeTempRun(name, statusOverrides = {}) {
  const folderName = `_test_retry_${name}_${Date.now()}`;
  const absDir = path.join(RUNS_DIR, folderName);
  fs.mkdirSync(absDir, { recursive: true });
  tmpDirs.push(absDir);

  fs.writeFileSync(path.join(absDir, '00-intake.json'), JSON.stringify({
    ticket_id: 'T-RETRY', title: 'Test retry', project: 'test',
    created_at: '2026-01-01T00:00:00.000Z', source: 'test',
  }, null, 2), 'utf8');

  fs.writeFileSync(path.join(absDir, '31-analyze-task.txt'), 'GOAL\nAnalyze.\n', 'utf8');

  const status = {
    ticket_id: 'T-RETRY', title: 'Test retry', project: 'test',
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    current_stage: 'analyze', blocked: false, blocked_reason: null,
    required_user_input: [], stage_history: [
      { stage: 'intake', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:00:01Z', artifact_paths: ['00-intake.json'] },
      { stage: 'analyze', started_at: '2026-01-01T00:00:02Z', finished_at: null, artifact_paths: [], role: 'Analyst' },
    ], next_actions: [],
    ...statusOverrides,
  };
  fs.writeFileSync(path.join(absDir, 'status.json'), JSON.stringify(status, null, 2), 'utf8');

  return { relDir: `.claw/runs/${folderName}`, absDir };
}

function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
process.on('exit', cleanup);

/**
 * Build a "fail-then-succeed" adapter. First call produces invalid JSON,
 * second call produces valid schema-conformant JSON.
 */
function makeFailThenSucceedAdapter(failCount = 1) {
  let callNum = 0;
  return function failThenSucceedAdapter(context) {
    callNum++;
    const drafts = [];

    for (const artifact of context.missingArtifacts.sort()) {
      const draftPath = path.join(context.runFolder, artifact + '.draft');

      if (artifact.endsWith('.diff')) {
        fs.writeFileSync(draftPath, 'diff --git a/p b/p\n--- a/p\n+++ b/p\n@@ -0,0 +1 @@\n+ok\n', 'utf8');
        drafts.push({ draftPath, targetArtifact: artifact });
        continue;
      }

      if (callNum <= failCount) {
        // Write invalid JSON (missing required fields)
        fs.writeFileSync(draftPath, JSON.stringify({ bad: true }) + '\n', 'utf8');
      } else {
        // Write valid schema-conformant JSON
        const schema = dp.loadArtifactSchema(artifact);
        let content;
        if (schema) {
          content = dp.generateMinimalValue(schema);
          if (content && typeof content === 'object') {
            content.ticket_id = context.status.ticket_id;
            if (schema.properties && schema.properties.title) content.title = context.status.title;
          }
        } else {
          content = { ticket_id: context.status.ticket_id };
        }
        fs.writeFileSync(draftPath, JSON.stringify(content, null, 2) + '\n', 'utf8');
      }
      drafts.push({ draftPath, targetArtifact: artifact });
    }

    return { drafts };
  };
}

/** Always produces invalid drafts */
function makeAlwaysFailAdapter() {
  return function alwaysFailAdapter(context) {
    const drafts = [];
    for (const artifact of context.missingArtifacts.sort()) {
      const draftPath = path.join(context.runFolder, artifact + '.draft');
      fs.writeFileSync(draftPath, '{ invalid', 'utf8');
      drafts.push({ draftPath, targetArtifact: artifact });
    }
    return { drafts };
  };
}

// =========================================================================
// Retry loop tests
// =========================================================================
console.log('\n--- Validation retry loop ---');

test('adapter that fails then succeeds produces valid artifacts after retry', () => {
  const { absDir } = makeTempRun('fail-then-ok');
  const result = runAutonomous(absDir, {
    agentAdapter: makeFailThenSucceedAdapter(1),
    maxSteps: 10,
    maxRetries: 2,
    progress: false,
  });
  assert.ok(result.artifacts_written.includes('10-pm-brief.json'), `Expected 10-pm-brief.json in artifacts_written, got: ${result.artifacts_written}`);
  assert.ok(result.retries_attempted >= 1, `Expected retries_attempted >= 1, got: ${result.retries_attempted}`);
});

test('maxRetries=0 disables retry (retries_attempted stays 0)', () => {
  const { absDir } = makeTempRun('no-retry');
  const result = runAutonomous(absDir, {
    agentAdapter: makeAlwaysFailAdapter(),
    maxSteps: 5,
    maxRetries: 0,
    progress: false,
  });
  assert.strictEqual(result.retries_attempted, 0, 'Should have 0 retries when maxRetries=0');
  assert.ok(!result.artifacts_written.includes('10-pm-brief.json'), 'Should not write invalid artifact');
});

test('all retries fail still returns error result gracefully', () => {
  const { absDir } = makeTempRun('all-fail');
  const result = runAutonomous(absDir, {
    agentAdapter: makeAlwaysFailAdapter(),
    maxSteps: 5,
    maxRetries: 2,
    progress: false,
  });
  // Should still produce a result (not crash)
  assert.strictEqual(result.action, 'autonomous_complete');
  assert.ok(result.retries_attempted >= 1);
  assert.ok(!result.artifacts_written.includes('10-pm-brief.json'));
});

test('retries_attempted is 0 when drafts are valid on first try', () => {
  const { absDir } = makeTempRun('no-fail');
  const result = runAutonomous(absDir, {
    agentAdapter: makeFailThenSucceedAdapter(0), // never fails
    maxSteps: 10,
    maxRetries: 2,
    progress: false,
  });
  assert.strictEqual(result.retries_attempted, 0);
  assert.ok(result.artifacts_written.includes('10-pm-brief.json'));
});

test('audit log contains retry_start events', () => {
  const { absDir } = makeTempRun('audit-retry');
  runAutonomous(absDir, {
    agentAdapter: makeFailThenSucceedAdapter(1),
    maxSteps: 10,
    maxRetries: 2,
    auditLog: true,
    progress: false,
  });

  const auditPath = path.join(absDir, AUDIT_FILENAME);
  assert.ok(fs.existsSync(auditPath), 'audit log should exist');
  const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n');
  const retryEvents = lines.map(l => JSON.parse(l)).filter(e => e.event === 'retry_start');
  assert.ok(retryEvents.length >= 1, `Expected retry_start events, got ${retryEvents.length}`);
});

test('trace includes retry messages', () => {
  const { absDir } = makeTempRun('trace-retry');
  const result = runAutonomous(absDir, {
    agentAdapter: makeFailThenSucceedAdapter(1),
    maxSteps: 10,
    maxRetries: 2,
    progress: false,
  });
  const retryTraces = result.trace.filter(t => t.includes('retry'));
  assert.ok(retryTraces.length >= 1, `Expected retry trace messages, got: ${retryTraces}`);
});

test('retries count toward agent_calls', () => {
  const { absDir } = makeTempRun('agent-calls');
  const result = runAutonomous(absDir, {
    agentAdapter: makeFailThenSucceedAdapter(1),
    maxSteps: 10,
    maxRetries: 2,
    progress: false,
  });
  // First call + retry = at least 2 agent calls for that stage
  assert.ok(result.agent_calls >= 2, `Expected agent_calls >= 2, got: ${result.agent_calls}`);
});

// =========================================================================
// Summary
// =========================================================================
console.log(`\n========================================`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`========================================`);

process.exit(failed > 0 ? 1 : 0);
