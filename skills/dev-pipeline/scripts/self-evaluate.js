#!/usr/bin/env node
'use strict';

/**
 * self-evaluate.js — Structured self-evaluation of a completed run.
 *
 * Compares a run's QA/review outcomes against project historical baselines
 * (from run-analytics) and produces a quality score, deviation list, and
 * actionable suggestions. Optionally writes the evaluation to agent memory.
 *
 * Never mutates the filesystem except when selfEvaluateAndRecord() writes memory.
 *
 * CLI:
 *   node self-evaluate.js --run_folder <relative_path> --project <project_id> [--record --agent <agent_id>]
 *
 * Exports:
 *   selfEvaluate({ workspaceRoot, runFolder, projectId }) → result
 *   selfEvaluateAndRecord({ workspaceRoot, runFolder, projectId, agentId }) → result
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');

// Lazy-loaded modules
let _analyticsModule = null;
let _memoryModule = null;

function getAnalyticsModule() {
  if (!_analyticsModule) {
    _analyticsModule = require(path.resolve(__dirname, 'run-analytics.js'));
  }
  return _analyticsModule;
}

function getMemoryModule() {
  if (!_memoryModule) {
    _memoryModule = require(path.resolve(__dirname, 'agent-memory.js'));
  }
  return _memoryModule;
}

// ---------------------------------------------------------------------------
// Deviation detection
// ---------------------------------------------------------------------------
function computeDeviation(metric, runValue, baselineValue, higherIsBetter) {
  if (runValue === null || runValue === undefined || baselineValue === null || baselineValue === undefined) {
    return null;
  }
  if (baselineValue === 0 && runValue === 0) {
    return { metric, run_value: runValue, baseline_value: baselineValue, direction: 'same', severity: 'minor' };
  }

  const diff = runValue - baselineValue;
  const denominator = baselineValue !== 0 ? Math.abs(baselineValue) : 1;
  const pctChange = Math.abs(diff / denominator);

  let direction;
  if (pctChange < 0.001) {
    direction = 'same';
  } else if (higherIsBetter) {
    direction = diff > 0 ? 'better' : 'worse';
  } else {
    direction = diff < 0 ? 'better' : 'worse';
  }

  let severity;
  if (pctChange < 0.10) severity = 'minor';
  else if (pctChange < 0.30) severity = 'notable';
  else severity = 'significant';

  return { metric, run_value: runValue, baseline_value: baselineValue, direction, severity };
}

// ---------------------------------------------------------------------------
// Quality score computation
// ---------------------------------------------------------------------------
function computeQualityScore(runMetrics, aggregates) {
  // Need at least some baseline data
  if (aggregates.total_runs < 2) return null;

  // QA factor: 1.0 if pass, 0.5 if conditional, 0.0 if fail, 0.5 if no verdict
  let qaFactor = 0.5;
  if (runMetrics.qa_verdict === 'pass') qaFactor = 1.0;
  else if (runMetrics.qa_verdict === 'fail') qaFactor = 0.0;
  else if (runMetrics.qa_verdict === 'conditional') qaFactor = 0.5;

  // Review factor: 1.0 if approved, 0.5 if changes_requested, 0.0 if rejected, 0.5 if no verdict
  let reviewFactor = 0.5;
  if (runMetrics.review_verdict === 'approved') reviewFactor = 1.0;
  else if (runMetrics.review_verdict === 'rejected') reviewFactor = 0.0;
  else if (runMetrics.review_verdict === 'changes_requested') reviewFactor = 0.5;

  // Duration factor: relative to baseline avg
  let durationFactor = 0.5;
  if (runMetrics.total_duration_ms !== null && aggregates.avg_autonomous_steps !== null) {
    // Compare total duration to average total (sum of avg stage durations)
    const avgTotalMs = Object.values(aggregates.avg_duration_per_stage).reduce((s, v) => s + v, 0);
    if (avgTotalMs > 0) {
      // Better (faster) = higher score
      durationFactor = Math.max(0, Math.min(1, 1.0 - (runMetrics.total_duration_ms - avgTotalMs) / avgTotalMs));
    }
  }

  const score = 0.4 * qaFactor + 0.4 * reviewFactor + 0.2 * durationFactor;
  return +score.toFixed(4);
}

// ---------------------------------------------------------------------------
// Suggestion generation
// ---------------------------------------------------------------------------
function generateSuggestions(deviations, runMetrics) {
  const suggestions = [];
  let seq = 0;

  // Check for significant worse deviations
  for (const dev of deviations) {
    if (dev.direction === 'worse' && dev.severity === 'significant') {
      seq++;
      if (dev.metric === 'qa_issues_count') {
        suggestions.push({
          id: `SUG-${seq}`,
          title: 'High QA issue count',
          description: `This run had ${dev.run_value} QA issues vs baseline ${dev.baseline_value}. Consider adding pre-commit validation.`,
        });
      } else if (dev.metric === 'total_duration_ms') {
        suggestions.push({
          id: `SUG-${seq}`,
          title: 'Slow run duration',
          description: `This run took significantly longer than baseline. Review bottleneck stages.`,
        });
      } else {
        suggestions.push({
          id: `SUG-${seq}`,
          title: `Significant regression in ${dev.metric}`,
          description: `${dev.metric}: run=${dev.run_value}, baseline=${dev.baseline_value}. Investigate root cause.`,
        });
      }
    }
  }

  // QA failure suggestion
  if (runMetrics.qa_verdict === 'fail') {
    seq++;
    suggestions.push({
      id: `SUG-${seq}`,
      title: 'QA failure',
      description: 'The QA stage failed. Review issues and add regression tests before next run.',
    });
  }

  // Review rejection suggestion
  if (runMetrics.review_verdict === 'rejected') {
    seq++;
    suggestions.push({
      id: `SUG-${seq}`,
      title: 'Review rejected',
      description: 'The review was rejected. Address policy violations before re-running.',
    });
  }

  return suggestions;
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------
function selfEvaluate(options = {}) {
  const workspaceRoot = options.workspaceRoot || WORKSPACE_ROOT;
  const runFolder = options.runFolder;
  const projectId = options.projectId;

  if (!runFolder) return { ok: false, error: 'runFolder is required' };
  if (!projectId) return { ok: false, error: 'projectId is required' };

  // Get analytics for baselines
  const { buildRunAnalytics } = getAnalyticsModule();
  const analytics = buildRunAnalytics({ workspaceRoot, projectId });
  if (!analytics.ok) return { ok: false, error: `analytics failed: ${analytics.error}` };

  // Find this run's metrics
  const thisRun = analytics.runs.find(r => r.run_folder === runFolder);
  if (!thisRun) {
    return { ok: false, error: `run not found: ${runFolder}` };
  }

  const agg = analytics.aggregates;
  const qualityScore = computeQualityScore(thisRun, agg);

  // Compute deviations
  const deviations = [];
  const avgTotalMs = Object.values(agg.avg_duration_per_stage).reduce((s, v) => s + v, 0);

  const devChecks = [
    { metric: 'total_duration_ms', runVal: thisRun.total_duration_ms, baseVal: avgTotalMs || null, higherIsBetter: false },
    { metric: 'qa_issues_count', runVal: thisRun.qa_issues_count, baseVal: agg.total_runs > 0 ? +(analytics.runs.reduce((s, r) => s + r.qa_issues_count, 0) / agg.total_runs).toFixed(2) : null, higherIsBetter: false },
    { metric: 'autonomous_steps', runVal: thisRun.autonomous_steps, baseVal: agg.avg_autonomous_steps, higherIsBetter: false },
    { metric: 'artifact_count', runVal: thisRun.artifact_count, baseVal: agg.avg_artifact_count, higherIsBetter: true },
  ];

  for (const check of devChecks) {
    const dev = computeDeviation(check.metric, check.runVal, check.baseVal, check.higherIsBetter);
    if (dev) deviations.push(dev);
  }

  const suggestions = generateSuggestions(deviations, thisRun);

  return {
    ok: true,
    action: 'self_evaluation_complete',
    run_folder: runFolder,
    project_id: projectId,
    quality_score: qualityScore,
    deviations,
    suggestions,
  };
}

// ---------------------------------------------------------------------------
// Self-evaluate + write to memory
// ---------------------------------------------------------------------------
function selfEvaluateAndRecord(options = {}) {
  const result = selfEvaluate(options);
  if (!result.ok) return result;

  const agentId = options.agentId;
  if (!agentId) return { ok: false, error: 'agentId is required for recording' };

  const workspaceRoot = options.workspaceRoot || WORKSPACE_ROOT;

  try {
    const { writeMemory } = getMemoryModule();

    const scorePart = result.quality_score !== null ? `score=${result.quality_score}` : 'score=N/A (insufficient baseline)';
    const devCount = result.deviations.filter(d => d.direction === 'worse').length;
    const sugCount = result.suggestions.length;

    const content = `Self-evaluation: ${scorePart}, ${devCount} worse deviations, ${sugCount} suggestions. ` +
      result.suggestions.map(s => s.title).join('; ');

    writeMemory({
      workspaceRoot,
      agentId,
      runId: result.run_folder,
      projectId: result.project_id,
      stage: 'review',
      type: 'evaluation',
      content: content.slice(0, 2000),
      tags: ['self-evaluation', 'phase4'],
    });

    result.memory_written = true;
  } catch (e) {
    result.memory_written = false;
  }

  return result;
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

  const runFolder = getArg('run_folder');
  const projectId = getArg('project');
  const record = args.includes('--record');
  const agentId = getArg('agent');

  if (!runFolder || !projectId) {
    process.stderr.write(JSON.stringify({ ok: false, error: '--run_folder and --project are required' }) + '\n');
    process.exit(1);
  }

  let result;
  if (record) {
    if (!agentId) {
      process.stderr.write(JSON.stringify({ ok: false, error: '--agent is required when --record is used' }) + '\n');
      process.exit(1);
    }
    result = selfEvaluateAndRecord({ runFolder, projectId, agentId });
  } else {
    result = selfEvaluate({ runFolder, projectId });
  }

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
module.exports = { selfEvaluate, selfEvaluateAndRecord };
