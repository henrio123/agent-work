#!/usr/bin/env node
'use strict';

/**
 * project-drive-loop.js — Adaptive drive loop with post-run hooks.
 *
 * Replaces the static bash drive loop with a JS module that supports:
 *   - Adaptive sleep: faster after work, slower after idle, longest after errors
 *   - Post-run hooks: automatically triggered after each drive
 *   - Project filtering: --project <id> restricts to a single project
 *   - Stop conditions: .stop file, max iterations, max consecutive idle, SIGTERM/SIGINT
 *
 * CLI:
 *   node project-drive-loop.js [--max N] [--sleep N] [--project <id>] [--max_idle N]
 *
 * Exports:
 *   driveLoop({ workspaceRoot, maxIterations, sleepMs, projectId, hooks, maxConsecutiveIdle }) → result
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');

// Adaptive sleep constants
const MIN_SLEEP_MS = 1000;
const DEFAULT_SLEEP_MS = 5000;
const MAX_IDLE_SLEEP_MS = 30000;
const ERROR_SLEEP_MS = 60000;
const BACKOFF_FACTOR = 2;

// Default stop conditions
const DEFAULT_MAX_ITERATIONS = 100;
const DEFAULT_MAX_CONSECUTIVE_IDLE = 10;

// ---------------------------------------------------------------------------
// Stop file check
// ---------------------------------------------------------------------------
function hasStopFile(workspaceRoot) {
  return fs.existsSync(path.join(workspaceRoot, '.stop'));
}

// ---------------------------------------------------------------------------
// Synchronous sleep
// ---------------------------------------------------------------------------
function sleepSync(ms) {
  if (ms <= 0) return;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy wait — intentional for synchronous loop
    // In production, this would be replaced with actual async sleep
  }
}

// ---------------------------------------------------------------------------
// Adaptive sleep calculation
// ---------------------------------------------------------------------------
function computeNextSleep(lastAction, currentSleepMs) {
  if (lastAction === 'drive_created_run' || lastAction === 'drive_complete') {
    // Work was done — speed up
    return MIN_SLEEP_MS;
  }
  if (lastAction === 'drive_skipped') {
    // No work — back off exponentially up to max
    return Math.min(currentSleepMs * BACKOFF_FACTOR, MAX_IDLE_SLEEP_MS);
  }
  if (lastAction === 'error') {
    // Error — wait longer
    return ERROR_SLEEP_MS;
  }
  return currentSleepMs;
}

// ---------------------------------------------------------------------------
// Core loop
// ---------------------------------------------------------------------------
function driveLoop(options = {}) {
  const workspaceRoot = options.workspaceRoot || WORKSPACE_ROOT;
  const maxIterations = options.maxIterations || DEFAULT_MAX_ITERATIONS;
  const initialSleepMs = options.sleepMs || DEFAULT_SLEEP_MS;
  const projectId = options.projectId || null;
  const hooks = options.hooks || [];
  const maxConsecutiveIdle = options.maxConsecutiveIdle || DEFAULT_MAX_CONSECUTIVE_IDLE;
  const agentAdapter = options.agentAdapter || undefined;
  const dryRun = options.dryRun || false;

  // Lazy-load drive module
  const { projectDriveOnce } = require(path.resolve(__dirname, 'project-next-drive.js'));

  let iterations = 0;
  let runsCreated = 0;
  let drivesAttempted = 0;
  let consecutiveIdle = 0;
  let currentSleepMs = initialSleepMs;
  let stopReason = 'max_iterations';
  let signalReceived = false;
  let hooksRun = 0;
  let hooksFailed = 0;

  // Signal handlers
  const signalHandler = () => { signalReceived = true; };
  process.on('SIGTERM', signalHandler);
  process.on('SIGINT', signalHandler);

  try {
    for (let i = 0; i < maxIterations; i++) {
      // Check stop conditions
      if (signalReceived) {
        stopReason = 'signal';
        break;
      }

      if (hasStopFile(workspaceRoot)) {
        stopReason = 'stop_file';
        break;
      }

      if (consecutiveIdle >= maxConsecutiveIdle) {
        stopReason = 'max_consecutive_idle';
        break;
      }

      iterations++;
      drivesAttempted++;

      // Drive once
      let driveResult;
      try {
        const driveOpts = { workspaceRoot, dryRun };
        if (projectId) driveOpts.projectId = projectId;
        if (agentAdapter) driveOpts.agentAdapter = agentAdapter;
        driveResult = projectDriveOnce(driveOpts);
      } catch (e) {
        driveResult = { ok: false, action: 'error', error: e.message };
      }

      if (!driveResult.ok) {
        stopReason = 'drive_error';
        currentSleepMs = computeNextSleep('error', currentSleepMs);
        break;
      }

      const action = driveResult.action;

      if (action === 'drive_created_run') {
        runsCreated++;
        consecutiveIdle = 0;
      } else if (action === 'drive_complete') {
        consecutiveIdle = 0;
      } else if (action === 'drive_skipped') {
        consecutiveIdle++;
        if (consecutiveIdle >= maxConsecutiveIdle) {
          stopReason = 'max_consecutive_idle';
          currentSleepMs = computeNextSleep(action, currentSleepMs);
          break;
        }
        // On first idle, stop immediately for no_eligible_work
        // (matches bash loop behavior)
        stopReason = 'no_eligible_work';
        currentSleepMs = computeNextSleep(action, currentSleepMs);
        break;
      }

      // Run post-drive hooks (try/catch wrapped, non-fatal)
      for (const hook of hooks) {
        try {
          hook({ workspaceRoot, driveResult, iteration: iterations });
          hooksRun++;
        } catch {
          hooksRun++;
          hooksFailed++;
        }
      }

      // Adaptive sleep
      currentSleepMs = computeNextSleep(action, currentSleepMs);

      // Sleep between iterations (skip on last iteration)
      if (i < maxIterations - 1) {
        sleepSync(currentSleepMs);
      }
    }
  } finally {
    process.removeListener('SIGTERM', signalHandler);
    process.removeListener('SIGINT', signalHandler);
  }

  return {
    ok: true,
    iterations,
    runs_created: runsCreated,
    drives_attempted: drivesAttempted,
    stop_reason: stopReason,
    hook_results_summary: {
      hooks_run: hooksRun,
      hooks_failed: hooksFailed,
    },
    project_filter: projectId,
    last_sleep_ms: currentSleepMs,
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

  const maxIterations = getArg('max') ? parseInt(getArg('max'), 10) : DEFAULT_MAX_ITERATIONS;
  const sleepMs = getArg('sleep') ? parseInt(getArg('sleep'), 10) * 1000 : DEFAULT_SLEEP_MS;
  const projectId = getArg('project') || null;
  const maxIdle = getArg('max_idle') ? parseInt(getArg('max_idle'), 10) : DEFAULT_MAX_CONSECUTIVE_IDLE;

  const result = driveLoop({ maxIterations, sleepMs, projectId, maxConsecutiveIdle: maxIdle });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = { driveLoop, computeNextSleep };
