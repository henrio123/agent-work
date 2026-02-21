#!/usr/bin/env node
'use strict';

/**
 * agent-memory.js — Append-only agent memory persistence.
 *
 * Agents write observations, lessons, patterns, and warnings during runs.
 * Entries accumulate at .claw/agents/<agent_id>/memory/<timestamp>.json.
 * Reads scan the directory and return sorted results. Never deletes or modifies.
 *
 * CLI:
 *   node agent-memory.js write_memory --agent_id <id> --run_id <id> --project_id <id> --stage <s> --type <t> --content <text> [--tags t1,t2]
 *   node agent-memory.js read_memory --agent_id <id> [--type <t>] [--project <id>] [--stage <s>] [--limit N]
 *
 * All stdout is JSON. Errors go to stderr as { ok: false, error: "..." }.
 *
 * Exports:
 *   writeMemory(options) → entry
 *   readMemory(options) → { ok, agent_id, total_entries, entries, by_type }
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
const ENTRY_SCHEMA_PATH = path.resolve(__dirname, '..', 'schemas', 'agent-memory.schema.json');
const INDEX_SCHEMA_PATH = path.resolve(__dirname, '..', 'schemas', 'agent-memory-index.output.schema.json');

const { validateAgainstSchema } = require(path.resolve(__dirname, 'validate-json-schema.js'));

// Monotonic counter for sub-millisecond ordering within the same process
let _seq = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function memoryDir(agentId, options) {
  const ws = (options && options.workspaceRoot) || WORKSPACE_ROOT;
  return path.join(ws, '.claw', 'agents', agentId, 'memory');
}

function loadEntrySchema() {
  return JSON.parse(fs.readFileSync(ENTRY_SCHEMA_PATH, 'utf8'));
}

function loadIndexSchema() {
  return JSON.parse(fs.readFileSync(INDEX_SCHEMA_PATH, 'utf8'));
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Write a single memory entry. Append-only — never overwrites.
 *
 * @param {object} options
 * @param {string} options.agentId
 * @param {string} options.runId
 * @param {string} options.projectId
 * @param {string} options.stage
 * @param {string} options.type - observation|lesson|pattern|warning
 * @param {string} options.content - max 2000 chars
 * @param {string[]} [options.tags=[]]
 * @param {string} [options.workspaceRoot]
 * @returns {object} the written entry
 */
function writeMemory(options) {
  const { agentId, runId, projectId, stage, type, content, tags = [] } = options;

  if (!agentId) throw new Error('agent_id is required');
  if (!runId) throw new Error('run_id is required');
  if (!projectId) throw new Error('project_id is required');
  if (!stage) throw new Error('stage is required');
  if (!type) throw new Error('type is required');
  if (!content) throw new Error('content is required');
  if (content.length > 2000) throw new Error(`content exceeds 2000 chars (${content.length})`);

  const id = crypto.randomUUID();
  const created_at = new Date().toISOString();

  const entry = {
    id,
    agent_id: agentId,
    run_id: runId,
    project_id: projectId,
    stage,
    type,
    content,
    tags: [...tags],
    created_at,
  };

  // Validate against schema
  const schema = loadEntrySchema();
  const v = validateAgainstSchema(entry, schema);
  if (!v.ok) {
    throw new Error(`Validation failed: ${v.error} — ${JSON.stringify(v.details)}`);
  }

  // Write to disk — append-only
  const dir = memoryDir(agentId, options);
  fs.mkdirSync(dir, { recursive: true });

  // Filename: ISO timestamp (colons replaced) + sequence counter + uuid prefix for uniqueness
  const tsSlug = created_at.replace(/[:.]/g, '-');
  const seq = String(_seq++).padStart(4, '0');
  const filename = `${tsSlug}_${seq}_${id.slice(0, 8)}.json`;
  const filepath = path.join(dir, filename);

  fs.writeFileSync(filepath, JSON.stringify(entry, null, 2) + '\n', 'utf8');

  return entry;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read memory entries for an agent. Supports filtering and limiting.
 *
 * @param {object} options
 * @param {string} options.agentId
 * @param {string} [options.filterType]
 * @param {string} [options.filterProject]
 * @param {string} [options.filterStage]
 * @param {number} [options.limit]
 * @param {string} [options.workspaceRoot]
 * @returns {{ ok: boolean, agent_id: string, total_entries: number, entries: object[], by_type: object }}
 */
function readMemory(options) {
  const { agentId, filterType, filterProject, filterStage, limit } = options;

  if (!agentId) throw new Error('agent_id is required');

  const dir = memoryDir(agentId, options);

  let entries = [];

  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .sort(); // alpha sort = chronological (ISO timestamp prefix)

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, file), 'utf8');
        const entry = JSON.parse(raw);
        entries.push(entry);
      } catch {
        // Skip malformed entries
      }
    }
  }

  // Apply filters
  if (filterType) {
    entries = entries.filter(e => e.type === filterType);
  }
  if (filterProject) {
    entries = entries.filter(e => e.project_id === filterProject);
  }
  if (filterStage) {
    entries = entries.filter(e => e.stage === filterStage);
  }

  // Count by type (after filtering)
  const byType = {};
  for (const e of entries) {
    byType[e.type] = (byType[e.type] || 0) + 1;
  }

  // Apply limit (most recent N — entries are sorted oldest-first, take last N)
  const total = entries.length;
  if (limit && limit > 0 && entries.length > limit) {
    entries = entries.slice(entries.length - limit);
  }

  return {
    ok: true,
    agent_id: agentId,
    total_entries: total,
    entries,
    by_type: byType,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  function fail(msg) {
    process.stderr.write(JSON.stringify({ ok: false, error: msg }) + '\n');
    process.exit(1);
  }

  function parseArgs(argList) {
    const parsed = {};
    for (let i = 0; i < argList.length; i++) {
      if (argList[i].startsWith('--') && i + 1 < argList.length) {
        const key = argList[i].slice(2);
        parsed[key] = argList[i + 1];
        i++;
      }
    }
    return parsed;
  }

  try {
    const opts = parseArgs(args.slice(1));

    switch (command) {
      case 'write_memory': {
        const entry = writeMemory({
          agentId: opts.agent_id,
          runId: opts.run_id,
          projectId: opts.project_id,
          stage: opts.stage,
          type: opts.type,
          content: opts.content,
          tags: opts.tags ? opts.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
        });
        process.stdout.write(JSON.stringify({ ok: true, entry }, null, 2) + '\n');
        break;
      }
      case 'read_memory': {
        const result = readMemory({
          agentId: opts.agent_id,
          filterType: opts.type,
          filterProject: opts.project,
          filterStage: opts.stage,
          limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
        });
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        break;
      }
      default:
        fail(`Unknown command: ${command}. Commands: write_memory, read_memory`);
    }
  } catch (e) {
    fail(e.message);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { writeMemory, readMemory };
