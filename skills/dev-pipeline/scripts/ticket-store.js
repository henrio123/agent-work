#!/usr/bin/env node
'use strict';

/**
 * ticket-store.js — Ticket persistence and anti-truncation guard.
 *
 * Ensures every ticket is stored as a file in tickets/<ticket_id>.md before
 * it can be referenced. Provides read, write, validate, and guard operations.
 *
 * Usage (via CLI):
 *   node ticket-store.js show <ticket_id>
 *   node ticket-store.js ensure <ticket_id>
 *   node ticket-store.js guard <ticket_id>
 *   node ticket-store.js list
 *   node ticket-store.js write <ticket_id> <file_path>
 *
 * Or require() for programmatic use:
 *   const { readTicket, ensureTicket, guardTicketId } = require('./ticket-store.js');
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
const TICKETS_DIR = path.join(WORKSPACE_ROOT, '.claw', 'tickets');

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------
function safePath(p, root) {
  const base = root || WORKSPACE_ROOT;
  const resolved = path.resolve(base, p);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error(`Path outside workspace: ${resolved}`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Required headings in ticket content
// ---------------------------------------------------------------------------
const REQUIRED_HEADINGS = ['GOAL', 'STEPS'];
const REQUIRED_FRONTMATTER = ['ticket_id', 'title'];

// ---------------------------------------------------------------------------
// Frontmatter parser
// ---------------------------------------------------------------------------
function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    fields[key] = val;
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Resolve the file path for a ticket ID.
 */
function resolveTicketPath(ticketId, options = {}) {
  const ticketsDir = options.ticketsDir || TICKETS_DIR;
  // Sanitize: only allow alphanumeric, dash, underscore
  if (!/^[A-Za-z0-9_-]+$/.test(ticketId)) {
    throw new Error(`Invalid ticket ID: ${ticketId}`);
  }
  return path.join(ticketsDir, `${ticketId}.md`);
}

/**
 * Read a ticket file. Returns { ok, ticket_id, content, frontmatter } or { ok: false, error }.
 */
function readTicket(ticketId, options = {}) {
  const filePath = resolveTicketPath(ticketId, options);
  if (!fs.existsSync(filePath)) {
    return {
      ok: false,
      error: `Ticket file not found: ${ticketId}.md`,
      ticket_id: ticketId,
      hint: `Run: ./tools/ticket-ensure.sh ${ticketId}`,
    };
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const frontmatter = parseFrontmatter(content);
  return {
    ok: true,
    ticket_id: ticketId,
    content,
    frontmatter,
    file_path: filePath,
  };
}

/**
 * Write a ticket file. Content must pass validation first.
 */
function writeTicket(ticketId, content, options = {}) {
  const ticketsDir = options.ticketsDir || TICKETS_DIR;
  if (!fs.existsSync(ticketsDir)) {
    fs.mkdirSync(ticketsDir, { recursive: true });
  }
  const validation = validateTicketFormat(content);
  if (!validation.ok) {
    return {
      ok: false,
      error: `Ticket content invalid: ${validation.errors.join('; ')}`,
      ticket_id: ticketId,
    };
  }
  const filePath = resolveTicketPath(ticketId, options);
  fs.writeFileSync(filePath, content, 'utf8');
  return {
    ok: true,
    ticket_id: ticketId,
    file_path: filePath,
    action: 'written',
  };
}

/**
 * Validate ticket content format.
 * Checks for frontmatter with required fields and required section headings.
 */
function validateTicketFormat(content) {
  const errors = [];

  if (!content || content.trim().length === 0) {
    return { ok: false, errors: ['Ticket content is empty'] };
  }

  // Check frontmatter
  const fm = parseFrontmatter(content);
  if (!fm) {
    errors.push('Missing YAML frontmatter (---\\n...\\n---)');
  } else {
    for (const field of REQUIRED_FRONTMATTER) {
      if (!fm[field]) {
        errors.push(`Missing required frontmatter field: ${field}`);
      }
    }
  }

  // Check required headings (case-insensitive, supports ## Heading or HEADING as line)
  const upperContent = content.toUpperCase();
  for (const heading of REQUIRED_HEADINGS) {
    const patterns = [
      new RegExp(`^##\\s+${heading}`, 'im'),        // ## Goal, ## GOAL
      new RegExp(`^${heading}\\s*$`, 'im'),           // GOAL on its own line
      new RegExp(`^${heading}\\b`, 'im'),             // GOAL followed by text
    ];
    const found = patterns.some((p) => p.test(content));
    if (!found) {
      errors.push(`Missing required heading: ${heading}`);
    }
  }

  // Check minimum body content (at least 50 chars beyond frontmatter)
  const bodyMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)/);
  const body = bodyMatch ? bodyMatch[1] : content;
  if (body.trim().length < 50) {
    errors.push('Ticket body too short (minimum 50 characters)');
  }

  return errors.length === 0
    ? { ok: true }
    : { ok: false, errors };
}

/**
 * Ensure a ticket exists and is valid. Returns structured result.
 */
function ensureTicket(ticketId, options = {}) {
  const filePath = resolveTicketPath(ticketId, options);
  if (!fs.existsSync(filePath)) {
    return {
      ok: false,
      action: 'missing',
      ticket_id: ticketId,
      error: `Ticket file not found: tickets/${ticketId}.md`,
      hint: `Create tickets/${ticketId}.md with frontmatter and required headings (GOAL, STEPS)`,
    };
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const validation = validateTicketFormat(content);
  if (!validation.ok) {
    return {
      ok: false,
      action: 'invalid',
      ticket_id: ticketId,
      error: `Ticket format invalid: ${validation.errors.join('; ')}`,
      errors: validation.errors,
      hint: 'Fix the ticket file and re-run ensure',
    };
  }

  return {
    ok: true,
    action: 'valid',
    ticket_id: ticketId,
    file_path: filePath,
  };
}

/**
 * Guard: verify a ticket ID has a persisted file before allowing it to be referenced.
 * This is the anti-truncation guard — prevents emitting a ticket ID without content.
 */
function guardTicketId(ticketId, options = {}) {
  const result = ensureTicket(ticketId, options);
  if (!result.ok) {
    return {
      ok: false,
      action: 'guard_failed',
      ticket_id: ticketId,
      error: `GUARD: Cannot reference ticket ${ticketId} — no persisted file found`,
      ensure_result: result,
      hint: `Run: ./tools/ticket-ensure.sh ${ticketId}`,
    };
  }
  return {
    ok: true,
    action: 'guard_passed',
    ticket_id: ticketId,
  };
}

/**
 * List all ticket files in the tickets directory.
 */
function listTickets(options = {}) {
  const ticketsDir = options.ticketsDir || TICKETS_DIR;
  if (!fs.existsSync(ticketsDir)) {
    return { ok: true, tickets: [], total: 0 };
  }
  const files = fs.readdirSync(ticketsDir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort();

  const tickets = files.map((f) => {
    const ticketId = f.replace('.md', '');
    const filePath = path.join(ticketsDir, f);
    const content = fs.readFileSync(filePath, 'utf8');
    const fm = parseFrontmatter(content);
    return {
      ticket_id: ticketId,
      title: fm ? fm.title || '' : '',
      file: f,
      valid: validateTicketFormat(content).ok,
    };
  });

  return { ok: true, tickets, total: tickets.length };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
  const [command, ...args] = process.argv.slice(2);

  function cliOk(data) {
    process.stdout.write(JSON.stringify({ ok: true, ...data }, null, 2) + '\n');
    process.exit(0);
  }

  function cliFail(data) {
    process.stderr.write(JSON.stringify({ ok: false, ...data }, null, 2) + '\n');
    process.exit(1);
  }

  try {
    switch (command) {
      case 'show': {
        const ticketId = args[0];
        if (!ticketId) cliFail({ error: 'Usage: ticket-store.js show <ticket_id>' });
        const result = readTicket(ticketId);
        if (!result.ok) cliFail(result);
        // For show, print raw content to stdout (not JSON)
        process.stdout.write(result.content);
        process.exit(0);
        break;
      }
      case 'ensure': {
        const ticketId = args[0];
        if (!ticketId) cliFail({ error: 'Usage: ticket-store.js ensure <ticket_id>' });
        const result = ensureTicket(ticketId);
        if (!result.ok) cliFail(result);
        cliOk(result);
        break;
      }
      case 'guard': {
        const ticketId = args[0];
        if (!ticketId) cliFail({ error: 'Usage: ticket-store.js guard <ticket_id>' });
        const result = guardTicketId(ticketId);
        if (!result.ok) cliFail(result);
        cliOk(result);
        break;
      }
      case 'list': {
        const result = listTickets();
        cliOk(result);
        break;
      }
      case 'write': {
        const ticketId = args[0];
        const filePath = args[1];
        if (!ticketId || !filePath) cliFail({ error: 'Usage: ticket-store.js write <ticket_id> <content_file>' });
        const absPath = safePath(filePath);
        if (!fs.existsSync(absPath)) cliFail({ error: `Source file not found: ${filePath}` });
        const content = fs.readFileSync(absPath, 'utf8');
        const result = writeTicket(ticketId, content);
        if (!result.ok) cliFail(result);
        cliOk(result);
        break;
      }
      default:
        cliFail({
          error: `Unknown command: ${command || '(none)'}`,
          usage: 'Commands: show, ensure, guard, list, write',
        });
    }
  } catch (err) {
    cliFail({ error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  resolveTicketPath,
  readTicket,
  writeTicket,
  validateTicketFormat,
  ensureTicket,
  guardTicketId,
  listTickets,
  parseFrontmatter,
  REQUIRED_HEADINGS,
  REQUIRED_FRONTMATTER,
};
