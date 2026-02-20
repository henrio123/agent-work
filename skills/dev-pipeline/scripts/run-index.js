#!/usr/bin/env node
'use strict';

/**
 * run-index.js — Deterministic read-only global index of all runs.
 *
 * Scans runs/ directory, reads each status.json, detects stop signals
 * and audit logs, computes summary counts. Never mutates the filesystem.
 *
 * Usage (via CLI):
 *   node run-index.js
 *
 * Or require() for programmatic use:
 *   const { buildIndex } = require('./run-index.js');
 *   const result = buildIndex();
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
const RUNS_DIR = path.join(WORKSPACE_ROOT, 'runs');
const AUDIT_FILENAME = 'autonomous-audit.jsonl';
const STOP_FILENAME = '.stop';

// ---------------------------------------------------------------------------
// Core index builder
// ---------------------------------------------------------------------------
function buildIndex(options = {}) {
  const runsDir = options.runsDir || RUNS_DIR;

  if (!fs.existsSync(runsDir)) {
    return { ok: false, error: 'runs/ directory does not exist' };
  }

  const entries = fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort(); // ASC deterministic ordering

  const runs = [];
  const summary = { total: 0, blocked: 0, needs_artifacts: 0, done: 0, stopped: 0 };

  for (const folderName of entries) {
    const absDir = path.join(runsDir, folderName);
    const runFolder = `runs/${folderName}`;
    const statusPath = path.join(absDir, 'status.json');

    const entry = {
      run_folder: runFolder,
      has_status: false,
      current_stage: null,
      blocked: false,
      blocked_reason: null,
      stop_signal: fs.existsSync(path.join(absDir, STOP_FILENAME)),
      has_audit_log: fs.existsSync(path.join(absDir, AUDIT_FILENAME)),
      last_autonomous_run_at: null,
      last_autonomous_summary: null,
      stalled: false,
    };

    if (fs.existsSync(statusPath)) {
      try {
        const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
        entry.has_status = true;
        entry.current_stage = status.current_stage || null;
        entry.blocked = !!status.blocked;
        entry.blocked_reason = status.blocked_reason || null;
        entry.last_autonomous_run_at = status.last_autonomous_run_at || null;
        entry.last_autonomous_summary = status.last_autonomous_summary || null;

        // Detect stalled: needs_artifacts with no recent audit activity
        if (
          entry.last_autonomous_summary &&
          entry.last_autonomous_summary.final_action === 'needs_artifacts' &&
          entry.has_audit_log
        ) {
          try {
            const auditStat = fs.statSync(path.join(absDir, AUDIT_FILENAME));
            const auditAgeMs = Date.now() - auditStat.mtimeMs;
            const stallThresholdMs = options.stallThresholdMs || 30 * 60 * 1000; // 30 min default
            if (auditAgeMs > stallThresholdMs) {
              entry.stalled = true;
            }
          } catch {
            // Cannot stat audit file — not stalled
          }
        }
      } catch {
        // Invalid JSON — leave defaults
      }
    }

    runs.push(entry);
    summary.total++;
    if (entry.blocked) summary.blocked++;
    if (entry.last_autonomous_summary && entry.last_autonomous_summary.final_action === 'needs_artifacts') {
      summary.needs_artifacts++;
    }
    if (entry.current_stage === 'done') summary.done++;
    if (entry.stop_signal) summary.stopped++;
  }

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    runs,
    summary,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
  const result = buildIndex();
  if (!result.ok) {
    process.stderr.write(JSON.stringify(result) + '\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = { buildIndex };
