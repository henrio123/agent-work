#!/usr/bin/env node
'use strict';

/**
 * workflow-suggest.js — Actionable workflow improvement suggestions.
 *
 * Analyzes run analytics for a project and detects patterns that indicate
 * workflow inefficiencies: recurring QA failures, bottleneck stages, high
 * rejection rates, and quality trends. Never mutates the filesystem.
 *
 * CLI:
 *   node workflow-suggest.js --project <project_id>
 *
 * Exports:
 *   generateWorkflowSuggestions({ workspaceRoot, projectId }) → result
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');

let _analyticsModule = null;

function getAnalyticsModule() {
  if (!_analyticsModule) {
    _analyticsModule = require(path.resolve(__dirname, 'run-analytics.js'));
  }
  return _analyticsModule;
}

// ---------------------------------------------------------------------------
// Detection rules
// ---------------------------------------------------------------------------

function detectRecurringQaFailure(analytics) {
  const agg = analytics.aggregates;
  if (agg.qa_fail_rate === null) return null;
  if (agg.qa_fail_rate <= 0.3) return null;

  const confidence = agg.total_runs >= 5 ? 'high' : 'medium';
  const failedRuns = analytics.runs.filter(r => r.qa_verdict === 'fail');

  return {
    id: 'WS-1',
    category: 'recurring_qa_failure',
    title: 'Recurring QA failures detected',
    description: `QA failure rate is ${(agg.qa_fail_rate * 100).toFixed(0)}% across ${agg.total_runs} runs. Consider adding pre-validation steps or improving test coverage.`,
    evidence: [
      `qa_fail_rate=${agg.qa_fail_rate}`,
      `failed_runs=${failedRuns.length}/${agg.total_runs}`,
      ...failedRuns.slice(0, 3).map(r => `${r.run_folder}: verdict=${r.qa_verdict}, issues=${r.qa_issues_count}`),
    ],
    confidence,
    priority: 'P1',
  };
}

function detectBottleneckStages(analytics) {
  const agg = analytics.aggregates;
  const stages = Object.entries(agg.avg_duration_per_stage);
  if (stages.length < 2) return null;

  const durations = stages.map(([, d]) => d).sort((a, b) => a - b);
  const median = durations[Math.floor(durations.length / 2)];
  if (median === 0) return null;

  const bottlenecks = stages.filter(([, d]) => d > median * 2);
  if (bottlenecks.length === 0) return null;

  const confidence = analytics.aggregates.total_runs >= 5 ? 'high' : 'medium';

  return {
    id: 'WS-2',
    category: 'bottleneck_stage',
    title: 'Stage bottleneck detected',
    description: `Stage(s) ${bottlenecks.map(([s]) => s).join(', ')} take >2x the median stage duration. Consider parallelizing or optimizing.`,
    evidence: [
      `median_stage_duration_ms=${median}`,
      ...bottlenecks.map(([s, d]) => `${s}: avg=${d}ms (${(d / median).toFixed(1)}x median)`),
    ],
    confidence,
    priority: 'P2',
  };
}

function detectHighRejectionRate(analytics) {
  const agg = analytics.aggregates;
  if (agg.review_rejection_rate === null) return null;

  // Count rejections + changes_requested as problematic
  const reviewRuns = analytics.runs.filter(r => r.review_verdict !== null);
  const problematicRuns = reviewRuns.filter(r => r.review_verdict === 'rejected' || r.review_verdict === 'changes_requested');
  const problemRate = reviewRuns.length > 0 ? problematicRuns.length / reviewRuns.length : 0;

  if (problemRate <= 0.2) return null;

  const confidence = analytics.aggregates.total_runs >= 5 ? 'high' : 'medium';

  return {
    id: 'WS-3',
    category: 'high_rejection_rate',
    title: 'High review rejection/changes rate',
    description: `${(problemRate * 100).toFixed(0)}% of reviewed runs were rejected or required changes. Add pre-review checklists.`,
    evidence: [
      `rejection_rate=${(problemRate).toFixed(4)}`,
      `problematic_runs=${problematicRuns.length}/${reviewRuns.length}`,
      ...problematicRuns.slice(0, 3).map(r => `${r.run_folder}: verdict=${r.review_verdict}, violations=${r.review_policy_violations_count}`),
    ],
    confidence,
    priority: 'P1',
  };
}

function detectQualityTrend(analytics) {
  const runs = analytics.runs;
  if (runs.length < 3) return null;

  // Check last 3 runs for consistent failures
  const last3 = runs.slice(-3);
  const allHadIssues = last3.every(r => r.qa_verdict === 'fail' || r.review_verdict === 'rejected' || r.review_verdict === 'changes_requested');
  if (!allHadIssues) return null;

  return {
    id: 'WS-4',
    category: 'quality_trend',
    title: 'Declining quality trend',
    description: 'The last 3 consecutive runs all had QA failures or review rejections. Immediate attention recommended.',
    evidence: last3.map(r => `${r.run_folder}: qa=${r.qa_verdict || 'N/A'}, review=${r.review_verdict || 'N/A'}`),
    confidence: 'medium',
    priority: 'P0',
  };
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------
function generateWorkflowSuggestions(options = {}) {
  const workspaceRoot = options.workspaceRoot || WORKSPACE_ROOT;
  const projectId = options.projectId;

  if (!projectId) return { ok: false, error: 'projectId is required' };

  const { buildRunAnalytics } = getAnalyticsModule();
  const analytics = buildRunAnalytics({ workspaceRoot, projectId });
  if (!analytics.ok) return { ok: false, error: `analytics failed: ${analytics.error}` };

  const suggestions = [];

  const detectors = [
    detectRecurringQaFailure,
    detectBottleneckStages,
    detectHighRejectionRate,
    detectQualityTrend,
  ];

  for (const detector of detectors) {
    const suggestion = detector(analytics);
    if (suggestion) suggestions.push(suggestion);
  }

  // Summary counts
  const byCategory = {};
  const byConfidence = {};
  for (const s of suggestions) {
    byCategory[s.category] = (byCategory[s.category] || 0) + 1;
    byConfidence[s.confidence] = (byConfidence[s.confidence] || 0) + 1;
  }

  return {
    ok: true,
    action: 'suggestions_generated',
    project_id: projectId,
    suggestions,
    summary: {
      total_suggestions: suggestions.length,
      by_category: byCategory,
      by_confidence: byConfidence,
    },
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

  const projectId = getArg('project');
  if (!projectId) {
    process.stderr.write(JSON.stringify({ ok: false, error: '--project is required' }) + '\n');
    process.exit(1);
  }

  const result = generateWorkflowSuggestions({ projectId });
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
module.exports = { generateWorkflowSuggestions };
