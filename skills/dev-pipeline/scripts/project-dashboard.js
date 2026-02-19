#!/usr/bin/env node
'use strict';

/**
 * project-dashboard.js — Deterministic read-only dashboard of project state.
 *
 * Aggregates project-index data and enriches each backlog item with computed
 * fields for priority bucket, run stage, and task pack status. Never mutates
 * the filesystem.
 *
 * Usage (via CLI):
 *   node project-dashboard.js
 *
 * Or require() for programmatic use:
 *   const { buildDashboard } = require('./project-dashboard.js');
 *   const result = buildDashboard();
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = path.resolve(os.homedir(), 'dev', 'agent-work');
const PROJECTS_DIR = path.join(WORKSPACE_ROOT, 'projects');
const STOP_FILENAME = '.stop';
const AUDIT_FILENAME = 'autonomous-audit.jsonl';

// Agent state for role resolution (lazy-loaded)
let _agentStateModule = null;
function getAgentStateModule() {
  if (!_agentStateModule) {
    _agentStateModule = require(path.resolve(__dirname, 'agent-state.js'));
  }
  return _agentStateModule;
}

function sortObjectKeys(obj) {
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key];
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// Core dashboard builder
// ---------------------------------------------------------------------------
function buildDashboard(options = {}) {
  const projectsDir = options.projectsDir || PROJECTS_DIR;
  const workspaceRoot = options.workspaceRoot || WORKSPACE_ROOT;
  const stallThresholdMs = options.stallThresholdMs || 30 * 60 * 1000;

  if (!fs.existsSync(projectsDir)) {
    return { ok: false, error: 'projects/ directory does not exist' };
  }

  const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

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
    needs_task_pack: 0,
    needs_artifacts: 0,
    workload_summary: { runs_per_role: {}, stages_per_role: {} },
  };

  for (const projectId of projectDirs) {
    const projectDir = path.join(projectsDir, projectId);
    const projectJsonPath = path.join(projectDir, 'project.json');

    if (!fs.existsSync(projectJsonPath)) continue;

    let projectMeta;
    try {
      projectMeta = JSON.parse(fs.readFileSync(projectJsonPath, 'utf8'));
    } catch {
      continue;
    }

    const backlogDir = path.join(projectDir, 'backlog');
    const backlogItems = [];
    const totals = { total: 0, todo: 0, in_progress: 0, blocked: 0, done: 0 };

    if (fs.existsSync(backlogDir)) {
      const files = fs.readdirSync(backlogDir)
        .filter((f) => f.endsWith('.json'))
        .sort();

      for (const file of files) {
        try {
          const item = JSON.parse(fs.readFileSync(path.join(backlogDir, file), 'utf8'));
          const entry = buildDashboardEntry(item, projectId, workspaceRoot, stallThresholdMs);
          backlogItems.push(entry);

          totals.total++;
          if (entry.status === 'todo') totals.todo++;
          else if (entry.status === 'in_progress') totals.in_progress++;
          else if (entry.status === 'blocked') totals.blocked++;
          else if (entry.status === 'done') totals.done++;

          summary.tasks_total++;
          if (entry.status === 'todo') summary.todo++;
          else if (entry.status === 'in_progress') summary.in_progress++;
          else if (entry.status === 'blocked') summary.blocked++;
          else if (entry.status === 'done') summary.done++;
          if (entry.run_stop) summary.stopped++;
          if (entry.stalled) summary.stalled++;
          if (entry.needs_task_pack) summary.needs_task_pack++;
          if (entry.needs_artifacts) summary.needs_artifacts++;
        } catch {
          // Invalid JSON — skip item
        }
      }
    }

    // Build per-project workload from linked runs
    const agentStats = {}; // agent_id -> { runs_responsible, stages_driven, active_runs }
    const roleCache = options._roleCache || {};
    const agentsDir = options.agentsDir || null;

    for (const entry of backlogItems) {
      if (!entry.run_folder) continue;
      const runAbsDir = path.resolve(workspaceRoot, entry.run_folder);
      const statusPath = path.join(runAbsDir, 'status.json');
      if (!fs.existsSync(statusPath)) continue;

      let status;
      try {
        status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      } catch { continue; }

      // Count responsible_agent
      const ra = status.responsible_agent;
      if (ra && typeof ra === 'string') {
        if (!agentStats[ra]) agentStats[ra] = { runs_responsible: 0, stages_driven: 0, active_runs: 0 };
        agentStats[ra].runs_responsible++;
        if (status.current_stage !== 'done') agentStats[ra].active_runs++;
      }

      // Count stage_history agent_ids
      if (Array.isArray(status.stage_history)) {
        for (const sh of status.stage_history) {
          const aid = sh.agent_id;
          if (aid && typeof aid === 'string') {
            if (!agentStats[aid]) agentStats[aid] = { runs_responsible: 0, stages_driven: 0, active_runs: 0 };
            agentStats[aid].stages_driven++;
          }
        }
      }
    }

    // Resolve roles and build workload_by_agent
    const workloadByAgent = Object.keys(agentStats).sort().map((agentId) => {
      if (!(agentId in roleCache)) {
        try {
          const agentMod = getAgentStateModule();
          const opts = agentsDir ? { agentsDir } : {};
          const state = agentMod.readAgentState(agentId, opts);
          roleCache[agentId] = state ? state.role : 'unknown';
        } catch {
          roleCache[agentId] = 'unknown';
        }
      }
      const role = roleCache[agentId];
      const stats = agentStats[agentId];

      // Aggregate into top-level summary
      summary.workload_summary.runs_per_role[role] =
        (summary.workload_summary.runs_per_role[role] || 0) + stats.runs_responsible;
      summary.workload_summary.stages_per_role[role] =
        (summary.workload_summary.stages_per_role[role] || 0) + stats.stages_driven;

      return {
        agent_id: agentId,
        role,
        runs_responsible: stats.runs_responsible,
        stages_driven: stats.stages_driven,
        active_runs: stats.active_runs,
      };
    });

    projects.push({
      project_id: projectId,
      title: projectMeta.title || projectId,
      description: projectMeta.description || '',
      totals,
      backlog: backlogItems,
      workload_by_agent: workloadByAgent,
    });
    summary.projects++;
  }

  // Ensure deterministic key ordering in workload_summary
  summary.workload_summary.runs_per_role = sortObjectKeys(summary.workload_summary.runs_per_role);
  summary.workload_summary.stages_per_role = sortObjectKeys(summary.workload_summary.stages_per_role);

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    projects,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Build a single dashboard entry with full enrichment
// ---------------------------------------------------------------------------
function buildDashboardEntry(item, projectId, workspaceRoot, stallThresholdMs) {
  const entry = {
    id: item.id || '',
    type: item.type || 'task',
    status: item.status || 'todo',
    priority: item.priority || 'P3',
    owner_role: item.owner_role || 'DEV',
    depends_on: item.depends_on || [],
    tags: item.tags || [],
    run_folder: item.run_folder || null,
    priority_bucket: null,
    run_stage: null,
    run_blocked: false,
    run_stop: false,
    needs_task_pack: false,
    needs_artifacts: false,
    stalled: false,
  };

  // Check for task pack existence
  const taskPackPath = path.join(workspaceRoot, 'projects', projectId, 'task-packs', `${entry.id}.json`);
  const hasTaskPack = fs.existsSync(taskPackPath);

  // Enrich from linked run folder
  if (entry.run_folder) {
    const runAbsDir = path.resolve(workspaceRoot, entry.run_folder);
    if (fs.existsSync(runAbsDir)) {
      entry.run_stop = fs.existsSync(path.join(runAbsDir, STOP_FILENAME));

      const statusPath = path.join(runAbsDir, 'status.json');
      if (fs.existsSync(statusPath)) {
        try {
          const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
          entry.run_stage = status.current_stage || null;
          entry.run_blocked = !!status.blocked;

          // Classify priority bucket
          if (status.current_stage === 'intake' || status.current_stage === 'task-pack-generated') {
            entry.needs_task_pack = !hasTaskPack;
            entry.priority_bucket = hasTaskPack ? 'ready_for_run_creation' : 'needs_task_pack';
          } else if (
            status.last_autonomous_summary &&
            status.last_autonomous_summary.final_action === 'needs_artifacts'
          ) {
            entry.needs_artifacts = true;
            entry.priority_bucket = 'needs_artifacts';
          } else if (status.current_stage === 'done') {
            entry.priority_bucket = null;
          } else {
            entry.priority_bucket = 'other';
          }

          // Stalled detection
          if (
            status.last_autonomous_summary &&
            status.last_autonomous_summary.final_action === 'needs_artifacts'
          ) {
            const auditPath = path.join(runAbsDir, AUDIT_FILENAME);
            if (fs.existsSync(auditPath)) {
              try {
                const auditStat = fs.statSync(auditPath);
                if (Date.now() - auditStat.mtimeMs > stallThresholdMs) {
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
  } else {
    // No run folder — needs task pack if eligible
    if (entry.status === 'todo' || entry.status === 'in_progress') {
      entry.needs_task_pack = !hasTaskPack;
      entry.priority_bucket = hasTaskPack ? 'ready_for_run_creation' : 'needs_task_pack';
    }
  }

  return entry;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
  const result = buildDashboard();
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
module.exports = { buildDashboard };
