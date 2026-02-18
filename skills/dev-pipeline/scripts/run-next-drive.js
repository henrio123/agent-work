#!/usr/bin/env node
'use strict';

/**
 * run-next-drive.js — One-shot deterministic driver.
 *
 * 1. Picks the next eligible run via run-next-pick.js
 * 2. If a run is picked, invokes the autonomous runner once
 * 3. Returns a single JSON object with both results
 *
 * Never backgrounds anything, never loops, never creates run folders.
 *
 * Stdout is JSON-only by default (quiet mode). Use --verbose for human-readable
 * progress on stderr.
 *
 * Usage (via CLI):
 *   node run-next-drive.js [--max_steps N] [--max_agent_calls N] [--dry_run] [--audit_log] [--verbose]
 *
 * Or require() for programmatic use:
 *   const { driveOnce } = require('./run-next-drive.js');
 *   const result = driveOnce({ dryRun: true });
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = path.resolve(os.homedir(), 'dev', 'agent-work');

function safePath(p) {
  const resolved = path.resolve(WORKSPACE_ROOT, p);
  if (!resolved.startsWith(WORKSPACE_ROOT + path.sep) && resolved !== WORKSPACE_ROOT) {
    throw new Error(`Path outside workspace: ${resolved}`);
  }
  return resolved;
}

const { pickNextRun } = require(path.resolve(__dirname, 'run-next-pick.js'));
const { runAutonomous } = require(path.resolve(__dirname, 'autonomous-runner.js'));

// ---------------------------------------------------------------------------
// Core driver
// ---------------------------------------------------------------------------
function driveOnce(options = {}) {
  const maxSteps = options.maxSteps || 50;
  const maxAgentCalls = options.maxAgentCalls || 20;
  const dryRun = options.dryRun || false;
  const auditLog = options.auditLog || false;
  const quiet = options.quiet !== false; // quiet by default
  const agentAdapter = options.agentAdapter || undefined;

  // Step 1: Pick
  const pickResult = pickNextRun(options);
  if (!pickResult.ok) {
    return { ok: false, error: pickResult.error };
  }

  if (pickResult.action === 'no_eligible_runs') {
    return {
      ok: true,
      action: 'drive_skipped',
      picked: pickResult,
    };
  }

  const runFolder = pickResult.run_folder;

  // Step 2: Safety snapshot
  const runsDir = safePath('runs');
  const runsBefore = fs.existsSync(runsDir)
    ? fs.readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];

  // Step 3: Run autonomous
  const autoOpts = { maxSteps, maxAgentCalls, dryRun, auditLog, progress: !quiet };
  if (agentAdapter) autoOpts.agentAdapter = agentAdapter;
  const autoResult = runAutonomous(runFolder, autoOpts);

  // Step 4: Safety verify
  const runsAfter = fs.existsSync(runsDir)
    ? fs.readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];

  // Filter out _test_ dirs for comparison (tests create/delete them concurrently)
  const realBefore = runsBefore.filter((n) => !n.startsWith('_test_'));
  const realAfter = runsAfter.filter((n) => !n.startsWith('_test_'));
  if (JSON.stringify(realBefore) !== JSON.stringify(realAfter)) {
    return { ok: false, error: 'runs/ directory changed during drive execution' };
  }

  // Step 5: Dashboard summary (same as dev-pipeline.js CLI)
  const resolvedFolder = safePath(runFolder);
  try {
    const statusPath = path.join(resolvedFolder, 'status.json');
    if (fs.existsSync(statusPath)) {
      const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      status.last_autonomous_run_at = new Date().toISOString();
      status.last_autonomous_summary = {
        final_action: autoResult.final_action,
        steps_run: autoResult.steps_run,
        agent_calls: autoResult.agent_calls,
        artifacts_written: autoResult.artifacts_written,
      };
      fs.writeFileSync(statusPath, JSON.stringify(status, null, 2) + '\n', 'utf8');
    }
  } catch {
    // Non-fatal
  }

  return {
    ok: true,
    action: 'drive_complete',
    picked: pickResult,
    autonomous: autoResult,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);

  const maxStepsIdx = args.indexOf('--max_steps');
  const maxAgentIdx = args.indexOf('--max_agent_calls');

  const verbose = args.includes('--verbose');
  const opts = {
    maxSteps: maxStepsIdx !== -1 ? parseInt(args[maxStepsIdx + 1], 10) : 50,
    maxAgentCalls: maxAgentIdx !== -1 ? parseInt(args[maxAgentIdx + 1], 10) : 20,
    dryRun: args.includes('--dry_run'),
    auditLog: args.includes('--audit_log') || process.env.DP_AUDIT_LOG === '1',
    quiet: !verbose,
  };

  const result = driveOnce(opts);
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
module.exports = { driveOnce };
