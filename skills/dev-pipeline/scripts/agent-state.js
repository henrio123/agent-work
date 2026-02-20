#!/usr/bin/env node
'use strict';

/**
 * agent-state.js — Persistent agent state contract.
 *
 * Each agent identity gets agents/<agent_id>/state.json with:
 *   assigned role, current task, workload counters, timestamps.
 *
 * CLI:
 *   node agent-state.js init <agent_id> <role>
 *   node agent-state.js read <agent_id>
 *   node agent-state.js assign <agent_id> <task_id>
 *   node agent-state.js clear <agent_id>
 *   node agent-state.js increment <agent_id> <runs_started|stages_completed> [amount]
 *   node agent-state.js list
 *
 * All stdout is JSON. Errors go to stderr as { ok: false, error: "..." }.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
const SCHEMA_PATH = path.resolve(__dirname, '..', 'schemas', 'agent-state.schema.json');

const { validateAgainstSchema } = require(path.resolve(__dirname, 'validate-json-schema.js'));

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------
function safePath(p) {
  const resolved = path.resolve(WORKSPACE_ROOT, p);
  if (!resolved.startsWith(WORKSPACE_ROOT + path.sep) && resolved !== WORKSPACE_ROOT) {
    throw new Error(`Path outside workspace: ${resolved}`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function agentsDir(options) {
  return options && options.agentsDir ? options.agentsDir : path.join(WORKSPACE_ROOT, '.claw', 'agents');
}

function agentDir(agentId, options) {
  return path.join(agentsDir(options), agentId);
}

function statePath(agentId, options) {
  return path.join(agentDir(agentId, options), 'state.json');
}

function now() {
  return new Date().toISOString();
}

function loadSchema() {
  return JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
}

function validate(state) {
  const schema = loadSchema();
  return validateAgainstSchema(state, schema);
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

function readAgentState(agentId, options) {
  const fp = options && options.agentsDir
    ? path.join(options.agentsDir, agentId, 'state.json')
    : safePath(path.join('.claw', 'agents', agentId, 'state.json'));

  if (!fs.existsSync(fp)) return null;
  const state = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const v = validate(state);
  if (!v.ok) {
    throw new Error(`Invalid agent state for ${agentId}: ${v.error}`);
  }
  return state;
}

function writeAgentState(agentId, state, options) {
  const v = validate(state);
  if (!v.ok) {
    throw new Error(`Validation failed: ${v.error} — ${JSON.stringify(v.details)}`);
  }

  const dir = options && options.agentsDir
    ? path.join(options.agentsDir, agentId)
    : safePath(path.join('.claw', 'agents', agentId));

  fs.mkdirSync(dir, { recursive: true });

  const fp = path.join(dir, 'state.json');
  fs.writeFileSync(fp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  return state;
}

function initAgent(agentId, role, options) {
  const existing = readAgentState(agentId, options);
  if (existing !== null) {
    throw new Error(`Agent ${agentId} already exists`);
  }

  const ts = now();
  const state = {
    agent_id: agentId,
    role,
    current_task: null,
    workload: { runs_started: 0, stages_completed: 0 },
    created_at: ts,
    updated_at: ts,
    last_active_at: ts,
  };

  writeAgentState(agentId, state, options);
  return state;
}

function updateWorkload(agentId, field, increment, options) {
  if (field !== 'runs_started' && field !== 'stages_completed') {
    throw new Error(`Invalid workload field: ${field}. Must be runs_started or stages_completed`);
  }
  if (typeof increment !== 'number' || increment < 1 || !Number.isInteger(increment)) {
    throw new Error(`Invalid increment: ${increment}. Must be a positive integer`);
  }

  const state = readAgentState(agentId, options);
  if (state === null) {
    throw new Error(`Agent ${agentId} not found`);
  }

  const ts = now();
  state.workload[field] += increment;
  state.updated_at = ts;
  state.last_active_at = ts;

  writeAgentState(agentId, state, options);
  return state;
}

function assignTask(agentId, taskId, options) {
  const state = readAgentState(agentId, options);
  if (state === null) {
    throw new Error(`Agent ${agentId} not found`);
  }

  const ts = now();
  state.current_task = taskId;
  state.updated_at = ts;
  state.last_active_at = ts;

  writeAgentState(agentId, state, options);
  return state;
}

function clearTask(agentId, options) {
  const state = readAgentState(agentId, options);
  if (state === null) {
    throw new Error(`Agent ${agentId} not found`);
  }

  const ts = now();
  state.current_task = null;
  state.updated_at = ts;
  state.last_active_at = ts;

  writeAgentState(agentId, state, options);
  return state;
}

function listAgents(options) {
  const dir = agentsDir(options);
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();

  const results = [];
  for (const name of entries) {
    const fp = path.join(dir, name, 'state.json');
    if (!fs.existsSync(fp)) continue;
    try {
      const state = JSON.parse(fs.readFileSync(fp, 'utf8'));
      results.push({
        agent_id: state.agent_id,
        role: state.role,
        current_task: state.current_task,
        workload: state.workload,
        last_active_at: state.last_active_at,
      });
    } catch (_) {
      // skip invalid entries
    }
  }
  return results;
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

  function ok(agentId, state) {
    process.stdout.write(JSON.stringify({ ok: true, agent_id: agentId, state }, null, 2) + '\n');
  }

  try {
    switch (command) {
      case 'init': {
        const agentId = args[1];
        const role = args[2];
        if (!agentId || !role) fail('Usage: init <agent_id> <role>');
        const state = initAgent(agentId, role);
        ok(agentId, state);
        break;
      }
      case 'read': {
        const agentId = args[1];
        if (!agentId) fail('Usage: read <agent_id>');
        const state = readAgentState(agentId);
        if (state === null) fail(`Agent ${agentId} not found`);
        ok(agentId, state);
        break;
      }
      case 'assign': {
        const agentId = args[1];
        const taskId = args[2];
        if (!agentId || !taskId) fail('Usage: assign <agent_id> <task_id>');
        const state = assignTask(agentId, taskId);
        ok(agentId, state);
        break;
      }
      case 'clear': {
        const agentId = args[1];
        if (!agentId) fail('Usage: clear <agent_id>');
        const state = clearTask(agentId);
        ok(agentId, state);
        break;
      }
      case 'increment': {
        const agentId = args[1];
        const field = args[2];
        const amount = args[3] ? parseInt(args[3], 10) : 1;
        if (!agentId || !field) fail('Usage: increment <agent_id> <runs_started|stages_completed> [amount]');
        const state = updateWorkload(agentId, field, amount);
        ok(agentId, state);
        break;
      }
      case 'list': {
        const agents = listAgents();
        process.stdout.write(JSON.stringify({ ok: true, agents }, null, 2) + '\n');
        break;
      }
      default:
        fail(`Unknown command: ${command}. Commands: init, read, assign, clear, increment, list`);
    }
  } catch (e) {
    fail(e.message);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  readAgentState,
  writeAgentState,
  initAgent,
  updateWorkload,
  assignTask,
  clearTask,
  listAgents,
  safePath,
};
