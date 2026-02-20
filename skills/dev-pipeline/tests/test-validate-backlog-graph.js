#!/usr/bin/env node
'use strict';

/**
 * P2-02: Tests for validate-backlog-graph.js — DAG validation and cycle detection.
 * Run: node skills/dev-pipeline/tests/test-validate-backlog-graph.js
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'validate-backlog-graph.js');

const { validateBacklogGraph } = require(SCRIPT);
const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));

const outputSchema = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '..', 'schemas', 'validate-backlog-graph.output.schema.json'), 'utf8'));

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

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function makeTempProjectsDir() {
  const dir = path.join(os.tmpdir(), `_test_graph_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function makeProject(projectsDir, projectId, backlogItems = []) {
  const projectDir = path.join(projectsDir, projectId);
  fs.mkdirSync(projectDir, { recursive: true });

  fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify({
    project_id: projectId, title: `Project ${projectId}`, description: 'test',
    repo_path: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  }), 'utf8');

  if (backlogItems.length > 0) {
    const backlogDir = path.join(projectDir, 'backlog');
    fs.mkdirSync(backlogDir, { recursive: true });
    for (const item of backlogItems) {
      const defaults = {
        project_id: projectId,
        type: 'task',
        title: `Task ${item.id}`,
        description: '',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        status: 'todo',
        priority: 'P2',
        owner_role: 'DEV',
        depends_on: [],
        parent_id: null,
        run_folder: null,
        tags: [],
        artifacts_expected: [],
        ...item,
      };
      fs.writeFileSync(
        path.join(backlogDir, `${defaults.id}.json`),
        JSON.stringify(defaults, null, 2),
        'utf8'
      );
    }
  }
}

function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
process.on('exit', cleanup);

// -------------------------------------------------------------------------
// 1. Empty backlog
// -------------------------------------------------------------------------
console.log('\n--- empty backlog ---');

test('empty backlog is valid', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-empty', []);
  const result = validateBacklogGraph('proj-empty', { projectsDir });
  assert(result.ok === true, 'should succeed');
  assert(result.valid === true, 'should be valid');
  assert(result.nodes === 0, `nodes should be 0, got ${result.nodes}`);
  assert(result.cycles.length === 0, 'no cycles');
});

// -------------------------------------------------------------------------
// 2. Linear chain (no cycles)
// -------------------------------------------------------------------------
console.log('\n--- linear chain ---');

test('linear chain A→B→C is valid', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-linear', [
    { id: 'A' },
    { id: 'B', depends_on: ['A'] },
    { id: 'C', depends_on: ['B'] },
  ]);
  const result = validateBacklogGraph('proj-linear', { projectsDir });
  assert(result.valid === true, 'should be valid');
  assert(result.cycles.length === 0, 'no cycles');
  assert(result.edges.depends_on === 2, `depends_on edges should be 2, got ${result.edges.depends_on}`);
});

// -------------------------------------------------------------------------
// 3. Simple cycle A→B→A
// -------------------------------------------------------------------------
console.log('\n--- simple cycle ---');

test('simple cycle A→B→A is detected', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-cycle2', [
    { id: 'A', depends_on: ['B'] },
    { id: 'B', depends_on: ['A'] },
  ]);
  const result = validateBacklogGraph('proj-cycle2', { projectsDir });
  assert(result.valid === false, 'should be invalid');
  assert(result.cycles.length > 0, 'should have at least one cycle');
  // Cycle path should contain both A and B
  const flat = result.cycles.flat();
  assert(flat.includes('A'), 'cycle should include A');
  assert(flat.includes('B'), 'cycle should include B');
});

// -------------------------------------------------------------------------
// 4. 3-node cycle A→B→C→A
// -------------------------------------------------------------------------
console.log('\n--- 3-node cycle ---');

test('3-node cycle A→B→C→A is detected', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-cycle3', [
    { id: 'A', depends_on: ['C'] },
    { id: 'B', depends_on: ['A'] },
    { id: 'C', depends_on: ['B'] },
  ]);
  const result = validateBacklogGraph('proj-cycle3', { projectsDir });
  assert(result.valid === false, 'should be invalid');
  assert(result.cycles.length > 0, 'should have cycles');
  // At least one cycle path should have 3+ unique nodes
  const longestCycle = result.cycles.reduce((a, b) => a.length > b.length ? a : b, []);
  const uniqueInCycle = new Set(longestCycle);
  assert(uniqueInCycle.size >= 3, `cycle should have 3+ unique nodes, got ${uniqueInCycle.size}`);
});

// -------------------------------------------------------------------------
// 5. Diamond (not a cycle)
// -------------------------------------------------------------------------
console.log('\n--- diamond ---');

test('diamond A→B,C→D is valid (not a cycle)', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-diamond', [
    { id: 'A' },
    { id: 'B', depends_on: ['A'] },
    { id: 'C', depends_on: ['A'] },
    { id: 'D', depends_on: ['B', 'C'] },
  ]);
  const result = validateBacklogGraph('proj-diamond', { projectsDir });
  assert(result.valid === true, 'diamond should be valid');
  assert(result.cycles.length === 0, 'no cycles');
  assert(result.edges.depends_on === 4, `depends_on edges should be 4, got ${result.edges.depends_on}`);
});

// -------------------------------------------------------------------------
// 6. Valid parent_id
// -------------------------------------------------------------------------
console.log('\n--- parent_id validation ---');

test('valid parent_id (child → epic) passes', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-parent-ok', [
    { id: 'EPIC-1', type: 'epic' },
    { id: 'CHILD-1', parent_id: 'EPIC-1' },
    { id: 'CHILD-2', parent_id: 'EPIC-1' },
  ]);
  const result = validateBacklogGraph('proj-parent-ok', { projectsDir });
  assert(result.valid === true, 'should be valid');
  assert(result.parent_errors.length === 0, 'no parent errors');
  assert(result.edges.parent_child === 2, `parent_child edges should be 2, got ${result.edges.parent_child}`);
});

// -------------------------------------------------------------------------
// 7. parent_id references non-existent item
// -------------------------------------------------------------------------
test('parent_id referencing non-existent item is an error', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-parent-missing', [
    { id: 'CHILD-X', parent_id: 'NONEXIST' },
  ]);
  const result = validateBacklogGraph('proj-parent-missing', { projectsDir });
  assert(result.valid === false, 'should be invalid');
  assert(result.parent_errors.length > 0, 'should have parent errors');
  assert(result.parent_errors[0].includes('NONEXIST'), 'error should mention NONEXIST');
  assert(result.parent_errors[0].includes('does not exist'), 'error should say does not exist');
});

// -------------------------------------------------------------------------
// 8. parent_id references non-epic item
// -------------------------------------------------------------------------
test('parent_id referencing non-epic item is an error', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-parent-nonepic', [
    { id: 'TASK-P', type: 'task' },
    { id: 'CHILD-P', parent_id: 'TASK-P' },
  ]);
  const result = validateBacklogGraph('proj-parent-nonepic', { projectsDir });
  assert(result.valid === false, 'should be invalid');
  assert(result.parent_errors.length > 0, 'should have parent errors');
  assert(result.parent_errors[0].includes("'task'"), 'error should mention the actual type');
  assert(result.parent_errors[0].includes("'epic'"), 'error should mention expected epic');
});

// -------------------------------------------------------------------------
// 9. Self-referencing parent_id
// -------------------------------------------------------------------------
test('self-referencing parent_id is an error', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-parent-self', [
    { id: 'SELF-REF', type: 'epic', parent_id: 'SELF-REF' },
  ]);
  const result = validateBacklogGraph('proj-parent-self', { projectsDir });
  assert(result.valid === false, 'should be invalid');
  assert(result.parent_errors.some(e => e.includes('self-referencing')), 'should mention self-referencing');
});

// -------------------------------------------------------------------------
// 10. Circular parent chain
// -------------------------------------------------------------------------
test('circular parent chain A→B→A is an error', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-parent-circular', [
    { id: 'EP-A', type: 'epic', parent_id: 'EP-B' },
    { id: 'EP-B', type: 'epic', parent_id: 'EP-A' },
  ]);
  const result = validateBacklogGraph('proj-parent-circular', { projectsDir });
  assert(result.valid === false, 'should be invalid');
  assert(result.parent_errors.some(e => e.includes('circular parent chain')),
    `should mention circular parent chain: ${JSON.stringify(result.parent_errors)}`);
});

// -------------------------------------------------------------------------
// 11. Dangling depends_on
// -------------------------------------------------------------------------
console.log('\n--- dangling depends_on ---');

test('dangling depends_on produces warning, not error', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-dangling', [
    { id: 'T-1', depends_on: ['GHOST'] },
  ]);
  const result = validateBacklogGraph('proj-dangling', { projectsDir });
  assert(result.valid === true, 'should still be valid (warning only)');
  assert(result.warnings.length > 0, 'should have warnings');
  assert(result.warnings[0].includes('GHOST'), 'warning should mention GHOST');
  assert(result.warnings[0].includes('does not exist'), 'warning should say does not exist');
});

// -------------------------------------------------------------------------
// 12. Schema validation
// -------------------------------------------------------------------------
console.log('\n--- schema validation ---');

test('output validates against schema (valid graph)', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-schema', [
    { id: 'A' },
    { id: 'B', depends_on: ['A'] },
  ]);
  const result = validateBacklogGraph('proj-schema', { projectsDir });
  const v = validateAgainstSchema(result, outputSchema);
  assert(v.ok, `schema validation failed: ${(v.details || []).join('; ')}`);
});

test('output validates against schema (invalid graph with cycles)', () => {
  const projectsDir = makeTempProjectsDir();
  makeProject(projectsDir, 'proj-schema-cyc', [
    { id: 'X', depends_on: ['Y'] },
    { id: 'Y', depends_on: ['X'] },
  ]);
  const result = validateBacklogGraph('proj-schema-cyc', { projectsDir });
  const v = validateAgainstSchema(result, outputSchema);
  assert(v.ok, `schema validation failed: ${(v.details || []).join('; ')}`);
});

// -------------------------------------------------------------------------
// 13. CLI
// -------------------------------------------------------------------------
console.log('\n--- CLI ---');

test('CLI outputs valid JSON for real project', () => {
  const stdout = execFileSync('node', [SCRIPT, 'ai-organisation-os'], {
    encoding: 'utf8', timeout: 10000,
  });
  const parsed = JSON.parse(stdout);
  assert(parsed.ok === true, 'should succeed');
  assert(typeof parsed.valid === 'boolean', 'should have valid field');
  assert(typeof parsed.nodes === 'number', 'should have nodes field');
});

test('CLI exits 1 for non-existent project', () => {
  let exitedNonZero = false;
  try {
    execFileSync('node', [SCRIPT, 'nonexistent-project-xyz'], {
      encoding: 'utf8', stdio: 'pipe', timeout: 10000,
    });
  } catch (e) {
    exitedNonZero = true;
    assert(e.status === 1, 'should exit 1');
    const stderr = e.stderr || '';
    assert(stderr.includes('not found'), `stderr should mention not found: ${stderr}`);
  }
  assert(exitedNonZero, 'should have failed');
});

test('CLI output validates against schema', () => {
  const stdout = execFileSync('node', [SCRIPT, 'ai-organisation-os'], {
    encoding: 'utf8', timeout: 10000,
  });
  const parsed = JSON.parse(stdout);
  const v = validateAgainstSchema(parsed, outputSchema);
  assert(v.ok, `schema validation failed: ${(v.details || []).join('; ')}`);
});

// -------------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------------
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
