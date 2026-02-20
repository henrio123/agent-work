#!/usr/bin/env node
'use strict';

/**
 * backlog-update-status.js — Canonical tool for transitioning backlog item status.
 *
 * Enforces the epic completion guard: an epic cannot be marked done if any
 * of its children have a status other than done.
 *
 * Usage (CLI):
 *   node backlog-update-status.js <project_id> <item_id> <new_status>
 *   node backlog-update-status.js <project_id> <item_id> <new_status> --projects_dir <path>
 *
 * Programmatic:
 *   const { updateBacklogStatus } = require('./backlog-update-status.js');
 *   const result = updateBacklogStatus('my-project', 'TASK-1', 'done', { projectsDir });
 *   // { ok: true, id, old_status, new_status } or { ok: false, error }
 *
 * Stdout: JSON result. Stderr: JSON errors (exit 1).
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
const PROJECTS_DIR = path.join(WORKSPACE_ROOT, 'projects');

const VALID_STATUSES = ['todo', 'in_progress', 'blocked', 'done'];

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------
function updateBacklogStatus(projectId, itemId, newStatus, options) {
  const projectsDir = options && options.projectsDir ? options.projectsDir : PROJECTS_DIR;

  if (!VALID_STATUSES.includes(newStatus)) {
    return { ok: false, error: `Invalid status '${newStatus}'. Must be one of: ${VALID_STATUSES.join(', ')}` };
  }

  const backlogDir = path.join(projectsDir, projectId, 'backlog');
  if (!fs.existsSync(backlogDir)) {
    return { ok: false, error: `Backlog directory not found for project: ${projectId}` };
  }

  // Find the target item
  const files = fs.readdirSync(backlogDir).filter(f => f.endsWith('.json'));
  let targetPath = null;
  let targetItem = null;

  for (const file of files) {
    const filePath = path.join(backlogDir, file);
    try {
      const item = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (item.id === itemId) {
        targetPath = filePath;
        targetItem = item;
        break;
      }
    } catch {
      // Skip invalid JSON
    }
  }

  if (!targetItem) {
    return { ok: false, error: `Item '${itemId}' not found in project '${projectId}'` };
  }

  const oldStatus = targetItem.status;

  // Epic completion guard: reject done transition for epics with non-done children
  if (newStatus === 'done' && targetItem.type === 'epic') {
    const allItems = [];
    for (const file of files) {
      try {
        allItems.push(JSON.parse(fs.readFileSync(path.join(backlogDir, file), 'utf8')));
      } catch { /* skip */ }
    }

    const children = allItems.filter(i => i.parent_id === itemId);
    const incomplete = children.filter(c => c.status !== 'done');

    if (incomplete.length > 0) {
      return {
        ok: false,
        error: `Cannot mark epic '${itemId}' as done: ${incomplete.length} child(ren) not done`,
        incomplete_children: incomplete.map(c => ({ id: c.id, status: c.status })),
      };
    }
  }

  // Write the transition
  targetItem.status = newStatus;
  targetItem.updated_at = new Date().toISOString();
  fs.writeFileSync(targetPath, JSON.stringify(targetItem, null, 2) + '\n', 'utf8');

  return {
    ok: true,
    id: itemId,
    project_id: projectId,
    old_status: oldStatus,
    new_status: newStatus,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);

  const projDirIdx = args.indexOf('--projects_dir');
  let projectsDir = PROJECTS_DIR;
  if (projDirIdx !== -1) {
    projectsDir = args[projDirIdx + 1] || PROJECTS_DIR;
    args.splice(projDirIdx, 2);
  }

  const projectId = args[0];
  const itemId = args[1];
  const newStatus = args[2];

  if (!projectId || !itemId || !newStatus) {
    process.stderr.write(JSON.stringify({
      ok: false,
      error: 'Usage: backlog-update-status <project_id> <item_id> <new_status>',
    }, null, 2) + '\n');
    process.exit(1);
  }

  const result = updateBacklogStatus(projectId, itemId, newStatus, { projectsDir });
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
module.exports = { updateBacklogStatus };
