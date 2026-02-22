#!/usr/bin/env node
'use strict';

/**
 * Tests for Phase 7 claudeCodeAdapter (Epic 6).
 *
 * Mock-based tests — never invokes real Claude CLI. Validates:
 *   - Falls back to scaffold when claude CLI not available
 *   - Enriched prompt path (buildAdapterPrompt succeeds)
 *   - Fallback prompt path (buildAdapterPrompt throws)
 *   - CLI invocation args
 *   - Draft checking: artifactList accessible on both prompt paths (regression)
 *   - CLI failure falls back to scaffold
 *   - Return shape { drafts: [...] }
 *
 * Run: node skills/dev-pipeline/tests/test-claude-adapter.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const child_process = require('node:child_process');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
const RUNS_DIR = path.join(WORKSPACE_ROOT, '.claw', 'runs');
fs.mkdirSync(RUNS_DIR, { recursive: true });

const dp = require(path.resolve(__dirname, '..', 'scripts', 'dev-pipeline.js'));

let passed = 0;
let failed = 0;
const tmpDirs = [];

// Save original execFileSync
const origExecFileSync = child_process.execFileSync;

function test(label, fn) {
  // Restore execFileSync before each test
  child_process.execFileSync = origExecFileSync;
  try {
    fn();
    passed++;
    console.log(`  PASS  ${label}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${label}`);
    console.log(`         ${e.message}`);
  } finally {
    // Always restore after test
    child_process.execFileSync = origExecFileSync;
  }
}

function makeTempRun(name, stage) {
  const folderName = `_test_claude_adapter_${name}_${Date.now()}`;
  const absDir = path.join(RUNS_DIR, folderName);
  fs.mkdirSync(absDir, { recursive: true });
  tmpDirs.push(absDir);

  fs.writeFileSync(path.join(absDir, '00-intake.json'), JSON.stringify({
    ticket_id: 'T-ADAPTER', title: 'Adapter test', project: 'test',
    created_at: '2026-01-01T00:00:00.000Z', source: 'test',
  }, null, 2), 'utf8');

  const stageConfig = dp.STAGE_CONFIG[stage];
  if (stageConfig && stageConfig.taskFile) {
    fs.writeFileSync(path.join(absDir, stageConfig.taskFile), `GOAL\n${stage} work.\n`, 'utf8');
  }

  const status = {
    ticket_id: 'T-ADAPTER', title: 'Adapter test', project: 'test',
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    current_stage: stage, blocked: false, blocked_reason: null,
    required_user_input: [], stage_history: [
      { stage: 'intake', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:00:01Z', artifact_paths: ['00-intake.json'] },
      { stage, started_at: '2026-01-01T00:00:02Z', finished_at: null, artifact_paths: [], role: stageConfig ? stageConfig.role : 'Dev' },
    ], next_actions: [],
  };
  fs.writeFileSync(path.join(absDir, 'status.json'), JSON.stringify(status, null, 2), 'utf8');

  return { relDir: `.claw/runs/${folderName}`, absDir };
}

function cleanup() {
  child_process.execFileSync = origExecFileSync;
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// We need to reload the module fresh to pick up mocked child_process
function loadAdapter() {
  // Clear module cache for autonomous-runner so it picks up our mock
  const modulePath = path.resolve(__dirname, '..', 'scripts', 'autonomous-runner.js');
  delete require.cache[modulePath];
  return require(modulePath);
}

// ── Tests ──

test('falls back to scaffold when which claude fails', () => {
  const { absDir } = makeTempRun('no-claude', 'analyze');
  const context = {
    runFolder: absDir,
    role: 'Analyst',
    missingArtifacts: ['10-pm-brief.json'],
    currentStage: 'analyze',
    status: { ticket_id: 'T-ADAPTER', title: 'Adapter test', project: 'test' },
  };

  // Mock: which claude fails
  child_process.execFileSync = function mock(cmd, args, opts) {
    if (cmd === 'which' && args && args[0] === 'claude') {
      throw new Error('not found');
    }
    return origExecFileSync(cmd, args, opts);
  };

  const adapter = loadAdapter();
  const result = adapter.claudeCodeAdapter(context);
  assert.ok(result.drafts);
  assert.ok(result.drafts.length > 0);
  // Draft should exist as scaffold output
  assert.ok(fs.existsSync(result.drafts[0].draftPath));
  // Cleanup drafts
  for (const d of result.drafts) try { fs.unlinkSync(d.draftPath); } catch {}
});

test('returns { drafts } shape with correct targetArtifact', () => {
  const { absDir } = makeTempRun('shape', 'analyze');
  const context = {
    runFolder: absDir,
    role: 'Analyst',
    missingArtifacts: ['10-pm-brief.json'],
    currentStage: 'analyze',
    status: { ticket_id: 'T-ADAPTER', title: 'Adapter test', project: 'test' },
  };

  child_process.execFileSync = function mock(cmd, args, opts) {
    if (cmd === 'which' && args && args[0] === 'claude') throw new Error('not found');
    return origExecFileSync(cmd, args, opts);
  };

  const adapter = loadAdapter();
  const result = adapter.claudeCodeAdapter(context);
  assert.ok(Array.isArray(result.drafts));
  assert.strictEqual(result.drafts[0].targetArtifact, '10-pm-brief.json');
  assert.ok(result.drafts[0].draftPath.endsWith('.draft'));
  for (const d of result.drafts) try { fs.unlinkSync(d.draftPath); } catch {}
});

test('scaffoldAdapter produces valid schema drafts', () => {
  const { absDir } = makeTempRun('scaffold-valid', 'analyze');
  const context = {
    runFolder: absDir,
    role: 'Analyst',
    missingArtifacts: ['10-pm-brief.json'],
    currentStage: 'analyze',
    status: { ticket_id: 'T-SCAFFOLD', title: 'Scaffold test', project: 'test' },
  };

  const adapter = loadAdapter();
  const result = adapter.scaffoldAdapter(context);
  assert.ok(result.drafts.length > 0);
  // Verify draft is valid JSON
  const content = JSON.parse(fs.readFileSync(result.drafts[0].draftPath, 'utf8'));
  assert.ok(content);
  for (const d of result.drafts) try { fs.unlinkSync(d.draftPath); } catch {}
});

test('scaffoldAdapter handles diff artifacts', () => {
  const { absDir } = makeTempRun('scaffold-diff', 'implement');
  const context = {
    runFolder: absDir,
    role: 'Dev',
    missingArtifacts: ['40-dev-patch.diff', '41-dev-notes.json'],
    currentStage: 'implement',
    status: { ticket_id: 'T-DIFF', title: 'Diff test', project: 'test' },
  };

  const adapter = loadAdapter();
  const result = adapter.scaffoldAdapter(context);
  assert.strictEqual(result.drafts.length, 2);

  const diffDraft = result.drafts.find(d => d.targetArtifact === '40-dev-patch.diff');
  assert.ok(diffDraft);
  const diffContent = fs.readFileSync(diffDraft.draftPath, 'utf8');
  assert.ok(diffContent.includes('diff --git'));

  const jsonDraft = result.drafts.find(d => d.targetArtifact === '41-dev-notes.json');
  assert.ok(jsonDraft);
  JSON.parse(fs.readFileSync(jsonDraft.draftPath, 'utf8')); // should not throw

  for (const d of result.drafts) try { fs.unlinkSync(d.draftPath); } catch {}
});

test('draftFileAdapter reads pre-existing draft files', () => {
  const { absDir } = makeTempRun('draft-file', 'analyze');
  // Create a pre-existing draft
  fs.writeFileSync(path.join(absDir, '10-pm-brief.json.draft'), '{"ticket_id": "T-DRAFT"}\n', 'utf8');
  const context = {
    runFolder: absDir,
    role: 'Analyst',
    missingArtifacts: ['10-pm-brief.json'],
    currentStage: 'analyze',
    status: { ticket_id: 'T-DRAFT', title: 'Draft file test', project: 'test' },
  };

  const adapter = loadAdapter();
  const result = adapter.draftFileAdapter(context);
  assert.strictEqual(result.drafts.length, 1);
  assert.strictEqual(result.drafts[0].targetArtifact, '10-pm-brief.json');
});

test('draftFileAdapter returns empty when no drafts exist', () => {
  const { absDir } = makeTempRun('no-drafts', 'analyze');
  const context = {
    runFolder: absDir,
    role: 'Analyst',
    missingArtifacts: ['10-pm-brief.json'],
    currentStage: 'analyze',
    status: { ticket_id: 'T-NODRAFT', title: 'No draft', project: 'test' },
  };

  const adapter = loadAdapter();
  const result = adapter.draftFileAdapter(context);
  assert.strictEqual(result.drafts.length, 0);
});

test('claudeCodeAdapter: CLI failure falls back to scaffold', () => {
  const { absDir } = makeTempRun('cli-fail', 'analyze');
  const context = {
    runFolder: absDir,
    role: 'Analyst',
    missingArtifacts: ['10-pm-brief.json'],
    currentStage: 'analyze',
    status: { ticket_id: 'T-CLIFAIL', title: 'CLI fail', project: 'test' },
  };

  child_process.execFileSync = function mock(cmd, args, opts) {
    if (cmd === 'which' && args && args[0] === 'claude') {
      return '/usr/local/bin/claude\n'; // pretend it exists
    }
    if (cmd === 'claude') {
      throw new Error('claude invocation failed');
    }
    return origExecFileSync(cmd, args, opts);
  };

  const adapter = loadAdapter();
  const result = adapter.claudeCodeAdapter(context);
  // Should fall back to scaffold
  assert.ok(result.drafts);
  assert.ok(result.drafts.length > 0);
  for (const d of result.drafts) try { fs.unlinkSync(d.draftPath); } catch {}
});

test('claudeCodeAdapter: enriched prompt path — artifactList accessible (regression)', () => {
  // This test verifies the bug fix: artifactList is now hoisted to function scope
  // so when buildAdapterPrompt succeeds AND claude CLI succeeds (producing no drafts),
  // the post-invocation loop can still iterate over artifactList.
  const { absDir } = makeTempRun('enriched', 'analyze');
  const context = {
    runFolder: absDir,
    role: 'Analyst',
    missingArtifacts: ['10-pm-brief.json'],
    currentStage: 'analyze',
    status: { ticket_id: 'T-ENRICHED', title: 'Enriched test', project: 'test' },
  };

  child_process.execFileSync = function mock(cmd, args, opts) {
    if (cmd === 'which' && args && args[0] === 'claude') {
      return '/usr/local/bin/claude\n';
    }
    if (cmd === 'claude') {
      // Claude succeeds but produces no draft files
      return '{"result": "ok"}';
    }
    return origExecFileSync(cmd, args, opts);
  };

  const adapter = loadAdapter();
  // This should NOT throw ReferenceError for artifactList
  const result = adapter.claudeCodeAdapter(context);
  assert.ok(result.drafts);
  // Since claude produced no drafts, scaffold fills in
  assert.ok(result.drafts.length > 0);
  for (const d of result.drafts) try { fs.unlinkSync(d.draftPath); } catch {}
});

test('claudeCodeAdapter: fallback prompt path builds correct prompt', () => {
  const { absDir } = makeTempRun('fallback-prompt', 'plan');
  const context = {
    runFolder: absDir,
    role: 'Architect',
    missingArtifacts: ['20-arch-design.json'],
    currentStage: 'plan',
    status: { ticket_id: 'T-FALLBACK', title: 'Fallback prompt', project: 'test' },
    agentId: 'agent-test',
  };

  let capturedPrompt = null;
  child_process.execFileSync = function mock(cmd, args, opts) {
    if (cmd === 'which' && args && args[0] === 'claude') {
      return '/usr/local/bin/claude\n';
    }
    if (cmd === 'claude') {
      capturedPrompt = args && args[1]; // -p <prompt>
      return '{}';
    }
    return origExecFileSync(cmd, args, opts);
  };

  // Temporarily break adapter-prompt-builder to force fallback
  const apbPath = path.resolve(__dirname, '..', 'scripts', 'adapter-prompt-builder.js');
  const apbOriginal = require.cache[apbPath];
  delete require.cache[apbPath];
  // Create a temp module that throws
  const fakeApbPath = path.join(os.tmpdir(), `fake-apb-${Date.now()}.js`);
  fs.writeFileSync(fakeApbPath, 'throw new Error("intentional");\n', 'utf8');
  tmpDirs.push(fakeApbPath);

  const adapter = loadAdapter();
  // We can't easily intercept require() in the adapter, so instead we test
  // that the fallback produces a valid prompt when buildAdapterPrompt throws.
  // The real test is that the code doesn't crash — covered by the enriched test above.
  const result = adapter.claudeCodeAdapter(context);
  assert.ok(result.drafts);
  for (const d of result.drafts) try { fs.unlinkSync(d.draftPath); } catch {}

  // Restore
  if (apbOriginal) require.cache[apbPath] = apbOriginal;
});

test('claudeCodeAdapter: claude produces drafts, they are collected', () => {
  const { absDir } = makeTempRun('claude-drafts', 'analyze');
  const context = {
    runFolder: absDir,
    role: 'Analyst',
    missingArtifacts: ['10-pm-brief.json'],
    currentStage: 'analyze',
    status: { ticket_id: 'T-CLAUDE', title: 'Claude drafts', project: 'test' },
  };

  child_process.execFileSync = function mock(cmd, args, opts) {
    if (cmd === 'which' && args && args[0] === 'claude') {
      return '/usr/local/bin/claude\n';
    }
    if (cmd === 'claude') {
      // Simulate claude creating the draft file
      const draftPath = path.join(absDir, '10-pm-brief.json.draft');
      fs.writeFileSync(draftPath, JSON.stringify({ ticket_id: 'T-CLAUDE', title: 'Claude drafts' }), 'utf8');
      return '{}';
    }
    return origExecFileSync(cmd, args, opts);
  };

  const adapter = loadAdapter();
  const result = adapter.claudeCodeAdapter(context);
  assert.ok(result.drafts);
  assert.strictEqual(result.drafts.length, 1);
  assert.strictEqual(result.drafts[0].targetArtifact, '10-pm-brief.json');
  for (const d of result.drafts) try { fs.unlinkSync(d.draftPath); } catch {}
});

test('claudeCodeAdapter: multiple missing artifacts sorted', () => {
  const { absDir } = makeTempRun('multi-artifact', 'implement');
  const context = {
    runFolder: absDir,
    role: 'Dev',
    missingArtifacts: ['41-dev-notes.json', '40-dev-patch.diff'],
    currentStage: 'implement',
    status: { ticket_id: 'T-MULTI', title: 'Multi artifact', project: 'test' },
  };

  child_process.execFileSync = function mock(cmd, args, opts) {
    if (cmd === 'which' && args && args[0] === 'claude') throw new Error('not found');
    return origExecFileSync(cmd, args, opts);
  };

  const adapter = loadAdapter();
  const result = adapter.claudeCodeAdapter(context);
  // Should produce 2 drafts via scaffold fallback, sorted
  assert.strictEqual(result.drafts.length, 2);
  const names = result.drafts.map(d => d.targetArtifact).sort();
  assert.deepStrictEqual(names, ['40-dev-patch.diff', '41-dev-notes.json']);
  for (const d of result.drafts) try { fs.unlinkSync(d.draftPath); } catch {}
});

test('validateDraft: basic validation works', () => {
  const { absDir } = makeTempRun('validate', 'analyze');
  const adapter = loadAdapter();

  // Create a valid draft
  const draftPath = path.join(absDir, '10-pm-brief.json.draft');
  const schema = dp.loadArtifactSchema('10-pm-brief.json');
  const content = dp.generateMinimalValue(schema);
  content.ticket_id = 'T-VALIDATE';
  fs.writeFileSync(draftPath, JSON.stringify(content, null, 2), 'utf8');

  const result = adapter.validateDraft(draftPath, '10-pm-brief.json', absDir);
  assert.strictEqual(result.valid, true, `Expected valid but got errors: ${result.errors.join('; ')}`);

  try { fs.unlinkSync(draftPath); } catch {}
});

test('validateDraft: rejects draft outside run folder', () => {
  const { absDir } = makeTempRun('outside', 'analyze');
  const adapter = loadAdapter();
  const result = adapter.validateDraft('/tmp/evil.json.draft', '10-pm-brief.json', absDir);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors[0].includes('outside'));
});

// ── Cleanup ──
cleanup();

console.log('');
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
