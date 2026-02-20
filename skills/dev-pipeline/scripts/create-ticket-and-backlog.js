#!/usr/bin/env node
'use strict';

/**
 * create-ticket-and-backlog.js — Atomically create a ticket file + backlog item.
 *
 * Reuses ticket-store.js for ticket persistence and validate-json-schema.js
 * for backlog schema validation.
 *
 * Usage (CLI):
 *   node create-ticket-and-backlog.js \
 *     --ticket_id T-01 --title "Fix login" --project_id barger \
 *     --description "Login times out" --type dev --priority P1 \
 *     --owner_role DEV --goal "Fix the timeout" --steps "Step 1,Step 2"
 *
 * Programmatic:
 *   const { createTicketAndBacklog } = require('./create-ticket-and-backlog.js');
 *   const result = createTicketAndBacklog({ ticket_id, title, ... }, { ticketsDir, projectsDir });
 *   // { ok: true, ticket_id, ticket_path, backlog_path, action: "created" }
 *   // { ok: false, error }
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { writeTicket, validateTicketFormat, resolveTicketPath } = require(path.resolve(__dirname, 'ticket-store.js'));
const { validateAgainstSchema } = require(path.resolve(__dirname, 'validate-json-schema.js'));

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');

const backlogSchema = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'backlog-item.schema.json'), 'utf8')
);

// Enum values from the backlog-item schema
const VALID_TYPES = backlogSchema.properties.type.enum;
const VALID_PRIORITIES = backlogSchema.properties.priority.enum;
const VALID_OWNER_ROLES = backlogSchema.properties.owner_role.enum;

const REQUIRED_PARAMS = [
  'ticket_id', 'title', 'project_id', 'description',
  'type', 'priority', 'owner_role', 'goal', 'steps',
];

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------
function createTicketAndBacklog(params, options = {}) {
  const wsRoot = options.workspaceRoot || WORKSPACE_ROOT;
  const ticketsDir = options.ticketsDir || path.join(wsRoot, '.claw', 'tickets');
  const backlogBaseDir = options.backlogDir || path.join(wsRoot, '.claw', 'backlog');

  // 1. Validate required params
  for (const key of REQUIRED_PARAMS) {
    if (!params[key] && params[key] !== 0) {
      return { ok: false, error: `Missing required parameter: ${key}` };
    }
  }

  // 2. Validate enums
  if (!VALID_TYPES.includes(params.type)) {
    return { ok: false, error: `Invalid type '${params.type}'. Must be one of: ${VALID_TYPES.join(', ')}` };
  }
  if (!VALID_PRIORITIES.includes(params.priority)) {
    return { ok: false, error: `Invalid priority '${params.priority}'. Must be one of: ${VALID_PRIORITIES.join(', ')}` };
  }
  if (!VALID_OWNER_ROLES.includes(params.owner_role)) {
    return { ok: false, error: `Invalid owner_role '${params.owner_role}'. Must be one of: ${VALID_OWNER_ROLES.join(', ')}` };
  }

  // Normalize steps
  const steps = Array.isArray(params.steps) ? params.steps : params.steps.split(',').map(s => s.trim());
  if (steps.length === 0 || steps.every(s => s === '')) {
    return { ok: false, error: 'Steps must contain at least one non-empty step' };
  }

  // 3. Check conflicts
  const ticketPath = resolveTicketPath(params.ticket_id, { ticketsDir });
  if (fs.existsSync(ticketPath)) {
    return { ok: false, error: `Ticket file already exists: ${params.ticket_id}.md` };
  }

  const backlogDir = backlogBaseDir;
  const backlogPath = path.join(backlogDir, `${params.ticket_id}.json`);
  if (fs.existsSync(backlogPath)) {
    return { ok: false, error: `Backlog item already exists: ${params.ticket_id}.json` };
  }

  // 4. Build ticket markdown
  const stepsMarkdown = steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const ticketContent = [
    '---',
    `ticket_id: ${params.ticket_id}`,
    `title: ${params.title}`,
    `project: ${params.project_id}`,
    '---',
    '',
    '## Goal',
    '',
    params.goal,
    '',
    '## Steps',
    '',
    stepsMarkdown,
    '',
    `## Description`,
    '',
    params.description,
    '',
  ].join('\n');

  // 5. Validate ticket format
  const ticketValidation = validateTicketFormat(ticketContent);
  if (!ticketValidation.ok) {
    return { ok: false, error: `Ticket content invalid: ${ticketValidation.errors.join('; ')}` };
  }

  // 6. Build backlog item JSON
  const now = new Date().toISOString();
  const backlogItem = {
    id: params.ticket_id,
    project_id: params.project_id,
    type: params.type,
    title: params.title,
    description: params.description,
    created_at: now,
    updated_at: now,
    status: 'todo',
    priority: params.priority,
    owner_role: params.owner_role,
    depends_on: params.depends_on || [],
    run_folder: null,
    tags: params.tags || [],
    artifacts_expected: params.artifacts_expected || [],
    last_summary: null,
    parent_id: params.parent_id || null,
    phase: params.phase || '',
    stop_condition: params.stop_condition || '',
  };

  // 7. Validate backlog JSON against schema
  const schemaResult = validateAgainstSchema(backlogItem, backlogSchema);
  if (!schemaResult.ok) {
    return { ok: false, error: `Backlog item schema validation failed: ${schemaResult.details.join('; ')}` };
  }

  // 8. Write ticket file
  const writeResult = writeTicket(params.ticket_id, ticketContent, { ticketsDir });
  if (!writeResult.ok) {
    return writeResult;
  }

  // 9. Write backlog JSON (cleanup ticket on failure)
  try {
    if (!fs.existsSync(backlogDir)) {
      fs.mkdirSync(backlogDir, { recursive: true });
    }
    fs.writeFileSync(backlogPath, JSON.stringify(backlogItem, null, 2) + '\n', 'utf8');
  } catch (err) {
    // Cleanup the ticket file on backlog write failure
    try { fs.unlinkSync(ticketPath); } catch {}
    return { ok: false, error: `Failed to write backlog item: ${err.message}` };
  }

  // 10. Return success
  return {
    ok: true,
    ticket_id: params.ticket_id,
    ticket_path: ticketPath,
    backlog_path: backlogPath,
    action: 'created',
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);

  function getArg(name) {
    const idx = args.indexOf(`--${name}`);
    if (idx === -1 || idx + 1 >= args.length) return undefined;
    return args[idx + 1];
  }

  const params = {
    ticket_id: getArg('ticket_id'),
    title: getArg('title'),
    project_id: getArg('project_id'),
    description: getArg('description'),
    type: getArg('type'),
    priority: getArg('priority'),
    owner_role: getArg('owner_role'),
    goal: getArg('goal'),
    steps: getArg('steps'),
    tags: getArg('tags') ? getArg('tags').split(',').map(s => s.trim()) : undefined,
    depends_on: getArg('depends_on') ? getArg('depends_on').split(',').map(s => s.trim()) : undefined,
    parent_id: getArg('parent_id'),
    phase: getArg('phase'),
    stop_condition: getArg('stop_condition'),
    artifacts_expected: getArg('artifacts_expected') ? getArg('artifacts_expected').split(',').map(s => s.trim()) : undefined,
  };

  // Remove undefined optional keys
  for (const key of Object.keys(params)) {
    if (params[key] === undefined) delete params[key];
  }

  const options = {};
  if (getArg('workspace')) options.workspaceRoot = getArg('workspace');
  if (getArg('tickets_dir')) options.ticketsDir = getArg('tickets_dir');
  if (getArg('backlog_dir')) options.backlogDir = getArg('backlog_dir');

  const result = createTicketAndBacklog(params, options);
  if (!result.ok) {
    process.stderr.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = { createTicketAndBacklog };
