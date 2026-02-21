#!/usr/bin/env node
'use strict';

/**
 * Tests for dashboard knowledge state (Epic 5b).
 *
 * Validates that project-dashboard.js includes knowledge_state per project
 * and knowledge_summary in the top-level summary, sourced from artifact index
 * and agent memory.
 *
 * Run: node skills/dev-pipeline/tests/test-dashboard-knowledge.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { buildDashboard } = require(path.resolve(__dirname, '..', 'scripts', 'project-dashboard.js'));
const { writeMemory } = require(path.resolve(__dirname, '..', 'scripts', 'agent-memory.js'));
const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));

const dashboardSchema = JSON.parse(
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-knowledge-'));
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

function makeWorkspace(projectId, backlogItems) {
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
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }), 'utf8');

  for (const item of (backlogItems || [])) {
    const defaults = {
      project_id: projectId, type: 'task', title: `Task ${item.id}`,
      description: 'test', created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z', status: 'todo',
      priority: 'P2', owner_role: 'DEV', depends_on: [], run_folder: null,
      tags: [], artifacts_expected: [], last_summary: null, ...item,
    };
    fs.writeFileSync(
      path.join(clawDir, 'backlog', `${defaults.id}.json`),
      JSON.stringify(defaults), 'utf8'
    );
  }

  return ws;
}

function addRun(ws, runName, project, artifacts) {
  const runDir = path.join(ws, '.claw', 'runs', runName);
  fs.mkdirSync(runDir, { recursive: true });
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

  for (const [name, content] of Object.entries(artifacts || {})) {
    fs.writeFileSync(path.join(runDir, name), content, 'utf8');
  }
}

// =========================================================================
// No knowledge (empty state)
// =========================================================================
console.log('\n--- No knowledge ---');

test('dashboard with no runs has zero knowledge_state counts', () => {
  const ws = makeWorkspace('proj-empty', [{ id: 'T-1' }]);
  const result = buildDashboard({ workspaceRoot: ws });

  assert.strictEqual(result.ok, true);
  const ks = result.projects[0].knowledge_state;
  assert.ok(ks, 'knowledge_state should be present');
  assert.strictEqual(ks.total_artifacts, 0);
  assert.strictEqual(ks.research_findings_count, 0);
  assert.strictEqual(ks.memory_entry_count, 0);
  assert.deepStrictEqual(ks.artifact_counts_by_type, {});
});

test('empty knowledge_state validates against schema', () => {
  const ws = makeWorkspace('proj-val', [{ id: 'T-1' }]);
  const result = buildDashboard({ workspaceRoot: ws });

  const v = validateAgainstSchema(result, dashboardSchema);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);
});

test('knowledge_summary present with zero counts', () => {
  const ws = makeWorkspace('proj-summ', [{ id: 'T-1' }]);
  const result = buildDashboard({ workspaceRoot: ws });

  const ks = result.summary.knowledge_summary;
  assert.ok(ks, 'knowledge_summary should be present');
  assert.strictEqual(ks.total_artifacts, 0);
  assert.strictEqual(ks.total_research_findings, 0);
  assert.strictEqual(ks.total_memory_entries, 0);
  assert.deepStrictEqual(ks.artifact_counts_by_type, {});
});

// =========================================================================
// Artifacts
// =========================================================================
console.log('\n--- With artifacts ---');

test('counts artifacts by semantic type', () => {
  const ws = makeWorkspace('proj-art', [{ id: 'T-1' }]);
  addRun(ws, '20260101_000000_T-A', 'proj-art', {
    '10-pm-brief.json': '{}',
    '20-arch-design.json': '{}',
    '50-qa-report.json': '{}',
  });

  const result = buildDashboard({ workspaceRoot: ws });
  const ks = result.projects[0].knowledge_state;

  assert.strictEqual(ks.total_artifacts, 4); // 3 artifacts + status.json
  assert.ok(ks.artifact_counts_by_type.analysis >= 1, 'should count analysis artifacts');
  assert.ok(ks.artifact_counts_by_type.design >= 1, 'should count design artifacts');
});

test('ignores artifacts from other projects', () => {
  const ws = makeWorkspace('proj-mine', [{ id: 'T-1' }]);
  addRun(ws, '20260101_000000_T-OTHER', 'other-proj', {
    '10-pm-brief.json': '{}',
    '50-qa-report.json': '{}',
  });

  const result = buildDashboard({ workspaceRoot: ws });
  const ks = result.projects[0].knowledge_state;
  assert.strictEqual(ks.total_artifacts, 0);
});

// =========================================================================
// Research findings
// =========================================================================
console.log('\n--- Research findings ---');

test('counts research findings files', () => {
  const ws = makeWorkspace('proj-res', [{ id: 'T-1' }]);
  addRun(ws, '20260101_000000_T-R1', 'proj-res', {
    '18-research-findings.json': JSON.stringify({
      ticket_id: 'T-R1', hypotheses: [], methods: [], findings: [],
      conclusion: 'Test', open_questions: [],
    }),
  });
  addRun(ws, '20260102_000000_T-R2', 'proj-res', {
    '18-research-findings.json': JSON.stringify({
      ticket_id: 'T-R2', hypotheses: [], methods: [], findings: [],
      conclusion: 'Test 2', open_questions: [],
    }),
  });

  const result = buildDashboard({ workspaceRoot: ws });
  const ks = result.projects[0].knowledge_state;
  assert.strictEqual(ks.research_findings_count, 2);
});

test('ignores research findings from other projects', () => {
  const ws = makeWorkspace('proj-nores', [{ id: 'T-1' }]);
  addRun(ws, '20260101_000000_T-R1', 'other-proj', {
    '18-research-findings.json': JSON.stringify({
      ticket_id: 'T-R1', hypotheses: [], methods: [], findings: [],
      conclusion: 'Test', open_questions: [],
    }),
  });

  const result = buildDashboard({ workspaceRoot: ws });
  const ks = result.projects[0].knowledge_state;
  assert.strictEqual(ks.research_findings_count, 0);
});

// =========================================================================
// Agent memory
// =========================================================================
console.log('\n--- Agent memory ---');

test('counts agent memory entries for project', () => {
  const ws = makeWorkspace('proj-mem', [{ id: 'T-1' }]);

  writeMemory({
    workspaceRoot: ws,
    agentId: 'agent-1',
    runId: 'run-1',
    projectId: 'proj-mem',
    stage: 'analyze',
    type: 'observation',
    content: 'First observation',
    tags: [],
  });
  writeMemory({
    workspaceRoot: ws,
    agentId: 'agent-1',
    runId: 'run-1',
    projectId: 'proj-mem',
    stage: 'plan',
    type: 'lesson',
    content: 'A lesson learned',
    tags: [],
  });
  writeMemory({
    workspaceRoot: ws,
    agentId: 'agent-2',
    runId: 'run-2',
    projectId: 'proj-mem',
    stage: 'implement',
    type: 'warning',
    content: 'Watch out for X',
    tags: [],
  });

  const result = buildDashboard({ workspaceRoot: ws });
  const ks = result.projects[0].knowledge_state;
  assert.strictEqual(ks.memory_entry_count, 3);
});

test('ignores agent memory from other projects', () => {
  const ws = makeWorkspace('proj-nomem', [{ id: 'T-1' }]);

  writeMemory({
    workspaceRoot: ws,
    agentId: 'agent-1',
    runId: 'run-x',
    projectId: 'other-project',
    stage: 'analyze',
    type: 'observation',
    content: 'From another project',
    tags: [],
  });

  const result = buildDashboard({ workspaceRoot: ws });
  const ks = result.projects[0].knowledge_state;
  assert.strictEqual(ks.memory_entry_count, 0);
});

// =========================================================================
// Knowledge summary aggregation
// =========================================================================
console.log('\n--- Knowledge summary ---');

test('knowledge_summary aggregates from per-project knowledge_state', () => {
  const ws = makeWorkspace('proj-agg', [{ id: 'T-1' }]);
  addRun(ws, '20260101_000000_T-A', 'proj-agg', {
    '10-pm-brief.json': '{}',
    '18-research-findings.json': JSON.stringify({
      ticket_id: 'T-A', hypotheses: [], methods: [], findings: [],
      conclusion: 'Test', open_questions: [],
    }),
  });

  writeMemory({
    workspaceRoot: ws,
    agentId: 'agent-1',
    runId: 'run-1',
    projectId: 'proj-agg',
    stage: 'analyze',
    type: 'observation',
    content: 'Test observation',
    tags: [],
  });

  const result = buildDashboard({ workspaceRoot: ws });
  const ks = result.summary.knowledge_summary;

  assert.ok(ks.total_artifacts > 0, 'should have artifacts');
  assert.strictEqual(ks.total_research_findings, 1);
  assert.strictEqual(ks.total_memory_entries, 1);
  assert.ok(Object.keys(ks.artifact_counts_by_type).length > 0, 'should have type counts');
});

// =========================================================================
// Schema validation with populated knowledge
// =========================================================================
console.log('\n--- Schema validation ---');

test('full dashboard with knowledge validates against schema', () => {
  const ws = makeWorkspace('proj-full', [{ id: 'T-1' }]);
  addRun(ws, '20260101_000000_T-A', 'proj-full', {
    '10-pm-brief.json': '{}',
    '20-arch-design.json': '{}',
    '18-research-findings.json': JSON.stringify({
      ticket_id: 'T-A', hypotheses: [], methods: [], findings: [],
      conclusion: 'Test', open_questions: [],
    }),
  });

  writeMemory({
    workspaceRoot: ws,
    agentId: 'agent-1',
    runId: 'run-1',
    projectId: 'proj-full',
    stage: 'analyze',
    type: 'observation',
    content: 'Full test observation',
    tags: [],
  });

  const result = buildDashboard({ workspaceRoot: ws });
  const v = validateAgainstSchema(result, dashboardSchema);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);
});

// =========================================================================
// Backward compat
// =========================================================================
console.log('\n--- Backward compat ---');

test('empty workspace (no project.json) still validates', () => {
  const ws = fs.mkdtempSync(path.join(TMP, 'ws-empty-'));
  const result = buildDashboard({ workspaceRoot: ws });
  const v = validateAgainstSchema(result, dashboardSchema);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);
});

// =========================================================================
// Summary
// =========================================================================
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
