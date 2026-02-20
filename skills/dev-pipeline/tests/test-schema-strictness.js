#!/usr/bin/env node
'use strict';

/**
 * H-01: Schema strictness tests.
 * Validates that:
 * 1. All real backlog JSON files pass the backlog-item schema
 * 2. All real project.json files pass the project schema
 * 3. All real agents.json files pass the agents schema
 * 4. All schemas (output, input, reference) have additionalProperties: false
 * Run: node skills/dev-pipeline/tests/test-schema-strictness.js
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = path.resolve(os.homedir(), 'dev', 'agent-work');

const { validateAgainstSchema } = require(path.resolve(__dirname, '..', 'scripts', 'validate-json-schema.js'));

const backlogSchema = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'backlog-item.schema.json'), 'utf8'));
const projectSchema = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'project.schema.json'), 'utf8'));
const agentsSchema = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'agents.schema.json'), 'utf8'));

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

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// ---------------------------------------------------------------
// Part 1: Real backlog files validate against backlog-item schema
// ---------------------------------------------------------------

const projectsDir = path.join(WORKSPACE_ROOT, 'projects');
if (fs.existsSync(projectsDir)) {
  const projectIds = fs.readdirSync(projectsDir).filter(f => {
    const stat = fs.statSync(path.join(projectsDir, f));
    return stat.isDirectory();
  });

  for (const projectId of projectIds) {
    const backlogDir = path.join(projectsDir, projectId, 'backlog');
    if (!fs.existsSync(backlogDir)) continue;

    const files = fs.readdirSync(backlogDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(backlogDir, file);
      const itemId = path.basename(file, '.json');

      test(`backlog item ${projectId}/${itemId} validates against schema`, () => {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const result = validateAgainstSchema(data, backlogSchema);
        assert(result.ok, `Validation failed: ${JSON.stringify(result.details)}`);
      });
    }

    // Project.json validation
    const projectJsonPath = path.join(projectsDir, projectId, 'project.json');
    if (fs.existsSync(projectJsonPath)) {
      test(`project.json for ${projectId} validates against schema`, () => {
        const data = JSON.parse(fs.readFileSync(projectJsonPath, 'utf8'));
        const result = validateAgainstSchema(data, projectSchema);
        assert(result.ok, `Validation failed: ${JSON.stringify(result.details)}`);
      });
    }

    // Agents.json validation
    const agentsJsonPath = path.join(projectsDir, projectId, 'agents.json');
    if (fs.existsSync(agentsJsonPath)) {
      test(`agents.json for ${projectId} validates against schema`, () => {
        const data = JSON.parse(fs.readFileSync(agentsJsonPath, 'utf8'));
        const result = validateAgainstSchema(data, agentsSchema);
        assert(result.ok, `Validation failed: ${JSON.stringify(result.details)}`);
      });
    }
  }
}

// ---------------------------------------------------------------
// Part 2: All schemas have additionalProperties: false
// ---------------------------------------------------------------

function collectSchemaObjects(schema, label) {
  const results = [];
  if (schema.type === 'object' && schema.properties) {
    results.push({ path: label, schema });
  }
  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (propSchema.type === 'object' && propSchema.properties) {
        results.push({ path: `${label}.${key}`, schema: propSchema });
      }
    }
  }
  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (propSchema.items && propSchema.items.type === 'object' && propSchema.items.properties) {
        results.push({ path: `${label}.${key}[*]`, schema: propSchema.items });
      }
    }
  }
  return results;
}

// Output schemas
const schemasDir = path.resolve(__dirname, '..', 'schemas');
const schemaFiles = fs.readdirSync(schemasDir).filter(f => f.endsWith('.schema.json'));

for (const file of schemaFiles) {
  const filePath = path.join(schemasDir, file);
  const schema = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const objects = collectSchemaObjects(schema, file);

  for (const obj of objects) {
    test(`${obj.path} has additionalProperties: false`, () => {
      assert(
        obj.schema.additionalProperties === false,
        `Missing additionalProperties: false at ${obj.path}`
      );
    });
  }
}

// Reference schemas
const refsDir = path.resolve(__dirname, '..', 'references');
if (fs.existsSync(refsDir)) {
  const refFiles = fs.readdirSync(refsDir).filter(f => f.endsWith('.schema.json'));

  for (const file of refFiles) {
    const filePath = path.join(refsDir, file);
    const schema = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const objects = collectSchemaObjects(schema, `references/${file}`);

    for (const obj of objects) {
      test(`${obj.path} has additionalProperties: false`, () => {
        assert(
          obj.schema.additionalProperties === false,
          `Missing additionalProperties: false at ${obj.path}`
        );
      });
    }
  }
}

// ---------------------------------------------------------------
// Part 3: backlog-item schema declares phase and stop_condition
// ---------------------------------------------------------------

test('backlog-item schema declares phase field', () => {
  assert(backlogSchema.properties.phase, 'phase not in schema properties');
});

test('backlog-item schema declares stop_condition field', () => {
  assert(backlogSchema.properties.stop_condition, 'stop_condition not in schema properties');
});

test('backlog-item schema has additionalProperties: false', () => {
  assert(backlogSchema.additionalProperties === false, 'missing additionalProperties: false');
});

test('project schema has additionalProperties: false', () => {
  assert(projectSchema.additionalProperties === false, 'missing additionalProperties: false');
});

test('agents schema has additionalProperties: false at root', () => {
  assert(agentsSchema.additionalProperties === false, 'missing additionalProperties: false at root');
});

test('agents schema has additionalProperties: false on agent items', () => {
  assert(
    agentsSchema.properties.agents.items.additionalProperties === false,
    'missing additionalProperties: false on agent items'
  );
});

// ---------------------------------------------------------------
// Summary
// ---------------------------------------------------------------
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
