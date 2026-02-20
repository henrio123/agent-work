#!/usr/bin/env node
'use strict';

/**
 * Capability registry tests for the dev-pipeline capability system.
 * Run: node skills/dev-pipeline/tests/test-capability-registry.js
 *
 * Tests cover:
 *   - Backward compatibility (no capabilities)
 *   - Manifest validation
 *   - Stage chain injection
 *   - Artifact schema merging
 *   - Template/schema path resolution
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { loadCapabilities, resolveTemplatePath, resolveSchemaPath } = require('../scripts/capability-registry.js');
const {
  STAGE_CONFIG, DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP, ENGINE_ROOT,
} = require('../scripts/dev-pipeline.js');

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

// ---------------------------------------------------------------------------
// Helpers: create temp workspace and capability fixtures
// ---------------------------------------------------------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-reg-test-'));
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

// Create a temp workspace root with .claw/ directory
function makeWorkspace(capabilities) {
  const ws = fs.mkdtempSync(path.join(TMP, 'ws-'));
  fs.mkdirSync(path.join(ws, '.claw'), { recursive: true });
  if (capabilities !== undefined) {
    fs.writeFileSync(
      path.join(ws, '.claw', 'capabilities.json'),
      JSON.stringify({ capabilities }),
      'utf8'
    );
  }
  return ws;
}

// Create a temp engine root with a capability directory
function makeEngine() {
  const eng = fs.mkdtempSync(path.join(TMP, 'eng-'));
  fs.mkdirSync(path.join(eng, 'templates'), { recursive: true });
  fs.mkdirSync(path.join(eng, 'skills', 'dev-pipeline', 'references'), { recursive: true });
  return eng;
}

// Create a capability inside an engine root
function addCapability(engineRoot, name, manifest, opts = {}) {
  const capDir = path.join(engineRoot, 'skills', 'capabilities', name);
  fs.mkdirSync(capDir, { recursive: true });
  fs.writeFileSync(path.join(capDir, 'capability.json'), JSON.stringify(manifest), 'utf8');

  if (opts.templates) {
    fs.mkdirSync(path.join(capDir, 'templates'), { recursive: true });
    for (const [fname, content] of Object.entries(opts.templates)) {
      fs.writeFileSync(path.join(capDir, 'templates', fname), content, 'utf8');
    }
  }

  if (opts.references) {
    fs.mkdirSync(path.join(capDir, 'references'), { recursive: true });
    for (const [fname, content] of Object.entries(opts.references)) {
      fs.writeFileSync(path.join(capDir, 'references', fname),
        typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
    }
  }

  return capDir;
}

// A valid manifest for testing
function validManifest(overrides = {}) {
  return {
    name: 'ux-audit',
    version: '1.0.0',
    description: 'Injects a UX audit stage between analyze and plan.',
    stages: [{
      name: 'ux-audit',
      after: 'analyze',
      role: 'UX Analyst',
      requiredArtifacts: ['15-ux-audit.json'],
      taskFile: '36-ux-audit-task.txt',
      template: 'claude-ux-pack.txt',
    }],
    artifactSchemas: { '15-ux-audit.json': 'ux-audit.schema.json' },
    stageMigrations: {},
    ...overrides,
  };
}

// =========================================================================
// Test group 1: Backward compatibility
// =========================================================================
console.log('\n--- Backward compatibility ---');

test('Missing capabilities.json returns empty result', () => {
  const ws = makeWorkspace(); // no capabilities.json written
  // Remove the capabilities.json that makeWorkspace doesn't create when arg is undefined
  const capPath = path.join(ws, '.claw', 'capabilities.json');
  if (fs.existsSync(capPath)) fs.unlinkSync(capPath);

  const eng = makeEngine();
  const result = loadCapabilities(ws, eng, DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP);
  assert.deepStrictEqual(result.stageConfig, {});
  assert.deepStrictEqual(result.artifactSchemaMap, {});
  assert.deepStrictEqual(result.stageMigrations, {});
  assert.deepStrictEqual(result.capabilityDirs, []);
});

test('Empty capabilities array is a no-op', () => {
  const ws = makeWorkspace([]);
  const eng = makeEngine();
  const result = loadCapabilities(ws, eng, DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP);
  assert.deepStrictEqual(result.stageConfig, {});
  assert.deepStrictEqual(result.capabilityDirs, []);
});

test('STAGE_CONFIG without capabilities equals DEFAULT_STAGES', () => {
  // Since there's no .claw/capabilities.json in the real workspace,
  // STAGE_CONFIG should be a copy of DEFAULT_STAGES
  for (const [name, config] of Object.entries(DEFAULT_STAGES)) {
    assert.ok(STAGE_CONFIG[name], `STAGE_CONFIG missing ${name}`);
    assert.strictEqual(STAGE_CONFIG[name].role, config.role);
    assert.strictEqual(STAGE_CONFIG[name].next, config.next);
    assert.deepStrictEqual(STAGE_CONFIG[name].requiredArtifacts, config.requiredArtifacts);
  }
});

// =========================================================================
// Test group 2: Manifest validation
// =========================================================================
console.log('\n--- Manifest validation ---');

test('Rejects missing capability directory', () => {
  const ws = makeWorkspace(['nonexistent-cap']);
  const eng = makeEngine();
  assert.throws(
    () => loadCapabilities(ws, eng, DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP),
    /Capability directory not found/
  );
});

test('Rejects invalid manifest (missing required fields)', () => {
  const ws = makeWorkspace(['bad-cap']);
  const eng = makeEngine();
  addCapability(eng, 'bad-cap', { name: 'bad-cap' }); // missing version, stages
  assert.throws(
    () => loadCapabilities(ws, eng, DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP),
    /missing required field "version"/
  );
});

test('Rejects stage name conflicting with default stages', () => {
  const ws = makeWorkspace(['conflict-cap']);
  const eng = makeEngine();
  addCapability(eng, 'conflict-cap', validManifest({
    name: 'conflict-cap',
    stages: [{
      name: 'analyze', // conflicts with default
      after: 'plan',
      role: 'Test',
      requiredArtifacts: [],
      taskFile: 'test.txt',
      template: 'test.txt',
    }],
  }));
  assert.throws(
    () => loadCapabilities(ws, eng, DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP),
    /conflicts with a reserved\/default stage name/
  );
});

test('Rejects unknown "after" target', () => {
  const ws = makeWorkspace(['bad-after']);
  const eng = makeEngine();
  addCapability(eng, 'bad-after', validManifest({
    name: 'bad-after',
    stages: [{
      name: 'phantom-stage',
      after: 'nonexistent-stage',
      role: 'Test',
      requiredArtifacts: [],
      taskFile: 'test.txt',
      template: 'test.txt',
    }],
  }));
  assert.throws(
    () => loadCapabilities(ws, eng, DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP),
    /unknown "after" target "nonexistent-stage"/
  );
});

// =========================================================================
// Test group 3: Stage chain injection
// =========================================================================
console.log('\n--- Stage chain injection ---');

test('Single capability injects at correct position (analyze → ux-audit → plan)', () => {
  const ws = makeWorkspace(['ux-audit']);
  const eng = makeEngine();
  addCapability(eng, 'ux-audit', validManifest());

  const result = loadCapabilities(ws, eng, DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP);
  // analyze.next should now point to ux-audit
  assert.strictEqual(result.stageConfig['analyze'].next, 'ux-audit');
  // ux-audit.next should point to plan (the original analyze.next)
  assert.strictEqual(result.stageConfig['ux-audit'].next, 'plan');
  // plan.next should remain implement
  assert.strictEqual(result.stageConfig['plan'].next, 'implement');
});

test('Injected stage has all required fields (role, requiredArtifacts, taskFile, template, next)', () => {
  const ws = makeWorkspace(['ux-audit']);
  const eng = makeEngine();
  addCapability(eng, 'ux-audit', validManifest());

  const result = loadCapabilities(ws, eng, DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP);
  const injected = result.stageConfig['ux-audit'];
  assert.strictEqual(injected.role, 'UX Analyst');
  assert.deepStrictEqual(injected.requiredArtifacts, ['15-ux-audit.json']);
  assert.strictEqual(injected.taskFile, '36-ux-audit-task.txt');
  assert.strictEqual(injected.template, 'claude-ux-pack.txt');
  assert.strictEqual(injected.next, 'plan');
});

test('Chain remains linear after injection (traversal reaches done, no cycles)', () => {
  const ws = makeWorkspace(['ux-audit']);
  const eng = makeEngine();
  addCapability(eng, 'ux-audit', validManifest());

  const result = loadCapabilities(ws, eng, DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP);
  const config = result.stageConfig;

  // Walk the chain from analyze to done
  let stage = 'analyze';
  const visited = [];
  const maxIter = 20; // safety against cycles
  let i = 0;
  while (stage !== 'done' && i < maxIter) {
    visited.push(stage);
    const c = config[stage];
    assert.ok(c, `No config for stage: ${stage}`);
    stage = c.next;
    i++;
  }
  assert.strictEqual(stage, 'done', `Chain did not reach done, stopped at ${stage}`);
  assert.deepStrictEqual(visited, ['analyze', 'ux-audit', 'plan', 'implement', 'validate', 'review']);
});

test('Two capabilities both after "analyze" produces deterministic ordering', () => {
  const ws = makeWorkspace(['cap-beta', 'cap-alpha']);
  const eng = makeEngine();

  addCapability(eng, 'cap-alpha', validManifest({
    name: 'cap-alpha',
    stages: [{
      name: 'alpha-stage',
      after: 'analyze',
      role: 'Alpha',
      requiredArtifacts: [],
      taskFile: 'alpha-task.txt',
      template: 'alpha.txt',
    }],
    artifactSchemas: {},
  }));

  addCapability(eng, 'cap-beta', validManifest({
    name: 'cap-beta',
    stages: [{
      name: 'beta-stage',
      after: 'analyze',
      role: 'Beta',
      requiredArtifacts: [],
      taskFile: 'beta-task.txt',
      template: 'beta.txt',
    }],
    artifactSchemas: {},
  }));

  const result = loadCapabilities(ws, eng, DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP);
  const config = result.stageConfig;

  // Capabilities sorted alphabetically: cap-alpha processed first, then cap-beta
  // cap-alpha: analyze → alpha-stage → plan
  // cap-beta: analyze → beta-stage → alpha-stage → plan
  assert.strictEqual(config['analyze'].next, 'beta-stage');
  assert.strictEqual(config['beta-stage'].next, 'alpha-stage');
  assert.strictEqual(config['alpha-stage'].next, 'plan');

  // Run again to verify determinism
  const result2 = loadCapabilities(ws, eng, DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP);
  assert.strictEqual(result2.stageConfig['analyze'].next, 'beta-stage');
  assert.strictEqual(result2.stageConfig['beta-stage'].next, 'alpha-stage');
});

// =========================================================================
// Test group 4: Artifact schema merging
// =========================================================================
console.log('\n--- Artifact schema merging ---');

test('Capability schemas merged into map', () => {
  const ws = makeWorkspace(['ux-audit']);
  const eng = makeEngine();
  addCapability(eng, 'ux-audit', validManifest());

  const result = loadCapabilities(ws, eng, DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP);
  assert.strictEqual(result.artifactSchemaMap['15-ux-audit.json'], 'ux-audit.schema.json');
});

test('Rejects capability that overrides core artifact schema', () => {
  const ws = makeWorkspace(['override-cap']);
  const eng = makeEngine();
  addCapability(eng, 'override-cap', validManifest({
    name: 'override-cap',
    stages: [{
      name: 'custom-stage',
      after: 'analyze',
      role: 'Custom',
      requiredArtifacts: [],
      taskFile: 'custom.txt',
      template: 'custom.txt',
    }],
    artifactSchemas: {
      '10-pm-brief.json': 'my-pm-brief.schema.json', // conflicts with core
    },
  }));

  assert.throws(
    () => loadCapabilities(ws, eng, DEFAULT_STAGES, DEFAULT_ARTIFACT_SCHEMA_MAP),
    /cannot override core artifact schema for "10-pm-brief.json"/
  );
});

// =========================================================================
// Test group 5: Template/schema resolution
// =========================================================================
console.log('\n--- Template/schema resolution ---');

test('resolveTemplatePath finds capability template first', () => {
  const eng = makeEngine();
  // Write a template in both engine and capability
  fs.writeFileSync(path.join(eng, 'templates', 'shared.txt'), 'engine version', 'utf8');
  const capDir = path.join(TMP, 'cap-tpl');
  fs.mkdirSync(path.join(capDir, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(capDir, 'templates', 'shared.txt'), 'cap version', 'utf8');

  const resolved = resolveTemplatePath('shared.txt', [capDir], eng);
  assert.strictEqual(resolved, path.join(capDir, 'templates', 'shared.txt'));
});

test('resolveTemplatePath falls back to ENGINE_ROOT/templates/', () => {
  const eng = makeEngine();
  fs.writeFileSync(path.join(eng, 'templates', 'engine-only.txt'), 'content', 'utf8');

  const resolved = resolveTemplatePath('engine-only.txt', [], eng);
  assert.strictEqual(resolved, path.join(eng, 'templates', 'engine-only.txt'));
});

test('resolveTemplatePath throws if not found anywhere', () => {
  const eng = makeEngine();
  assert.throws(
    () => resolveTemplatePath('nonexistent.txt', [], eng),
    /Template not found: nonexistent\.txt/
  );
});

test('resolveSchemaPath finds capability reference, falls back to core', () => {
  const eng = makeEngine();

  // Write schema in capability references
  const capDir = path.join(TMP, 'cap-schema');
  fs.mkdirSync(path.join(capDir, 'references'), { recursive: true });
  fs.writeFileSync(path.join(capDir, 'references', 'cap-schema.json'), '{}', 'utf8');

  // Capability schema found
  const resolved = resolveSchemaPath('cap-schema.json', [capDir], eng);
  assert.strictEqual(resolved, path.join(capDir, 'references', 'cap-schema.json'));

  // Fall back to engine references
  fs.writeFileSync(
    path.join(eng, 'skills', 'dev-pipeline', 'references', 'core-schema.json'),
    '{}', 'utf8'
  );
  const corePath = resolveSchemaPath('core-schema.json', [], eng);
  assert.strictEqual(corePath, path.join(eng, 'skills', 'dev-pipeline', 'references', 'core-schema.json'));

  // Not found anywhere → null
  const missing = resolveSchemaPath('nonexistent.json', [], eng);
  assert.strictEqual(missing, null);
});

// =========================================================================
// Summary
// =========================================================================
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
