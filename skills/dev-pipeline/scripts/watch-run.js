#!/usr/bin/env node
'use strict';

/**
 * watch-run.js — Deterministic read-only watcher for a run folder.
 *
 * Polls status.json for changes, optionally tails autonomous-audit.jsonl.
 * Emits JSONL events to stdout. Never mutates the filesystem.
 *
 * Usage (via CLI):
 *   node watch-run.js <run_folder> [--follow_audit] [--poll_ms N] [--max_events N]
 *
 * Or require() for programmatic use:
 *   const { watchRun } = require('./watch-run.js');
 *   watchRun(runFolder, { followAudit, pollMs, maxEvents, onEvent });
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
const AUDIT_FILENAME = 'autonomous-audit.jsonl';
const STOP_FILENAME = '.stop';

function safePath(p) {
  const resolved = path.resolve(WORKSPACE_ROOT, p);
  if (!resolved.startsWith(WORKSPACE_ROOT + path.sep) && resolved !== WORKSPACE_ROOT) {
    throw new Error(`Path outside workspace: ${resolved}`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Core watch loop
// ---------------------------------------------------------------------------
function watchRun(runFolder, options = {}) {
  const pollMs = options.pollMs || 500;
  const maxEvents = options.maxEvents || 0; // 0 = unlimited
  const followAudit = options.followAudit || false;
  const onEvent = options.onEvent || ((evt) => {
    process.stdout.write(JSON.stringify(evt) + '\n');
  });

  // Validate run folder
  let resolvedFolder;
  try {
    resolvedFolder = safePath(runFolder);
  } catch (e) {
    onEvent({ ts: new Date().toISOString(), event: 'error', error: e.message });
    return { ok: false, events_emitted: 0, error: e.message };
  }

  const runsDir = safePath('.claw/runs');
  if (!resolvedFolder.startsWith(runsDir + path.sep)) {
    const msg = 'run folder must be under runs/';
    onEvent({ ts: new Date().toISOString(), event: 'error', error: msg });
    return { ok: false, events_emitted: 0, error: msg };
  }

  const statusPath = path.join(resolvedFolder, 'status.json');
  if (!fs.existsSync(resolvedFolder) || !fs.existsSync(statusPath)) {
    const msg = 'run folder does not exist or missing status.json';
    onEvent({ ts: new Date().toISOString(), event: 'error', error: msg });
    return { ok: false, events_emitted: 0, error: msg };
  }

  let eventsEmitted = 0;

  function emit(evt) {
    if (maxEvents > 0 && eventsEmitted >= maxEvents) return false;
    evt.ts = evt.ts || new Date().toISOString();
    onEvent(evt);
    eventsEmitted++;
    return maxEvents === 0 || eventsEmitted < maxEvents;
  }

  // Track status.json state
  let lastStatusMtime = 0;
  let lastStatusJson = '';

  // Track audit log state
  const auditPath = path.join(resolvedFolder, AUDIT_FILENAME);
  let auditLinesRead = 0;
  let auditMissingEmitted = false;

  // Track .stop state
  let lastStopPresent = false;

  // Emit initial status snapshot
  function readCurrentStatus() {
    try {
      const stat = fs.statSync(statusPath);
      const content = fs.readFileSync(statusPath, 'utf8');
      return { mtime: stat.mtimeMs, content };
    } catch {
      return null;
    }
  }

  function pollOnce() {
    let shouldContinue = true;

    // Check status.json
    const current = readCurrentStatus();
    if (current) {
      if (lastStatusMtime === 0) {
        // First read — emit snapshot
        lastStatusMtime = current.mtime;
        lastStatusJson = current.content;
        let status;
        try { status = JSON.parse(current.content); } catch { status = null; }
        shouldContinue = emit({
          event: 'status_snapshot',
          run_folder: runFolder,
          status,
        });
        if (!shouldContinue) return false;
      } else if (current.mtime !== lastStatusMtime || current.content !== lastStatusJson) {
        // Changed
        lastStatusMtime = current.mtime;
        lastStatusJson = current.content;
        let status;
        try { status = JSON.parse(current.content); } catch { status = null; }
        shouldContinue = emit({
          event: 'status_changed',
          run_folder: runFolder,
          status,
        });
        if (!shouldContinue) return false;
      }
    }

    // Check .stop
    const stopPresent = fs.existsSync(path.join(resolvedFolder, STOP_FILENAME));
    if (stopPresent && !lastStopPresent) {
      shouldContinue = emit({ event: 'stop_signal_present', run_folder: runFolder });
      if (!shouldContinue) return false;
    }
    lastStopPresent = stopPresent;

    // Follow audit log
    if (followAudit) {
      if (!fs.existsSync(auditPath)) {
        if (!auditMissingEmitted) {
          shouldContinue = emit({ event: 'audit_missing', run_folder: runFolder });
          auditMissingEmitted = true;
          if (!shouldContinue) return false;
        }
      } else {
        auditMissingEmitted = false;
        try {
          const content = fs.readFileSync(auditPath, 'utf8');
          const lines = content.trim() ? content.trim().split('\n') : [];
          // Emit only new lines
          while (auditLinesRead < lines.length) {
            let lineObj;
            try { lineObj = JSON.parse(lines[auditLinesRead]); } catch { lineObj = null; }
            shouldContinue = emit({
              event: 'audit_line',
              line: lineObj || lines[auditLinesRead],
            });
            auditLinesRead++;
            if (!shouldContinue) return false;
          }
        } catch {
          // Audit file read error — skip silently
        }
      }
    }

    return true;
  }

  // Synchronous polling loop for max_events mode (deterministic/testable)
  if (maxEvents > 0) {
    // Poll up to maxEvents * 2 times to allow for changes to propagate
    const maxPolls = maxEvents * 2 + 2;
    for (let i = 0; i < maxPolls; i++) {
      if (!pollOnce()) break;
      if (eventsEmitted >= maxEvents) break;
      // Busy-wait a tiny bit for synchronous mode (tests inject changes between calls)
    }
    return { ok: true, events_emitted: eventsEmitted };
  }

  // Async polling loop for interactive mode
  const interval = setInterval(() => {
    if (!pollOnce()) {
      clearInterval(interval);
    }
  }, pollMs);

  // Clean shutdown on SIGINT/SIGTERM
  const cleanup = () => {
    clearInterval(interval);
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  return { ok: true, events_emitted: eventsEmitted, interval };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    process.stderr.write('Usage: node watch-run.js <run_folder> [--follow_audit] [--poll_ms N] [--max_events N]\n');
    process.stderr.write('\nRead-only watcher. Emits JSONL events to stdout.\n');
    process.exit(args[0] === '--help' ? 0 : 1);
  }

  const optFlags = new Set(['--follow_audit', '--poll_ms', '--max_events']);
  const runFolder = args.find((a) => !optFlags.has(a) && !args.some((f, i) => optFlags.has(f) && args[i + 1] === a));

  if (!runFolder) {
    process.stderr.write('Error: run_folder argument required\n');
    process.exit(1);
  }

  // Path validation (same rules as stop/resume helpers)
  if (runFolder.startsWith('/')) {
    process.stderr.write(JSON.stringify({ ok: false, error: 'absolute paths not allowed — use .claw/runs/<folder>' }) + '\n');
    process.exit(1);
  }
  if (!runFolder.startsWith('.claw/runs/')) {
    process.stderr.write(JSON.stringify({ ok: false, error: 'path must start with .claw/runs/' }) + '\n');
    process.exit(1);
  }
  if (runFolder.includes('..')) {
    process.stderr.write(JSON.stringify({ ok: false, error: 'path traversal not allowed' }) + '\n');
    process.exit(1);
  }

  const pollMsIdx = args.indexOf('--poll_ms');
  const maxEventsIdx = args.indexOf('--max_events');

  const opts = {
    followAudit: args.includes('--follow_audit'),
    pollMs: pollMsIdx !== -1 ? parseInt(args[pollMsIdx + 1], 10) : 500,
    maxEvents: maxEventsIdx !== -1 ? parseInt(args[maxEventsIdx + 1], 10) : 0,
  };

  const result = watchRun(runFolder, opts);
  if (result && !result.ok) {
    process.exit(1);
  }
  // If maxEvents was set, we're done synchronously
  if (opts.maxEvents > 0) {
    process.exit(0);
  }
  // Otherwise the interval keeps the process alive
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = { watchRun };
