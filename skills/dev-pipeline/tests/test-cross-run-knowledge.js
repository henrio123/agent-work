#!/usr/bin/env node
'use strict';

/**
 * Tests for cross-run knowledge retention in task packs.
 *
 * Validates that task-pack-generate.js populates prior_knowledge from:
 *   1. Artifact index (same-project artifacts from prior runs)
 *   2. Agent memory (observations/lessons from prior runs)
 *   3. Research findings (18-research-findings.json from prior runs)
 *
 * Run: node skills/dev-pipeline/tests/test-cross-run-knowledge.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { generateTaskPack, gatherPriorKnowledge } = require('../scripts/task-pack-generate.js');
const { writeMemory } = require('../scripts/agent-memory.js');
const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));

const taskPackSchema = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'task-pack.schema.json'), 'utf8')
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-run-'));
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

function makeWorkspace(projectId, backlogItems) {
  const ws = fs.mkdtempSync(path.join(TMP, 'ws-'));
  const clawDir = path.join(ws, '.claw');
  fs.mkdirSync(path.join(clawDir, 'backlog'), { recursive: true });
  fs.mkdirSync(path.join(clawDir, 'task-packs'), { recursive: true });
  fs.mkdirSync(path.join(clawDir, 'runs'), { recursive: true });
  fs.mkdirSync(path.join(clawDir, 'agents'), { recursive: true });

  // Write project.json
  fs.writeFileSync(path.join(clawDir, 'project.json'), JSON.stringify({
    project_id: projectId,
    title: `Test ${projectId}`,
    description: 'test',
    repo_path: ws,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }), 'utf8');

  // Write backlog items
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
// Empty / No prior knowledge
// =========================================================================
console.log('\n--- No prior knowledge ---');

test('task pack with no prior runs has empty prior_knowledge arrays', () => {
  const ws = makeWorkspace('proj-empty', [{ id: 'T-NEW' }]);
  const result = generateTaskPack('proj-empty', 'T-NEW', { workspaceRoot: ws });

  assert.strictEqual(result.ok, true);
  assert.ok(result.task_pack.prior_knowledge);
  assert.deepStrictEqual(result.task_pack.prior_knowledge.related_artifacts, []);
  assert.deepStrictEqual(result.task_pack.prior_knowledge.agent_memories, []);
  assert.deepStrictEqual(result.task_pack.prior_knowledge.related_findings, []);
});

test('empty prior_knowledge validates against schema', () => {
  const ws = makeWorkspace('proj-val', [{ id: 'T-VAL' }]);
  const result = generateTaskPack('proj-val', 'T-VAL', { workspaceRoot: ws });

  const v = validateAgainstSchema(result.task_pack, taskPackSchema);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);
});

// =========================================================================
// Prior artifacts from artifact index
// =========================================================================
console.log('\n--- Prior artifacts ---');

test('includes artifacts from prior runs in same project', () => {
  const ws = makeWorkspace('proj-a', [{ id: 'T-B' }]);
  addRun(ws, '20260101_000000_T-A', 'proj-a', {
    '10-pm-brief.json': '{}',
    '20-arch-design.json': '{}',
    '50-qa-report.json': '{}',
  });

  const result = generateTaskPack('proj-a', 'T-B', { workspaceRoot: ws });
  const pk = result.task_pack.prior_knowledge;

  assert.ok(pk.related_artifacts.length > 0, 'should have prior artifacts');
  assert.ok(pk.related_artifacts.every(a => a.relevance === 'same-project'));
  // Should include analysis, design, and test-result (not metadata/task)
  const types = pk.related_artifacts.map(a => a.semantic_type);
  assert.ok(types.includes('analysis'));
  assert.ok(types.includes('design'));
});

test('excludes metadata and task artifacts from prior_knowledge', () => {
  const ws = makeWorkspace('proj-excl', [{ id: 'T-NEW' }]);
  addRun(ws, '20260101_000000_T-OLD', 'proj-excl', {
    'status.json': '{}', // metadata — should be there from addRun
    '31-analyze-task.txt': 'task content', // task
    '10-pm-brief.json': '{}', // analysis — should be included
  });

  const pk = gatherPriorKnowledge('proj-excl', ws);
  const types = pk.related_artifacts.map(a => a.semantic_type);
  assert.ok(!types.includes('metadata'), 'should not include metadata');
  assert.ok(!types.includes('task'), 'should not include task');
});

test('limits artifacts to top 5', () => {
  const ws = makeWorkspace('proj-lim', [{ id: 'T-NEW' }]);
  // Create multiple runs with many artifacts
  for (let i = 1; i <= 4; i++) {
    addRun(ws, `2026010${i}_000000_T-${i}`, 'proj-lim', {
      '10-pm-brief.json': '{}',
      '20-arch-design.json': '{}',
      '50-qa-report.json': '{}',
      '60-review-report.json': '{}',
    });
  }

  const pk = gatherPriorKnowledge('proj-lim', ws);
  assert.ok(pk.related_artifacts.length <= 5, `should limit to 5, got ${pk.related_artifacts.length}`);
});

test('ignores artifacts from other projects', () => {
  const ws = makeWorkspace('proj-mine', [{ id: 'T-NEW' }]);
  addRun(ws, '20260101_000000_T-OTHER', 'other-project', {
    '10-pm-brief.json': '{}',
    '50-qa-report.json': '{}',
  });

  const pk = gatherPriorKnowledge('proj-mine', ws);
  assert.strictEqual(pk.related_artifacts.length, 0, 'should not include other project artifacts');
});

// =========================================================================
// Agent memories
// =========================================================================
console.log('\n--- Agent memories ---');

test('includes agent memories from same project', () => {
  const ws = makeWorkspace('proj-mem', [{ id: 'T-NEW' }]);

  writeMemory({
    workspaceRoot: ws,
    agentId: 'agent-1',
    runId: '20260101_000000_T-OLD',
    projectId: 'proj-mem',
    stage: 'analyze',
    type: 'observation',
    content: 'Completed analyze for T-OLD. Artifacts: 10-pm-brief.json',
    tags: ['analyze', 'T-OLD'],
  });
  writeMemory({
    workspaceRoot: ws,
    agentId: 'agent-1',
    runId: '20260101_000000_T-OLD',
    projectId: 'proj-mem',
    stage: 'plan',
    type: 'lesson',
    content: 'The API layer needs careful error handling',
    tags: ['plan', 'T-OLD'],
  });

  const pk = gatherPriorKnowledge('proj-mem', ws);
  assert.strictEqual(pk.agent_memories.length, 2);
  assert.ok(pk.agent_memories.some(m => m.type === 'observation'));
  assert.ok(pk.agent_memories.some(m => m.type === 'lesson'));
  assert.ok(pk.agent_memories.every(m => m.from_run === '20260101_000000_T-OLD'));
});

test('limits agent memories to top 5 most recent', () => {
  const ws = makeWorkspace('proj-mlim', [{ id: 'T-NEW' }]);

  for (let i = 0; i < 8; i++) {
    writeMemory({
      workspaceRoot: ws,
      agentId: 'agent-1',
      runId: `run-${i}`,
      projectId: 'proj-mlim',
      stage: 'analyze',
      type: 'observation',
      content: `Observation ${i}`,
      tags: [],
    });
  }

  const pk = gatherPriorKnowledge('proj-mlim', ws);
  assert.strictEqual(pk.agent_memories.length, 5, 'should limit to 5 memories');
  // All returned memories should have from_run populated
  assert.ok(pk.agent_memories.every(m => m.from_run && m.from_run.startsWith('run-')));
});

test('ignores agent memories from other projects', () => {
  const ws = makeWorkspace('proj-nomem', [{ id: 'T-NEW' }]);

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

  const pk = gatherPriorKnowledge('proj-nomem', ws);
  assert.strictEqual(pk.agent_memories.length, 0, 'should not include other project memories');
});

// =========================================================================
// Research findings
// =========================================================================
console.log('\n--- Research findings ---');

test('includes research findings from same project', () => {
  const ws = makeWorkspace('proj-res', [{ id: 'T-NEW' }]);
  addRun(ws, '20260101_000000_T-RES', 'proj-res', {
    '18-research-findings.json': JSON.stringify({
      ticket_id: 'T-RES',
      hypotheses: [
        { id: 'H-1', statement: 'Redis works', status: 'confirmed' },
        { id: 'H-2', statement: 'Memcached is faster', status: 'rejected' },
      ],
      methods: [{ id: 'M-1', description: 'Benchmark', tools_used: ['wrk'] }],
      findings: [
        { id: 'F-1', hypothesis_id: 'H-1', description: 'Redis 85ms p95', evidence: ['log.txt'], confidence: 'high' },
      ],
      conclusion: 'Redis is recommended for API caching.',
      open_questions: [],
    }),
  });

  const pk = gatherPriorKnowledge('proj-res', ws);
  assert.strictEqual(pk.related_findings.length, 1);
  assert.strictEqual(pk.related_findings[0].run_id, '20260101_000000_T-RES');
  assert.strictEqual(pk.related_findings[0].conclusion, 'Redis is recommended for API caching.');
  assert.strictEqual(pk.related_findings[0].hypothesis_count, 2);
  assert.strictEqual(pk.related_findings[0].finding_count, 1);
});

test('ignores research findings from other projects', () => {
  const ws = makeWorkspace('proj-nores', [{ id: 'T-NEW' }]);
  addRun(ws, '20260101_000000_T-RES', 'other-project', {
    '18-research-findings.json': JSON.stringify({
      ticket_id: 'T-RES',
      hypotheses: [],
      methods: [],
      findings: [],
      conclusion: 'Test',
      open_questions: [],
    }),
  });

  const pk = gatherPriorKnowledge('proj-nores', ws);
  assert.strictEqual(pk.related_findings.length, 0);
});

// =========================================================================
// Backward compatibility
// =========================================================================
console.log('\n--- Backward compatibility ---');

test('task pack without prior_knowledge still validates (old schema compat)', () => {
  // A manually constructed old-style task pack (no prior_knowledge field)
  const oldPack = {
    task_id: 'T-OLD', project_id: 'p', title: 't', description: 'd',
    owner_role: 'DEV', inputs_present: [], open_questions: [],
    artifacts_expected: [], acceptance_criteria: [], constraints: [],
    suggested_next_agents: [], references: [],
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  };
  const v = validateAgainstSchema(oldPack, taskPackSchema);
  assert.strictEqual(v.ok, true, `Old pack should still validate: ${JSON.stringify(v.details)}`);
});

test('full task pack with prior_knowledge validates against schema', () => {
  const ws = makeWorkspace('proj-full', [{ id: 'T-FULL' }]);
  addRun(ws, '20260101_000000_T-PREV', 'proj-full', {
    '10-pm-brief.json': '{}',
    '18-research-findings.json': JSON.stringify({
      ticket_id: 'T-PREV', hypotheses: [{ id: 'H-1', statement: 's', status: 'confirmed' }],
      methods: [], findings: [], conclusion: 'Done.', open_questions: [],
    }),
  });

  writeMemory({
    workspaceRoot: ws,
    agentId: 'agent-1',
    runId: '20260101_000000_T-PREV',
    projectId: 'proj-full',
    stage: 'analyze',
    type: 'observation',
    content: 'Completed prior run',
    tags: [],
  });

  const result = generateTaskPack('proj-full', 'T-FULL', { workspaceRoot: ws });
  assert.strictEqual(result.ok, true);

  const v = validateAgainstSchema(result.task_pack, taskPackSchema);
  assert.strictEqual(v.ok, true, `Schema errors: ${JSON.stringify(v.details)}`);

  // Verify all three prior_knowledge sections populated
  const pk = result.task_pack.prior_knowledge;
  assert.ok(pk.related_artifacts.length > 0, 'should have artifacts');
  assert.ok(pk.agent_memories.length > 0, 'should have memories');
  assert.ok(pk.related_findings.length > 0, 'should have findings');
});

// =========================================================================
// Summary
// =========================================================================
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
