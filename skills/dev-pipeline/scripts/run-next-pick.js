#!/usr/bin/env node
'use strict';

/**
 * run-next-pick.js — Deterministic picker for the next eligible run.
 *
 * Uses run-index to enumerate all runs, then applies priority rules
 * to select the single best candidate. Never mutates the filesystem.
 *
 * Priority buckets (highest first):
 *   1. needs_task_pack  — intake stage, needs task pack generation
 *   2. needs_artifacts  — waiting for agent to produce artifacts
 *   3. other            — any non-done, non-blocked, non-stopped stage
 *
 * Within each bucket, earliest run_folder ASC wins.
 *
 * Skips: stopped, blocked, done runs.
 *
 * Usage (via CLI):
 *   node run-next-pick.js
 *
 * Or require() for programmatic use:
 *   const { pickNextRun } = require('./run-next-pick.js');
 *   const result = pickNextRun();
 */

const path = require('node:path');
const { buildIndex } = require(path.resolve(__dirname, 'run-index.js'));

// ---------------------------------------------------------------------------
// Priority classification
// ---------------------------------------------------------------------------
function classifyRun(run) {
  if (!run.has_status) return null;
  if (run.stop_signal) return null;
  if (run.blocked) return null;
  if (run.current_stage === 'done') return null;

  // Check last autonomous summary for action hint
  const lastAction = run.last_autonomous_summary
    ? run.last_autonomous_summary.final_action
    : null;

  // Intake or task-pack-generated without task pack yet
  if (run.current_stage === 'intake' || run.current_stage === 'task-pack-generated') {
    return 'needs_task_pack';
  }

  // If last action was needs_artifacts, or if run is in a role stage
  if (lastAction === 'needs_artifacts') {
    return 'needs_artifacts';
  }

  // Any other active stage — still eligible, lower priority
  return 'other';
}

const BUCKET_PRIORITY = { needs_task_pack: 0, needs_artifacts: 1, other: 2 };

// ---------------------------------------------------------------------------
// Core picker
// ---------------------------------------------------------------------------
function pickNextRun(options = {}) {
  const indexResult = buildIndex(options);
  if (!indexResult.ok) {
    return { ok: false, error: indexResult.error };
  }

  const candidates = [];
  for (const run of indexResult.runs) {
    const bucket = classifyRun(run);
    if (bucket === null) continue;
    candidates.push({ run, bucket, priority: BUCKET_PRIORITY[bucket] });
  }

  if (candidates.length === 0) {
    return {
      ok: true,
      action: 'no_eligible_runs',
      reason: 'all blocked or stopped or done',
    };
  }

  // Sort by priority ASC, then run_folder ASC (already sorted from index)
  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.run.run_folder.localeCompare(b.run.run_folder);
  });

  const best = candidates[0];
  return {
    ok: true,
    action: 'picked_run',
    run_folder: best.run.run_folder,
    reason: `priority: ${best.bucket}`,
    priority_bucket: best.bucket,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
  const result = pickNextRun();
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
module.exports = { pickNextRun, classifyRun };
