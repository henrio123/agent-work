#!/usr/bin/env node
'use strict';

/**
 * validate-json-schema.js — Zero-dependency JSON Schema validator (CLI + library).
 *
 * Reuses the existing validateSchema() from dev-pipeline.js for type checking,
 * required fields, enum, additionalProperties, and array items.
 *
 * Usage (CLI):
 *   node validate-json-schema.js --schema <schema.json> --json <data.json or JSON string>
 *
 * Or require() for programmatic use:
 *   const { validateAgainstSchema } = require('./validate-json-schema.js');
 *   const result = validateAgainstSchema(data, schema);
 *   // { ok: true } or { ok: false, error: '...', details: [...] }
 */

const fs = require('node:fs');
const path = require('node:path');

const { validateSchema } = require(path.resolve(__dirname, 'dev-pipeline.js'));

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------
function validateAgainstSchema(data, schema) {
  const errors = validateSchema(data, schema);
  if (errors.length === 0) {
    return { ok: true };
  }
  return {
    ok: false,
    error: `${errors.length} validation error(s)`,
    details: errors,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  const schemaIdx = args.indexOf('--schema');
  const jsonIdx = args.indexOf('--json');

  if (schemaIdx === -1 || jsonIdx === -1) {
    process.stderr.write('Usage: node validate-json-schema.js --schema <schema.json> --json <data.json or JSON string>\n');
    process.exit(1);
  }

  const schemaArg = args[schemaIdx + 1];
  const jsonArg = args[jsonIdx + 1];

  if (!schemaArg || !jsonArg) {
    process.stderr.write('Error: --schema and --json require arguments\n');
    process.exit(1);
  }

  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(schemaArg, 'utf8'));
  } catch (e) {
    process.stderr.write(JSON.stringify({ ok: false, error: `Cannot read schema: ${e.message}` }) + '\n');
    process.exit(1);
  }

  let data;
  try {
    // Try as file first, then as inline JSON string
    if (fs.existsSync(jsonArg)) {
      data = JSON.parse(fs.readFileSync(jsonArg, 'utf8'));
    } else {
      data = JSON.parse(jsonArg);
    }
  } catch (e) {
    process.stderr.write(JSON.stringify({ ok: false, error: `Cannot parse JSON: ${e.message}` }) + '\n');
    process.exit(1);
  }

  const result = validateAgainstSchema(data, schema);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = { validateAgainstSchema };
