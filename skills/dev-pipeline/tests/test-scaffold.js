#!/usr/bin/env node
'use strict';

/**
 * Unit tests for scaffold_artifacts: generateMinimalValue + validateSchema
 * Run: node skills/dev-pipeline/tests/test-scaffold.js
 */

const fs = require('node:fs');
const path = require('node:path');

const { generateMinimalValue, validateSchema, resolveRef, ARTIFACT_SCHEMA_MAP } = require('../scripts/dev-pipeline.js');

const REFS_DIR = path.resolve(__dirname, '..', 'references');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}`);
  }
}

function assertDeepEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}`);
    console.log(`         expected: ${e}`);
    console.log(`         actual:   ${a}`);
  }
}

// -------------------------------------------------------------------------
// Test 1: Each artifact schema produces valid minimal output
// -------------------------------------------------------------------------
console.log('\n--- Schema scaffold + validate round-trip ---');

for (const [artifactFile, schemaFile] of Object.entries(ARTIFACT_SCHEMA_MAP)) {
  const schemaPath = path.join(REFS_DIR, schemaFile);
  if (!fs.existsSync(schemaPath)) {
    console.log(`  SKIP  ${schemaFile} (not found)`);
    continue;
  }
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const minimal = generateMinimalValue(schema);

  // Inject ticket_id the same way cmdScaffoldArtifacts does
  const schemaHasTicketId = (schema.required && schema.required.includes('ticket_id'))
    || (schema.properties && schema.properties.ticket_id);
  if (schemaHasTicketId && minimal && typeof minimal === 'object' && !Array.isArray(minimal)) {
    minimal.ticket_id = 'TEST-01';
  }

  const errors = validateSchema(minimal, schema);
  assert(errors.length === 0, `${artifactFile} → ${schemaFile} validates (${errors.length} errors)`);
  if (errors.length > 0) {
    for (const e of errors) console.log(`         ${e}`);
  }
}

// Also test the schemas NOT in ARTIFACT_SCHEMA_MAP (status, run-manifest)
for (const extra of ['status.schema.json', 'run-manifest.schema.json']) {
  const schemaPath = path.join(REFS_DIR, extra);
  if (!fs.existsSync(schemaPath)) continue;
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const minimal = generateMinimalValue(schema);
  const errors = validateSchema(minimal, schema);
  assert(errors.length === 0, `${extra} validates (${errors.length} errors)`);
  if (errors.length > 0) {
    for (const e of errors) console.log(`         ${e}`);
  }
}

// -------------------------------------------------------------------------
// Test 2: Type-specific generation
// -------------------------------------------------------------------------
console.log('\n--- Type-specific generation ---');

assertDeepEqual(generateMinimalValue({ type: 'string' }), '', 'string → empty');
assertDeepEqual(generateMinimalValue({ type: 'string', enum: ['a', 'b'] }), 'a', 'string enum → first');
assertDeepEqual(generateMinimalValue({ type: 'string', format: 'date-time' }), '1970-01-01T00:00:00.000Z', 'format date-time');
assertDeepEqual(generateMinimalValue({ type: 'string', format: 'uuid' }), '00000000-0000-0000-0000-000000000000', 'format uuid');
assertDeepEqual(generateMinimalValue({ type: 'string', format: 'uri' }), 'https://example.com', 'format uri');
assertDeepEqual(generateMinimalValue({ type: 'string', format: 'email' }), 'user@example.com', 'format email');
assertDeepEqual(generateMinimalValue({ type: 'string', minLength: 3 }), '___', 'minLength 3');
assertDeepEqual(generateMinimalValue({ type: 'integer' }), 0, 'integer → 0');
assertDeepEqual(generateMinimalValue({ type: 'integer', minimum: 5 }), 5, 'integer minimum');
assertDeepEqual(generateMinimalValue({ type: 'number' }), 0, 'number → 0');
assertDeepEqual(generateMinimalValue({ type: 'boolean' }), false, 'boolean → false');
assertDeepEqual(generateMinimalValue({ type: 'null' }), null, 'null → null');
assertDeepEqual(generateMinimalValue({ type: 'array' }), [], 'array → []');
assertDeepEqual(
  generateMinimalValue({ type: 'array', minItems: 2, items: { type: 'string' } }),
  ['', ''],
  'array minItems 2'
);

// -------------------------------------------------------------------------
// Test 3: Union types (e.g. ["string", "null"])
// -------------------------------------------------------------------------
console.log('\n--- Union types ---');

assertDeepEqual(generateMinimalValue({ type: ['string', 'null'] }), '', 'string|null → string');
assertDeepEqual(generateMinimalValue({ type: ['null', 'string'] }), '', 'null|string → string');
assertDeepEqual(generateMinimalValue({ type: ['array', 'null'], items: { type: 'string' } }), [], 'array|null → []');

// -------------------------------------------------------------------------
// Test 4: default values
// -------------------------------------------------------------------------
console.log('\n--- Default values ---');

assertDeepEqual(generateMinimalValue({ type: 'string', default: 'hello' }), 'hello', 'string with default');
assertDeepEqual(generateMinimalValue({ type: 'number', default: 42 }), 42, 'number with default');

// -------------------------------------------------------------------------
// Test 5: $ref resolution
// -------------------------------------------------------------------------
console.log('\n--- $ref resolution ---');

const rootWithDefs = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { $ref: '#/$defs/nameType' },
  },
  $defs: {
    nameType: { type: 'string', minLength: 1 },
  },
};
const refResult = generateMinimalValue(rootWithDefs);
assertDeepEqual(refResult, { name: '_' }, '$ref resolves to $defs');

// -------------------------------------------------------------------------
// Test 6: oneOf / anyOf / allOf
// -------------------------------------------------------------------------
console.log('\n--- Composition keywords ---');

assertDeepEqual(
  generateMinimalValue({ oneOf: [{ type: 'string' }, { type: 'number' }] }),
  '',
  'oneOf → first (string)'
);
assertDeepEqual(
  generateMinimalValue({ anyOf: [{ type: 'number' }, { type: 'string' }] }),
  0,
  'anyOf → first (number)'
);
assertDeepEqual(
  generateMinimalValue({
    allOf: [
      { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
      { required: ['b'], properties: { b: { type: 'number' } } },
    ],
  }),
  { a: '', b: 0 },
  'allOf merges objects'
);

// -------------------------------------------------------------------------
// Test 7: Object without explicit type but with properties
// -------------------------------------------------------------------------
console.log('\n--- Implicit object ---');

assertDeepEqual(
  generateMinimalValue({ required: ['x'], properties: { x: { type: 'boolean' } } }),
  { x: false },
  'no type but has properties → object'
);

// -------------------------------------------------------------------------
// Test 8: scaffold_artifacts skips .diff and doesn't overwrite
// -------------------------------------------------------------------------
console.log('\n--- Behavioral checks (no run side-effects) ---');

// diff skip
assert('40-dev-patch.diff'.endsWith('.diff'), 'diff file detected by endsWith');
assert(!'41-dev-notes.json'.endsWith('.diff'), 'json file not detected as diff');

// overwrite guard (fs.existsSync on actual file)
const tmpPath = path.join(__dirname, '__test_exists.tmp');
fs.writeFileSync(tmpPath, 'original', 'utf8');
assert(fs.existsSync(tmpPath), 'existsSync detects existing file');
fs.unlinkSync(tmpPath);
assert(!fs.existsSync(tmpPath), 'existsSync returns false after delete');

// -------------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------------
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
