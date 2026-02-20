#!/usr/bin/env node
'use strict';

/**
 * Tests for ticket-store.js — ticket persistence and anti-truncation guard.
 * Run: node skills/dev-pipeline/tests/test-ticket-store.js
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
const STORE_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'ticket-store.js');
const SHOW_SHELL = path.join(WORKSPACE_ROOT, 'tools', 'ticket-show.sh');
const ENSURE_SHELL = path.join(WORKSPACE_ROOT, 'tools', 'ticket-ensure.sh');
const GUARD_SHELL = path.join(WORKSPACE_ROOT, 'tools', 'ticket-guard.sh');
const LIST_SHELL = path.join(WORKSPACE_ROOT, 'tools', 'ticket-list.sh');

const {
  resolveTicketPath,
  readTicket,
  writeTicket,
  validateTicketFormat,
  ensureTicket,
  guardTicketId,
  listTickets,
  parseFrontmatter,
} = require(STORE_SCRIPT);

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

function makeTempTicketsDir() {
  const dir = path.join(os.tmpdir(), `_test_tickets_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function writeTestTicket(ticketsDir, ticketId, overrides = {}) {
  const content = overrides.content || `---
ticket_id: ${ticketId}
title: Test ticket ${ticketId}
project: test-project
---

## Goal

This is a test ticket for ${ticketId} with enough content to pass the minimum body length validation check.

## Steps

1. Step one
2. Step two

## Acceptance

- [ ] Test passes
`;
  fs.writeFileSync(path.join(ticketsDir, `${ticketId}.md`), content, 'utf8');
  return content;
}

function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
process.on('exit', cleanup);

// -------------------------------------------------------------------------
// Test 1: resolveTicketPath
// -------------------------------------------------------------------------
console.log('\n--- resolveTicketPath ---');

test('resolves valid ticket ID', () => {
  const ticketsDir = makeTempTicketsDir();
  const p = resolveTicketPath('OC-22', { ticketsDir });
  if (!p.endsWith('OC-22.md')) throw new Error('wrong path: ' + p);
});

test('rejects invalid ticket ID with special chars', () => {
  let threw = false;
  try {
    resolveTicketPath('../evil', { ticketsDir: '/tmp' });
  } catch {
    threw = true;
  }
  if (!threw) throw new Error('should reject invalid ticket ID');
});

test('rejects ticket ID with spaces', () => {
  let threw = false;
  try {
    resolveTicketPath('OC 22', { ticketsDir: '/tmp' });
  } catch {
    threw = true;
  }
  if (!threw) throw new Error('should reject ticket ID with spaces');
});

// -------------------------------------------------------------------------
// Test 2: parseFrontmatter
// -------------------------------------------------------------------------
console.log('\n--- parseFrontmatter ---');

test('parses valid frontmatter', () => {
  const fm = parseFrontmatter('---\nticket_id: OC-22\ntitle: Test\n---\nbody');
  if (!fm) throw new Error('expected frontmatter');
  if (fm.ticket_id !== 'OC-22') throw new Error('wrong ticket_id');
  if (fm.title !== 'Test') throw new Error('wrong title');
});

test('returns null for no frontmatter', () => {
  const fm = parseFrontmatter('no frontmatter here');
  if (fm !== null) throw new Error('expected null');
});

// -------------------------------------------------------------------------
// Test 3: validateTicketFormat
// -------------------------------------------------------------------------
console.log('\n--- validateTicketFormat ---');

test('valid ticket passes validation', () => {
  const ticketsDir = makeTempTicketsDir();
  const content = writeTestTicket(ticketsDir, 'T-VALID');
  const result = validateTicketFormat(content);
  if (!result.ok) throw new Error('expected ok: ' + result.errors.join('; '));
});

test('empty content fails validation', () => {
  const result = validateTicketFormat('');
  if (result.ok) throw new Error('expected failure');
  if (!result.errors.some((e) => e.includes('empty'))) throw new Error('wrong error');
});

test('missing frontmatter fails validation', () => {
  const result = validateTicketFormat('## Goal\nSome content that is long enough to pass the minimum check easily.\n\n## Steps\n1. Step');
  if (result.ok) throw new Error('expected failure');
  if (!result.errors.some((e) => e.includes('frontmatter'))) throw new Error('wrong error: ' + result.errors);
});

test('missing required frontmatter field fails', () => {
  const content = '---\nticket_id: T-1\n---\n\n## Goal\nContent long enough to pass the minimum body length validation check.\n\n## Steps\n1. Do something';
  const result = validateTicketFormat(content);
  if (result.ok) throw new Error('expected failure for missing title');
  if (!result.errors.some((e) => e.includes('title'))) throw new Error('wrong error');
});

test('missing GOAL heading fails', () => {
  const content = '---\nticket_id: T-1\ntitle: Test\n---\n\n## Steps\n1. Step one which is long enough to pass the minimum body length validation check easily.';
  const result = validateTicketFormat(content);
  if (result.ok) throw new Error('expected failure for missing GOAL');
  if (!result.errors.some((e) => e.includes('GOAL'))) throw new Error('wrong error');
});

test('missing STEPS heading fails', () => {
  const content = '---\nticket_id: T-1\ntitle: Test\n---\n\n## Goal\nSome goal that is long enough to pass minimum body length validation check easily.';
  const result = validateTicketFormat(content);
  if (result.ok) throw new Error('expected failure for missing STEPS');
  if (!result.errors.some((e) => e.includes('STEPS'))) throw new Error('wrong error');
});

test('body too short fails validation', () => {
  const content = '---\nticket_id: T-1\ntitle: Test\n---\n\n## Goal\nX\n## Steps\n1';
  const result = validateTicketFormat(content);
  if (result.ok) throw new Error('expected failure for short body');
  if (!result.errors.some((e) => e.includes('short'))) throw new Error('wrong error');
});

test('case-insensitive heading detection (## goal)', () => {
  const content = '---\nticket_id: T-1\ntitle: Test\n---\n\n## goal\nSome content that is long enough to pass the minimum body length validation check easily.\n\n## steps\n1. Step one';
  const result = validateTicketFormat(content);
  if (!result.ok) throw new Error('expected ok: ' + result.errors.join('; '));
});

// -------------------------------------------------------------------------
// Test 4: readTicket
// -------------------------------------------------------------------------
console.log('\n--- readTicket ---');

test('reads existing ticket', () => {
  const ticketsDir = makeTempTicketsDir();
  const content = writeTestTicket(ticketsDir, 'T-READ');
  const result = readTicket('T-READ', { ticketsDir });
  if (!result.ok) throw new Error('expected ok');
  if (result.content !== content) throw new Error('content mismatch');
  if (!result.frontmatter) throw new Error('expected frontmatter');
  if (result.frontmatter.ticket_id !== 'T-READ') throw new Error('wrong ticket_id');
});

test('returns error for missing ticket', () => {
  const ticketsDir = makeTempTicketsDir();
  const result = readTicket('T-MISSING', { ticketsDir });
  if (result.ok) throw new Error('expected failure');
  if (!result.error.includes('not found')) throw new Error('wrong error');
  if (!result.hint) throw new Error('missing hint');
});

// -------------------------------------------------------------------------
// Test 5: writeTicket
// -------------------------------------------------------------------------
console.log('\n--- writeTicket ---');

test('writes valid ticket', () => {
  const ticketsDir = makeTempTicketsDir();
  const content = `---
ticket_id: T-WRITE
title: Write test
project: test
---

## Goal

Test writing a ticket with enough content to pass the minimum body validation check.

## Steps

1. Write it
`;
  const result = writeTicket('T-WRITE', content, { ticketsDir });
  if (!result.ok) throw new Error('expected ok: ' + JSON.stringify(result));
  if (!fs.existsSync(path.join(ticketsDir, 'T-WRITE.md'))) throw new Error('file not created');
});

test('refuses to write invalid content', () => {
  const ticketsDir = makeTempTicketsDir();
  const result = writeTicket('T-BAD', 'not valid', { ticketsDir });
  if (result.ok) throw new Error('expected failure');
  if (!result.error.includes('invalid')) throw new Error('wrong error');
});

// -------------------------------------------------------------------------
// Test 6: ensureTicket
// -------------------------------------------------------------------------
console.log('\n--- ensureTicket ---');

test('ensure passes for valid ticket', () => {
  const ticketsDir = makeTempTicketsDir();
  writeTestTicket(ticketsDir, 'T-ENSURE');
  const result = ensureTicket('T-ENSURE', { ticketsDir });
  if (!result.ok) throw new Error('expected ok');
  if (result.action !== 'valid') throw new Error('expected action valid');
});

test('ensure fails for missing ticket', () => {
  const ticketsDir = makeTempTicketsDir();
  const result = ensureTicket('T-NOPE', { ticketsDir });
  if (result.ok) throw new Error('expected failure');
  if (result.action !== 'missing') throw new Error('expected action missing');
  if (!result.hint) throw new Error('missing hint');
});

test('ensure fails for invalid format', () => {
  const ticketsDir = makeTempTicketsDir();
  fs.writeFileSync(path.join(ticketsDir, 'T-INVALID.md'), 'just some text', 'utf8');
  const result = ensureTicket('T-INVALID', { ticketsDir });
  if (result.ok) throw new Error('expected failure');
  if (result.action !== 'invalid') throw new Error('expected action invalid');
  if (!result.errors) throw new Error('missing errors array');
});

// -------------------------------------------------------------------------
// Test 7: guardTicketId (anti-truncation guard)
// -------------------------------------------------------------------------
console.log('\n--- guardTicketId ---');

test('guard passes for existing valid ticket', () => {
  const ticketsDir = makeTempTicketsDir();
  writeTestTicket(ticketsDir, 'T-GUARD');
  const result = guardTicketId('T-GUARD', { ticketsDir });
  if (!result.ok) throw new Error('expected ok');
  if (result.action !== 'guard_passed') throw new Error('expected guard_passed');
});

test('guard fails for missing ticket', () => {
  const ticketsDir = makeTempTicketsDir();
  const result = guardTicketId('T-GHOST', { ticketsDir });
  if (result.ok) throw new Error('expected failure');
  if (result.action !== 'guard_failed') throw new Error('expected guard_failed');
  if (!result.error.includes('GUARD')) throw new Error('error should mention GUARD');
  if (!result.hint) throw new Error('missing hint');
});

test('guard fails for invalid ticket', () => {
  const ticketsDir = makeTempTicketsDir();
  fs.writeFileSync(path.join(ticketsDir, 'T-BAD-GUARD.md'), 'short', 'utf8');
  const result = guardTicketId('T-BAD-GUARD', { ticketsDir });
  if (result.ok) throw new Error('expected failure');
  if (result.action !== 'guard_failed') throw new Error('expected guard_failed');
});

// -------------------------------------------------------------------------
// Test 8: listTickets
// -------------------------------------------------------------------------
console.log('\n--- listTickets ---');

test('lists tickets from directory', () => {
  const ticketsDir = makeTempTicketsDir();
  writeTestTicket(ticketsDir, 'T-LIST-A');
  writeTestTicket(ticketsDir, 'T-LIST-B');
  const result = listTickets({ ticketsDir });
  if (!result.ok) throw new Error('expected ok');
  if (result.total !== 2) throw new Error(`expected 2, got ${result.total}`);
  if (result.tickets[0].ticket_id !== 'T-LIST-A') throw new Error('wrong first');
  if (result.tickets[1].ticket_id !== 'T-LIST-B') throw new Error('wrong second');
});

test('lists empty directory', () => {
  const ticketsDir = makeTempTicketsDir();
  const result = listTickets({ ticketsDir });
  if (!result.ok) throw new Error('expected ok');
  if (result.total !== 0) throw new Error('expected 0');
});

test('excludes README.md from list', () => {
  const ticketsDir = makeTempTicketsDir();
  fs.writeFileSync(path.join(ticketsDir, 'README.md'), '# Readme', 'utf8');
  writeTestTicket(ticketsDir, 'T-LIST-REAL');
  const result = listTickets({ ticketsDir });
  if (result.total !== 1) throw new Error(`expected 1, got ${result.total}`);
});

// -------------------------------------------------------------------------
// Test 9: Real ticket validation (OC-22)
// -------------------------------------------------------------------------
console.log('\n--- real ticket ---');

test('OC-22.md passes ensure', () => {
  const result = ensureTicket('OC-22');
  if (!result.ok) throw new Error('OC-22 ensure failed: ' + JSON.stringify(result));
});

test('OC-08.md passes ensure', () => {
  const result = ensureTicket('OC-08');
  if (!result.ok) throw new Error('OC-08 ensure failed: ' + JSON.stringify(result));
});

test('readTicket OC-22 returns full content', () => {
  const result = readTicket('OC-22');
  if (!result.ok) throw new Error('expected ok');
  if (!result.content.includes('Anti Truncation Guard')) throw new Error('content missing expected text');
  if (result.frontmatter.ticket_id !== 'OC-22') throw new Error('wrong ticket_id');
});

// -------------------------------------------------------------------------
// Test 10: CLI
// -------------------------------------------------------------------------
console.log('\n--- CLI ---');

test('CLI show prints raw content', () => {
  const stdout = execFileSync('node', [STORE_SCRIPT, 'show', 'OC-22'], { encoding: 'utf8', timeout: 10000 });
  if (!stdout.includes('ticket_id: OC-22')) throw new Error('missing ticket_id in output');
  if (!stdout.includes('## Goal')) throw new Error('missing Goal heading');
});

test('CLI ensure exits 0 for valid ticket', () => {
  const stdout = execFileSync('node', [STORE_SCRIPT, 'ensure', 'OC-22'], { encoding: 'utf8', timeout: 10000 });
  const parsed = JSON.parse(stdout);
  if (!parsed.ok) throw new Error('expected ok');
});

test('CLI ensure exits 1 for missing ticket', () => {
  let exitedNonZero = false;
  try {
    execFileSync('node', [STORE_SCRIPT, 'ensure', 'NONEXISTENT-99'], { encoding: 'utf8', timeout: 10000, stdio: 'pipe' });
  } catch (e) {
    exitedNonZero = true;
    const parsed = JSON.parse(e.stderr);
    if (parsed.ok) throw new Error('expected ok:false');
    if (parsed.action !== 'missing') throw new Error('expected action missing');
  }
  if (!exitedNonZero) throw new Error('should exit non-zero');
});

test('CLI guard exits 0 for valid ticket', () => {
  const stdout = execFileSync('node', [STORE_SCRIPT, 'guard', 'OC-22'], { encoding: 'utf8', timeout: 10000 });
  const parsed = JSON.parse(stdout);
  if (!parsed.ok) throw new Error('expected ok');
});

test('CLI guard exits 1 for missing ticket', () => {
  let exitedNonZero = false;
  try {
    execFileSync('node', [STORE_SCRIPT, 'guard', 'NONEXISTENT-99'], { encoding: 'utf8', timeout: 10000, stdio: 'pipe' });
  } catch (e) {
    exitedNonZero = true;
    const parsed = JSON.parse(e.stderr);
    if (parsed.ok) throw new Error('expected ok:false');
    if (parsed.action !== 'guard_failed') throw new Error('expected guard_failed');
  }
  if (!exitedNonZero) throw new Error('should exit non-zero');
});

test('CLI list outputs JSON', () => {
  const stdout = execFileSync('node', [STORE_SCRIPT, 'list'], { encoding: 'utf8', timeout: 10000 });
  const parsed = JSON.parse(stdout);
  if (!parsed.ok) throw new Error('expected ok');
  if (!Array.isArray(parsed.tickets)) throw new Error('expected tickets array');
  if (parsed.total < 2) throw new Error('expected at least 2 tickets');
});

// -------------------------------------------------------------------------
// Test 11: Shell helpers
// -------------------------------------------------------------------------
console.log('\n--- shell helpers ---');

test('ticket-show.sh prints raw content', () => {
  const stdout = execFileSync('bash', [SHOW_SHELL, 'OC-22'], { encoding: 'utf8', timeout: 10000 });
  if (!stdout.includes('ticket_id: OC-22')) throw new Error('missing ticket_id');
});

test('ticket-ensure.sh exits 0 for valid', () => {
  const stdout = execFileSync('bash', [ENSURE_SHELL, 'OC-22'], { encoding: 'utf8', timeout: 10000 });
  const parsed = JSON.parse(stdout);
  if (!parsed.ok) throw new Error('expected ok');
});

test('ticket-ensure.sh exits 1 for missing', () => {
  let exitedNonZero = false;
  try {
    execFileSync('bash', [ENSURE_SHELL, 'NONEXISTENT-99'], { encoding: 'utf8', timeout: 10000, stdio: 'pipe' });
  } catch {
    exitedNonZero = true;
  }
  if (!exitedNonZero) throw new Error('should exit non-zero');
});

test('ticket-guard.sh exits 0 for valid', () => {
  const stdout = execFileSync('bash', [GUARD_SHELL, 'OC-22'], { encoding: 'utf8', timeout: 10000 });
  const parsed = JSON.parse(stdout);
  if (!parsed.ok) throw new Error('expected ok');
});

test('ticket-guard.sh exits 1 for missing', () => {
  let exitedNonZero = false;
  try {
    execFileSync('bash', [GUARD_SHELL, 'NONEXISTENT-99'], { encoding: 'utf8', timeout: 10000, stdio: 'pipe' });
  } catch {
    exitedNonZero = true;
  }
  if (!exitedNonZero) throw new Error('should exit non-zero');
});

test('ticket-list.sh outputs JSON', () => {
  const stdout = execFileSync('bash', [LIST_SHELL], { encoding: 'utf8', timeout: 10000 });
  const parsed = JSON.parse(stdout);
  if (!parsed.ok) throw new Error('expected ok');
});

// -------------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------------
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
