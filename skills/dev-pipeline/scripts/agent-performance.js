#!/usr/bin/env node
'use strict';

/**
 * agent-performance.js — Agent performance profiles and allocation recommendation.
 *
 * Computes per-agent performance scores from stage_history, QA, and review data
 * in completed runs. Can recommend the best agent for a given role.
 *
 * Performance score = 0.4 * qa_pass_rate + 0.3 * review_approval_rate + 0.3 * speed_factor
 * speed_factor = clamp(1.0 - (avg_duration - global_avg) / global_avg, 0, 1)
 *
 * Never mutates the filesystem.
 *
 * CLI:
 *   node agent-performance.js --project <project_id> [--role <role>]
 *
 * Exports:
 *   buildAgentPerformance({ workspaceRoot, projectId }) → result
 *   recommendAgent({ workspaceRoot, projectId, role }) → agentId | null
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');

let _analyticsModule = null;
let _agentStateModule = null;

function getAnalyticsModule() {
  if (!_analyticsModule) {
    _analyticsModule = require(path.resolve(__dirname, 'run-analytics.js'));
  }
  return _analyticsModule;
}

function getAgentStateModule() {
  if (!_agentStateModule) {
    _agentStateModule = require(path.resolve(__dirname, 'agent-state.js'));
  }
  return _agentStateModule;
}

// ---------------------------------------------------------------------------
// Per-agent metrics extraction
// ---------------------------------------------------------------------------
function extractAgentMetrics(analytics) {
  const agentData = {};

  for (const run of analytics.runs) {
    const agentId = run.responsible_agent;
    if (!agentId) continue;

    if (!agentData[agentId]) {
      agentData[agentId] = {
        runs: [],
        qa_passes: 0,
        qa_total: 0,
        review_approvals: 0,
        review_total: 0,
        total_duration: 0,
        duration_count: 0,
      };
    }

    const data = agentData[agentId];
    data.runs.push(run);

    if (run.qa_verdict !== null) {
      data.qa_total++;
      if (run.qa_verdict === 'pass') data.qa_passes++;
    }

    if (run.review_verdict !== null) {
      data.review_total++;
      if (run.review_verdict === 'approved') data.review_approvals++;
    }

    if (run.total_duration_ms !== null) {
      data.total_duration += run.total_duration_ms;
      data.duration_count++;
    }
  }

  return agentData;
}

// ---------------------------------------------------------------------------
// Performance score computation
// ---------------------------------------------------------------------------
function computePerformanceScore(agentData, globalAvgDuration) {
  const qaPassRate = agentData.qa_total > 0
    ? agentData.qa_passes / agentData.qa_total
    : null;

  const reviewApprovalRate = agentData.review_total > 0
    ? agentData.review_approvals / agentData.review_total
    : null;

  const avgDuration = agentData.duration_count > 0
    ? agentData.total_duration / agentData.duration_count
    : null;

  let speedFactor = null;
  if (avgDuration !== null && globalAvgDuration > 0) {
    speedFactor = Math.max(0, Math.min(1, 1.0 - (avgDuration - globalAvgDuration) / globalAvgDuration));
  }

  let performanceScore = null;
  if (qaPassRate !== null || reviewApprovalRate !== null) {
    const qa = qaPassRate !== null ? qaPassRate : 0.5;
    const review = reviewApprovalRate !== null ? reviewApprovalRate : 0.5;
    const speed = speedFactor !== null ? speedFactor : 0.5;
    performanceScore = +(0.4 * qa + 0.3 * review + 0.3 * speed).toFixed(4);
  }

  return {
    runs_count: agentData.runs.length,
    qa_pass_rate: qaPassRate !== null ? +qaPassRate.toFixed(4) : null,
    review_approval_rate: reviewApprovalRate !== null ? +reviewApprovalRate.toFixed(4) : null,
    avg_duration_ms: avgDuration !== null ? Math.round(avgDuration) : null,
    speed_factor: speedFactor !== null ? +speedFactor.toFixed(4) : null,
    performance_score: performanceScore,
  };
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------
function buildAgentPerformance(options = {}) {
  const workspaceRoot = options.workspaceRoot || WORKSPACE_ROOT;
  const projectId = options.projectId;
  const roleFilter = options.role || null;

  if (!projectId) return { ok: false, error: 'projectId is required' };

  const { buildRunAnalytics } = getAnalyticsModule();
  const analytics = buildRunAnalytics({ workspaceRoot, projectId });
  if (!analytics.ok) return { ok: false, error: `analytics failed: ${analytics.error}` };

  const agentData = extractAgentMetrics(analytics);

  // Global average duration across all runs
  let globalTotalDuration = 0;
  let globalDurationCount = 0;
  for (const run of analytics.runs) {
    if (run.total_duration_ms !== null) {
      globalTotalDuration += run.total_duration_ms;
      globalDurationCount++;
    }
  }
  const globalAvgDuration = globalDurationCount > 0 ? globalTotalDuration / globalDurationCount : 0;

  // Build profiles
  const agents = [];
  for (const agentId of Object.keys(agentData).sort()) {
    const metrics = computePerformanceScore(agentData[agentId], globalAvgDuration);
    agents.push({
      agent_id: agentId,
      ...metrics,
    });
  }

  // Filter by role if specified
  let filteredAgents = agents;
  if (roleFilter) {
    try {
      const agentMod = getAgentStateModule();
      filteredAgents = agents.filter(a => {
        try {
          const state = agentMod.readAgentState(a.agent_id, { agentsDir: path.join(workspaceRoot, '.claw', 'agents') });
          return state && state.role === roleFilter;
        } catch {
          return false;
        }
      });
    } catch {
      filteredAgents = agents;
    }
  }

  // Recommendation: highest performance_score among filtered agents
  let recommendedAgent = null;
  let bestScore = -1;
  for (const agent of filteredAgents) {
    if (agent.performance_score !== null && agent.performance_score > bestScore) {
      bestScore = agent.performance_score;
      recommendedAgent = agent.agent_id;
    }
  }

  return {
    ok: true,
    action: 'performance_computed',
    project_id: projectId,
    agents,
    recommended_agent: recommendedAgent,
    role_filter: roleFilter,
  };
}

function recommendAgent(options = {}) {
  const result = buildAgentPerformance(options);
  if (!result.ok) return null;
  return result.recommended_agent;
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

  const projectId = getArg('project');
  const role = getArg('role');

  if (!projectId) {
    process.stderr.write(JSON.stringify({ ok: false, error: '--project is required' }) + '\n');
    process.exit(1);
  }

  const result = buildAgentPerformance({ projectId, role });
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
module.exports = { buildAgentPerformance, recommendAgent };
