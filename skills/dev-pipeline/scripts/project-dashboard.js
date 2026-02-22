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

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
const STOP_FILENAME = '.stop';
const AUDIT_FILENAME = 'autonomous-audit.jsonl';

// Lazy-loaded modules
let _agentStateModule = null;
let _artifactIndexModule = null;
let _agentMemoryModule = null;
let _agentPerfModule = null;
let _workflowSuggestModule = null;
let _gapScannerModule = null;

function getArtifactIndexModule() {
  if (!_artifactIndexModule) {
    _artifactIndexModule = require(path.resolve(__dirname, 'artifact-index.js'));
  }
  return _artifactIndexModule;
}

function getAgentMemoryModule() {
  if (!_agentMemoryModule) {
    _agentMemoryModule = require(path.resolve(__dirname, 'agent-memory.js'));
  }
  return _agentMemoryModule;
}

function getAgentPerfModule() {
  if (!_agentPerfModule) {
    try { _agentPerfModule = require(path.resolve(__dirname, 'agent-performance.js')); }
    catch { _agentPerfModule = null; }
  }
  return _agentPerfModule;
}

function getWorkflowSuggestModule() {
  if (!_workflowSuggestModule) {
    try { _workflowSuggestModule = require(path.resolve(__dirname, 'workflow-suggest.js')); }
    catch { _workflowSuggestModule = null; }
  }
  return _workflowSuggestModule;
}

function getGapScannerModule() {
  if (!_gapScannerModule) {
    try { _gapScannerModule = require(path.resolve(__dirname, 'gap-scanner.js')); }
    catch { _gapScannerModule = null; }
  }
  return _gapScannerModule;
}

// Agent state for role resolution (lazy-loaded)
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
  const workspaceRoot = options.workspaceRoot || WORKSPACE_ROOT;
  const clawRoot = path.join(workspaceRoot, '.claw');
  const backlogDir = options.backlogDir || path.join(clawRoot, 'backlog');
  const projectJsonPath = options.projectJsonPath || path.join(clawRoot, 'project.json');
  const stallThresholdMs = options.stallThresholdMs || 30 * 60 * 1000;

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
    performance_summary: { agents_tracked: 0, top_agent: null, avg_performance_score: null },
    workflow_suggestions_count: 0,
    pending_gaps_count: 0,
  };

  // Read single project from .claw/project.json
  if (!fs.existsSync(projectJsonPath)) {
    return { ok: true, generated_at: new Date().toISOString(), projects: [], summary };
  }

  let projectMeta;
  try {
    projectMeta = JSON.parse(fs.readFileSync(projectJsonPath, 'utf8'));
  } catch {
    return { ok: true, generated_at: new Date().toISOString(), projects: [], summary };
  }

  const projectId = projectMeta.project_id || 'unknown';
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

  // Enrich dependency chain fields (second pass over all items in project)
  enrichDependencyChain(backlogItems);

  // Build per-project workload from linked runs
  const agentStats = {};
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

    const ra = status.responsible_agent;
    if (ra && typeof ra === 'string') {
      if (!agentStats[ra]) agentStats[ra] = { runs_responsible: 0, stages_driven: 0, active_runs: 0 };
      agentStats[ra].runs_responsible++;
      if (status.current_stage !== 'done') agentStats[ra].active_runs++;
    }

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

  // Build knowledge state from artifact index and agent memory
  const knowledgeState = buildKnowledgeState(projectId, workspaceRoot);

  projects.push({
    project_id: projectId,
    title: projectMeta.title || projectId,
    description: projectMeta.description || '',
    totals,
    backlog: backlogItems,
    workload_by_agent: workloadByAgent,
    knowledge_state: knowledgeState,
  });
  summary.projects = 1;

  // Aggregate knowledge_summary from per-project knowledge_state
  summary.knowledge_summary = {
    total_artifacts: knowledgeState.total_artifacts,
    total_research_findings: knowledgeState.research_findings_count,
    total_memory_entries: knowledgeState.memory_entry_count,
    artifact_counts_by_type: { ...knowledgeState.artifact_counts_by_type },
  };

  // Ensure deterministic key ordering in workload_summary
  summary.workload_summary.runs_per_role = sortObjectKeys(summary.workload_summary.runs_per_role);
  summary.workload_summary.stages_per_role = sortObjectKeys(summary.workload_summary.stages_per_role);

  // Phase 4: performance summary, workflow suggestions, gap counts
  summary.performance_summary = { agents_tracked: 0, top_agent: null, avg_performance_score: null };
  summary.workflow_suggestions_count = 0;
  summary.pending_gaps_count = 0;

  try {
    const perfMod = getAgentPerfModule();
    if (perfMod) {
      const perf = perfMod.buildAgentPerformance({ workspaceRoot, projectId });
      if (perf.ok) {
        summary.performance_summary.agents_tracked = perf.agents.length;
        summary.performance_summary.top_agent = perf.recommended_agent;
        const scores = perf.agents.filter(a => a.performance_score !== null).map(a => a.performance_score);
        if (scores.length > 0) {
          summary.performance_summary.avg_performance_score = +(scores.reduce((s, v) => s + v, 0) / scores.length).toFixed(4);
        }
      }
    }
  } catch { /* Non-fatal */ }

  try {
    const wsMod = getWorkflowSuggestModule();
    if (wsMod) {
      const ws = wsMod.generateWorkflowSuggestions({ workspaceRoot, projectId });
      if (ws.ok) {
        summary.workflow_suggestions_count = ws.summary.total_suggestions;
      }
    }
  } catch { /* Non-fatal */ }

  try {
    const gapMod = getGapScannerModule();
    if (gapMod) {
      const gaps = gapMod.scanGaps({ workspaceRoot, projectId });
      if (gaps.ok) {
        summary.pending_gaps_count = gaps.summary.total_gaps;
      }
    }
  } catch { /* Non-fatal */ }

  // Phase 5: last self-evaluation, post-run hooks status, adaptive loop status
  summary.last_self_evaluation = null;
  summary.post_run_hooks_enabled = false;
  summary.adaptive_loop_status = 'unavailable';

  // Check for post-run hooks module availability
  try {
    require(path.resolve(__dirname, 'post-run-hooks.js'));
    summary.post_run_hooks_enabled = true;
  } catch { /* Not available */ }

  // Check for adaptive loop module availability
  try {
    require(path.resolve(__dirname, 'project-drive-loop.js'));
    summary.adaptive_loop_status = 'available';
  } catch { /* Not available */ }

  // Phase 6: template enrichment, artifact context, retry loop, auto-patch
  summary.template_enrichment_enabled = false;
  summary.artifact_context_enabled = false;
  summary.retry_loop_enabled = false;
  summary.auto_patch_enabled = false;

  try {
    const apb = require(path.resolve(__dirname, 'adapter-prompt-builder.js'));
    if (typeof apb.buildAdapterPrompt === 'function') summary.template_enrichment_enabled = true;
    if (typeof apb.buildArtifactContext === 'function') summary.artifact_context_enabled = true;
    if (typeof apb.buildRetryPrompt === 'function') summary.retry_loop_enabled = true;
  } catch { /* Not available */ }

  try {
    const adp = require(path.resolve(__dirname, 'apply-dev-patch.js'));
    if (typeof adp.applyDevPatch === 'function') summary.auto_patch_enabled = true;
  } catch { /* Not available */ }

  // Find last self-evaluation from agent memory
  try {
    const memMod = getAgentMemoryModule();
    const agentsDir = path.join(workspaceRoot, '.claw', 'agents');
    if (fs.existsSync(agentsDir)) {
      const agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);

      let latestEval = null;
      let latestEvalAgent = null;

      for (const agentId of agentDirs) {
        try {
          const mem = memMod.readMemory({
            agentId,
            filterProject: projectId,
            filterType: 'evaluation',
            workspaceRoot,
            limit: 1,
          });
          if (mem.ok && mem.entries && mem.entries.length > 0) {
            const entry = mem.entries[mem.entries.length - 1];
            if (!latestEval || entry.timestamp > latestEval.timestamp) {
              latestEval = entry;
              latestEvalAgent = agentId;
            }
          }
        } catch { /* Skip */ }
      }

      if (latestEval) {
        // Parse quality score from content like "Self-evaluation: score=0.85, ..."
        let qualityScore = null;
        const scoreMatch = latestEval.content && latestEval.content.match(/score=([\d.]+)/);
        if (scoreMatch) {
          qualityScore = parseFloat(scoreMatch[1]);
          if (isNaN(qualityScore)) qualityScore = null;
        }

        summary.last_self_evaluation = {
          quality_score: qualityScore,
          run_folder: latestEval.run_id || '',
          agent_id: latestEvalAgent,
        };
      }
    }
  } catch { /* Non-fatal */ }

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    projects,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Build knowledge state for a project
// ---------------------------------------------------------------------------
function buildKnowledgeState(projectId, workspaceRoot) {
  const result = {
    artifact_counts_by_type: {},
    research_findings_count: 0,
    memory_entry_count: 0,
    total_artifacts: 0,
  };

  // 1. Scan artifact index for this project
  try {
    const indexMod = getArtifactIndexModule();
    const index = indexMod.buildArtifactIndex({
      workspaceRoot,
      filterProject: projectId,
    });
    if (index.ok) {
      result.total_artifacts = index.artifacts.length;
      for (const art of index.artifacts) {
        const t = art.semantic_type || 'unknown';
        result.artifact_counts_by_type[t] = (result.artifact_counts_by_type[t] || 0) + 1;
      }
    }
  } catch {
    // Non-fatal — missing index module or no runs
  }

  // 2. Count research findings (artifacts with type 18-research-findings.json)
  try {
    const runsDir = path.join(workspaceRoot, '.claw', 'runs');
    if (fs.existsSync(runsDir)) {
      const runDirs = fs.readdirSync(runsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);

      for (const runName of runDirs) {
        const runDir = path.join(runsDir, runName);
        const statusPath = path.join(runDir, 'status.json');
        if (!fs.existsSync(statusPath)) continue;

        try {
          const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
          if (status.project !== projectId) continue;
        } catch { continue; }

        const findingsPath = path.join(runDir, '18-research-findings.json');
        if (fs.existsSync(findingsPath)) {
          result.research_findings_count++;
        }
      }
    }
  } catch {
    // Non-fatal
  }

  // 3. Count agent memory entries for this project
  try {
    const memMod = getAgentMemoryModule();
    const agentsDir = path.join(workspaceRoot, '.claw', 'agents');
    if (fs.existsSync(agentsDir)) {
      const agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);

      for (const agentId of agentDirs) {
        try {
          const mem = memMod.readMemory({
            agentId,
            filterProject: projectId,
            workspaceRoot,
          });
          if (mem.ok) {
            result.memory_entry_count += mem.total_entries;
          }
        } catch {
          // Skip agents with unreadable memory
        }
      }
    }
  } catch {
    // Non-fatal
  }

  // Sort artifact_counts_by_type keys for determinism
  result.artifact_counts_by_type = sortObjectKeys(result.artifact_counts_by_type);

  return result;
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
    parent_id: item.parent_id || null,
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
  const taskPackPath = path.join(workspaceRoot, '.claw', 'task-packs', `${entry.id}.json`);
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
// Enrich backlog items with dependency chain fields (mutates entries in place)
// ---------------------------------------------------------------------------
function enrichDependencyChain(items) {
  const byId = new Map();
  for (const item of items) byId.set(item.id, item);

  for (const item of items) {
    // children: IDs of items whose parent_id is this item
    item.children = items.filter(c => c.parent_id === item.id).map(c => c.id);

    // depends_on_status: { id, status } for each dependency
    item.depends_on_status = (item.depends_on || []).map(depId => {
      const dep = byId.get(depId);
      return { id: depId, status: dep ? dep.status : 'unknown' };
    });

    // blocked_by_deps: dependency IDs that are not done
    item.blocked_by_deps = (item.depends_on || []).filter(depId => {
      const dep = byId.get(depId);
      return dep && dep.status !== 'done';
    });

    // is_blocked_by_parent: true if parent exists and is blocked
    item.is_blocked_by_parent = false;
    if (item.parent_id) {
      const parent = byId.get(item.parent_id);
      if (parent && (parent.status === 'blocked')) {
        item.is_blocked_by_parent = true;
      }
    }
  }
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
