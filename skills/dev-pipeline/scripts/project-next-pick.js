#!/usr/bin/env node
'use strict';

/**
 * project-next-pick.js — Deterministic picker for the next eligible backlog item.
 *
 * Uses project-index to enumerate all projects and backlog items, then applies
 * priority rules to select the single best candidate. Never mutates the filesystem.
 *
 * Ordering:
 *   1. Projects sorted by project_id ASC
 *   2. Within each project, backlog items sorted by:
 *      a. status rank: in_progress > todo > blocked > done
 *      b. priority rank: P0 > P1 > P2 > P3
 *      c. id ASC
 *
 * Eligibility: status in (todo, in_progress), not blocked, not stopped.
 *
 * Priority buckets (highest first):
 *   1. needs_task_pack — linked run in intake or no run yet (PM intake tasks)
 *   2. needs_artifacts — linked run has last_autonomous_summary.final_action === 'needs_artifacts'
 *   3. other — any other eligible task
 *
 * Usage (via CLI):
 *   node project-next-pick.js
 *
 * Or require() for programmatic use:
 *   const { pickNextTask } = require('./project-next-pick.js');
 *   const result = pickNextTask();
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
const { buildProjectIndex } = require(path.resolve(__dirname, 'project-index.js'));

const STATUS_RANK = { in_progress: 0, todo: 1, blocked: 2, done: 3 };
const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };
const BUCKET_PRIORITY = { ready_for_run_creation: 0, needs_task_pack: 1, needs_artifacts: 2, other: 3 };

// ---------------------------------------------------------------------------
// Check if a task pack exists for a given task
// ---------------------------------------------------------------------------
function hasTaskPack(projectId, taskId, workspaceRoot) {
  const taskPackPath = path.join(workspaceRoot, '.claw', 'task-packs', `${taskId}.json`);
  return fs.existsSync(taskPackPath);
}

// ---------------------------------------------------------------------------
// Classify a backlog entry into a priority bucket
// ---------------------------------------------------------------------------
function classifyTask(entry, workspaceRoot, projectId, siblingItems) {
  // Require owner_role
  if (!entry.owner_role || typeof entry.owner_role !== 'string' || entry.owner_role.trim() === '') {
    process.stderr.write(JSON.stringify({
      warning: 'skipped_no_owner_role',
      task_id: entry.id || '(unknown)',
      project_id: projectId || '(unknown)',
    }) + '\n');
    return null;
  }

  // Not eligible
  if (entry.status !== 'todo' && entry.status !== 'in_progress') return null;
  if (entry.blocked) return null;
  if (entry.stop_signal) return null;

  // Graph constraints (only when siblingItems are provided)
  if (siblingItems) {
    const siblingById = new Map();
    for (const s of siblingItems) siblingById.set(s.id, s);

    // Check depends_on: all dependencies must be done
    const deps = entry.depends_on || [];
    const unsatisfied = [];
    for (const depId of deps) {
      const dep = siblingById.get(depId);
      if (dep && dep.status !== 'done') {
        unsatisfied.push(depId);
      }
    }
    if (unsatisfied.length > 0) {
      process.stderr.write(JSON.stringify({
        warning: 'skipped_unsatisfied_deps',
        task_id: entry.id || '(unknown)',
        project_id: projectId || '(unknown)',
        blocking_deps: unsatisfied,
      }) + '\n');
      return null;
    }

    // Check parent: if parent epic is blocked, child is ineligible
    if (entry.parent_id) {
      const parent = siblingById.get(entry.parent_id);
      if (parent && (parent.status === 'blocked' || parent.blocked)) {
        process.stderr.write(JSON.stringify({
          warning: 'skipped_parent_blocked',
          task_id: entry.id || '(unknown)',
          project_id: projectId || '(unknown)',
          parent_id: entry.parent_id,
        }) + '\n');
        return null;
      }
    }
  }

  const pid = projectId || entry.project_id || '';
  const tid = entry.id || '';
  const packExists = pid && tid && hasTaskPack(pid, tid, workspaceRoot);

  // Check linked run for classification
  if (entry.run_folder) {
    const runAbsDir = path.resolve(workspaceRoot, entry.run_folder);
    const statusPath = path.join(runAbsDir, 'status.json');
    if (fs.existsSync(statusPath)) {
      try {
        const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
        const stage = status.current_stage;

        // Intake or task-pack-generated → needs task pack (or ready if pack exists)
        if (stage === 'intake' || stage === 'task-pack-generated') {
          return packExists ? 'ready_for_run_creation' : 'needs_task_pack';
        }

        // Last autonomous action was needs_artifacts
        if (
          status.last_autonomous_summary &&
          status.last_autonomous_summary.final_action === 'needs_artifacts'
        ) {
          return 'needs_artifacts';
        }

        // Done at run level means task is done too (skip it)
        if (stage === 'done') return null;
      } catch {
        // Cannot read status — treat as other
      }
    }
  } else {
    // No run folder yet — ready for run creation if task pack exists, else needs task pack
    return packExists ? 'ready_for_run_creation' : 'needs_task_pack';
  }

  return 'other';
}

// ---------------------------------------------------------------------------
// Core picker
// ---------------------------------------------------------------------------
function pickNextTask(options = {}) {
  const workspaceRoot = options.workspaceRoot || WORKSPACE_ROOT;
  const indexResult = buildProjectIndex(options);
  if (!indexResult.ok) {
    return { ok: false, error: indexResult.error };
  }

  const candidates = [];

  for (const project of indexResult.projects) {
    for (const entry of project.backlog) {
      const bucket = classifyTask(entry, workspaceRoot, project.project_id, project.backlog);
      if (bucket === null) continue;
      candidates.push({
        project_id: project.project_id,
        entry,
        bucket,
        bucketPriority: BUCKET_PRIORITY[bucket],
        statusRank: STATUS_RANK[entry.status] ?? 3,
        priorityRank: PRIORITY_RANK[entry.priority] ?? 3,
      });
    }
  }

  if (candidates.length === 0) {
    return {
      ok: true,
      action: 'no_eligible_tasks',
      reason: 'all tasks blocked, stopped, or done',
    };
  }

  // Sort: bucket priority ASC, status rank ASC, priority rank ASC, project_id ASC, id ASC
  candidates.sort((a, b) => {
    if (a.bucketPriority !== b.bucketPriority) return a.bucketPriority - b.bucketPriority;
    if (a.statusRank !== b.statusRank) return a.statusRank - b.statusRank;
    if (a.priorityRank !== b.priorityRank) return a.priorityRank - b.priorityRank;
    if (a.project_id !== b.project_id) return a.project_id.localeCompare(b.project_id);
    return a.entry.id.localeCompare(b.entry.id);
  });

  const best = candidates[0];
  return {
    ok: true,
    action: 'picked_task',
    project_id: best.project_id,
    task_id: best.entry.id,
    run_folder: best.entry.run_folder,
    reason: `priority: ${best.bucket}, status: ${best.entry.status}, priority: ${best.entry.priority}`,
    priority_bucket: best.bucket,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
  const result = pickNextTask();
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
module.exports = { pickNextTask, classifyTask };
