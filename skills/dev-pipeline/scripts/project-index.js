#!/usr/bin/env node
'use strict';

/**
 * project-index.js — Deterministic read-only global index of all projects and backlog items.
 *
 * Scans projects/ directory, reads project.json and backlog/ items, detects
 * stop signals and stalled runs via linked run_folders. Never mutates the filesystem.
 *
 * Usage (via CLI):
 *   node project-index.js
 *
 * Or require() for programmatic use:
 *   const { buildProjectIndex } = require('./project-index.js');
 *   const result = buildProjectIndex();
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
const PROJECTS_DIR = path.join(WORKSPACE_ROOT, 'projects');
const STOP_FILENAME = '.stop';
const AUDIT_FILENAME = 'autonomous-audit.jsonl';

// ---------------------------------------------------------------------------
// Core index builder
// ---------------------------------------------------------------------------
function buildProjectIndex(options = {}) {
  const projectsDir = options.projectsDir || PROJECTS_DIR;
  const workspaceRoot = options.workspaceRoot || WORKSPACE_ROOT;
  const stallThresholdMs = options.stallThresholdMs || 30 * 60 * 1000;

  if (!fs.existsSync(projectsDir)) {
    return { ok: false, error: 'projects/ directory does not exist' };
  }

  const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort(); // ASC deterministic ordering

  const projects = [];
  const summary = {
    projects: 0,
    tasks_total: 0,
    todo: 0,
    in_progress: 0,
    blocked: 0,
    done: 0,
    stopped: 0,
    stalled: 0,
  };

  for (const projectId of projectDirs) {
    const projectDir = path.join(projectsDir, projectId);
    const projectJsonPath = path.join(projectDir, 'project.json');

    // Skip directories without project.json
    if (!fs.existsSync(projectJsonPath)) continue;

    try {
      JSON.parse(fs.readFileSync(projectJsonPath, 'utf8'));
    } catch {
      continue; // Invalid JSON — skip project
    }

    const backlogDir = path.join(projectDir, 'backlog');
    const backlogItems = [];
    const totals = { total: 0, todo: 0, in_progress: 0, blocked: 0, done: 0 };

    if (fs.existsSync(backlogDir)) {
      const files = fs.readdirSync(backlogDir)
        .filter((f) => f.endsWith('.json'))
        .sort(); // ASC

      for (const file of files) {
        try {
          const item = JSON.parse(fs.readFileSync(path.join(backlogDir, file), 'utf8'));
          const entry = buildBacklogEntry(item, workspaceRoot, stallThresholdMs);
          backlogItems.push(entry);

          totals.total++;
          if (entry.status === 'todo') totals.todo++;
          else if (entry.status === 'in_progress') totals.in_progress++;
          else if (entry.status === 'blocked' || entry.blocked) totals.blocked++;
          else if (entry.status === 'done') totals.done++;

          // Global summary
          summary.tasks_total++;
          if (entry.status === 'todo') summary.todo++;
          else if (entry.status === 'in_progress') summary.in_progress++;
          else if (entry.status === 'blocked' || entry.blocked) summary.blocked++;
          else if (entry.status === 'done') summary.done++;
          if (entry.stop_signal) summary.stopped++;
          if (entry.stalled) summary.stalled++;
        } catch {
          // Invalid JSON — skip item
        }
      }
    }

    projects.push({
      project_id: projectId,
      totals,
      backlog: backlogItems,
    });
    summary.projects++;
  }

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    projects,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Build a single backlog entry with run-level enrichment
// ---------------------------------------------------------------------------
function buildBacklogEntry(item, workspaceRoot, stallThresholdMs) {
  const entry = {
    id: item.id || '',
    type: item.type || 'task',
    status: item.status || 'todo',
    priority: item.priority || 'P3',
    owner_role: item.owner_role || '',
    parent_id: item.parent_id || null,
    depends_on: Array.isArray(item.depends_on) ? item.depends_on : [],
    run_folder: item.run_folder || null,
    stop_signal: false,
    blocked: item.status === 'blocked',
    stalled: false,
    last_summary: item.last_summary || null,
  };

  // Enrich from linked run folder
  if (entry.run_folder) {
    const runAbsDir = path.resolve(workspaceRoot, entry.run_folder);
    if (fs.existsSync(runAbsDir)) {
      // Stop signal
      entry.stop_signal = fs.existsSync(path.join(runAbsDir, STOP_FILENAME));

      // Blocked at run level
      const statusPath = path.join(runAbsDir, 'status.json');
      if (fs.existsSync(statusPath)) {
        try {
          const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
          if (status.blocked) entry.blocked = true;

          // Stalled detection: needs_artifacts with old audit
          if (
            status.last_autonomous_summary &&
            status.last_autonomous_summary.final_action === 'needs_artifacts'
          ) {
            const auditPath = path.join(runAbsDir, AUDIT_FILENAME);
            if (fs.existsSync(auditPath)) {
              try {
                const auditStat = fs.statSync(auditPath);
                const auditAgeMs = Date.now() - auditStat.mtimeMs;
                if (auditAgeMs > stallThresholdMs) {
                  entry.stalled = true;
                }
              } catch {
                // Cannot stat — not stalled
              }
            }
          }
        } catch {
          // Invalid status.json
        }
      }
    }
  }

  return entry;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
  const result = buildProjectIndex();
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
module.exports = { buildProjectIndex };
