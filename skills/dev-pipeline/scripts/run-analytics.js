#!/usr/bin/env node
'use strict';

/**
 * run-analytics.js — Read-only analytics engine for completed runs.
 *
 * Scans all runs for a project and computes per-run metrics (stage durations,
 * QA/review outcomes, artifact counts, autonomous steps) plus project-level
 * aggregates (pass rates, avg durations, severity distributions).
 *
 * Never mutates the filesystem.
 *
 * CLI:
 *   node run-analytics.js --project <project_id>
 *
 * Exports:
 *   buildRunAnalytics({ workspaceRoot, projectId }) → result
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');

// Metadata files excluded from artifact count
const METADATA_FILES = new Set([
  'status.json',
  'autonomous-audit.jsonl',
  '.stop',
]);

// ---------------------------------------------------------------------------
// Per-run metric extraction
// ---------------------------------------------------------------------------
function extractRunMetrics(runDir, runFolderRelative) {
  const statusPath = path.join(runDir, 'status.json');
  if (!fs.existsSync(statusPath)) return null;

  let status;
  try {
    status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  } catch {
    return null;
  }

  // Stage durations from stage_history
  const stageDurations = [];
  let totalDurationMs = 0;
  let hasDuration = false;

  if (Array.isArray(status.stage_history)) {
    for (const sh of status.stage_history) {
      let durationMs = null;
      if (sh.started_at && sh.finished_at) {
        const start = new Date(sh.started_at).getTime();
        const end = new Date(sh.finished_at).getTime();
        if (!isNaN(start) && !isNaN(end)) {
          durationMs = end - start;
          totalDurationMs += durationMs;
          hasDuration = true;
        }
      }
      stageDurations.push({
        stage: sh.stage || 'unknown',
        duration_ms: durationMs,
        agent_id: sh.agent_id || null,
      });
    }
  }

  // QA report
  let qaVerdict = null;
  let qaIssuesCount = 0;
  const qaIssueSeverities = {};
  const qaPath = path.join(runDir, '50-qa-report.json');
  if (fs.existsSync(qaPath)) {
    try {
      const qa = JSON.parse(fs.readFileSync(qaPath, 'utf8'));
      qaVerdict = qa.verdict || null;
      if (Array.isArray(qa.issues)) {
        qaIssuesCount = qa.issues.length;
        for (const issue of qa.issues) {
          const sev = issue.severity || 'unknown';
          qaIssueSeverities[sev] = (qaIssueSeverities[sev] || 0) + 1;
        }
      }
    } catch {
      // Invalid QA report
    }
  }

  // Review report
  let reviewVerdict = null;
  let reviewPolicyViolationsCount = 0;
  let reviewCommentsCount = 0;
  const reviewPath = path.join(runDir, '60-review-report.json');
  if (fs.existsSync(reviewPath)) {
    try {
      const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
      reviewVerdict = review.verdict || null;
      if (Array.isArray(review.policy_violations)) {
        reviewPolicyViolationsCount = review.policy_violations.length;
      }
      if (Array.isArray(review.comments)) {
        reviewCommentsCount = review.comments.length;
      }
    } catch {
      // Invalid review report
    }
  }

  // Artifact count — non-metadata files in run folder
  let artifactCount = 0;
  try {
    const files = fs.readdirSync(runDir);
    for (const f of files) {
      if (!METADATA_FILES.has(f)) {
        const stat = fs.statSync(path.join(runDir, f));
        if (stat.isFile()) artifactCount++;
      }
    }
  } catch {
    // Cannot read dir
  }

  // Autonomous steps — line count of autonomous-audit.jsonl
  let autonomousSteps = 0;
  const auditPath = path.join(runDir, 'autonomous-audit.jsonl');
  if (fs.existsSync(auditPath)) {
    try {
      const content = fs.readFileSync(auditPath, 'utf8').trim();
      if (content.length > 0) {
        autonomousSteps = content.split('\n').length;
      }
    } catch {
      // Cannot read audit file
    }
  }

  return {
    run_folder: runFolderRelative,
    ticket_id: status.ticket_id || '',
    current_stage: status.current_stage || 'unknown',
    responsible_agent: status.responsible_agent || null,
    stage_durations: stageDurations,
    total_duration_ms: hasDuration ? totalDurationMs : null,
    qa_verdict: qaVerdict,
    qa_issues_count: qaIssuesCount,
    qa_issue_severities: qaIssueSeverities,
    review_verdict: reviewVerdict,
    review_policy_violations_count: reviewPolicyViolationsCount,
    review_comments_count: reviewCommentsCount,
    artifact_count: artifactCount,
    autonomous_steps: autonomousSteps,
  };
}

// ---------------------------------------------------------------------------
// Project-level aggregates
// ---------------------------------------------------------------------------
function computeAggregates(runs) {
  const totalRuns = runs.length;
  const completedRuns = runs.filter(r => r.current_stage === 'done').length;

  // Avg duration per stage
  const stageAccum = {};
  for (const run of runs) {
    for (const sd of run.stage_durations) {
      if (sd.duration_ms !== null) {
        if (!stageAccum[sd.stage]) stageAccum[sd.stage] = { total: 0, count: 0 };
        stageAccum[sd.stage].total += sd.duration_ms;
        stageAccum[sd.stage].count++;
      }
    }
  }
  const avgDurationPerStage = {};
  for (const [stage, acc] of Object.entries(stageAccum).sort(([a], [b]) => a.localeCompare(b))) {
    avgDurationPerStage[stage] = Math.round(acc.total / acc.count);
  }

  // QA rates — only count runs with a QA verdict
  const qaRuns = runs.filter(r => r.qa_verdict !== null);
  let qaPassRate = null;
  let qaFailRate = null;
  if (qaRuns.length > 0) {
    const passes = qaRuns.filter(r => r.qa_verdict === 'pass').length;
    const failures = qaRuns.filter(r => r.qa_verdict === 'fail').length;
    qaPassRate = +(passes / qaRuns.length).toFixed(4);
    qaFailRate = +(failures / qaRuns.length).toFixed(4);
  }

  // Review rates — only count runs with a review verdict
  const reviewRuns = runs.filter(r => r.review_verdict !== null);
  let reviewApprovalRate = null;
  let reviewRejectionRate = null;
  if (reviewRuns.length > 0) {
    const approvals = reviewRuns.filter(r => r.review_verdict === 'approved').length;
    const rejections = reviewRuns.filter(r => r.review_verdict === 'rejected').length;
    reviewApprovalRate = +(approvals / reviewRuns.length).toFixed(4);
    reviewRejectionRate = +(rejections / reviewRuns.length).toFixed(4);
  }

  // Issue severity distribution
  const issueSevDist = {};
  for (const run of runs) {
    for (const [sev, count] of Object.entries(run.qa_issue_severities)) {
      issueSevDist[sev] = (issueSevDist[sev] || 0) + count;
    }
  }
  // Sort keys for determinism
  const sortedIssueSevDist = {};
  for (const key of Object.keys(issueSevDist).sort()) {
    sortedIssueSevDist[key] = issueSevDist[key];
  }

  // Avg autonomous steps and artifact count
  let avgAutonomousSteps = null;
  let avgArtifactCount = null;
  if (totalRuns > 0) {
    const totalSteps = runs.reduce((sum, r) => sum + r.autonomous_steps, 0);
    const totalArtifacts = runs.reduce((sum, r) => sum + r.artifact_count, 0);
    avgAutonomousSteps = +(totalSteps / totalRuns).toFixed(2);
    avgArtifactCount = +(totalArtifacts / totalRuns).toFixed(2);
  }

  return {
    total_runs: totalRuns,
    completed_runs: completedRuns,
    avg_duration_per_stage: avgDurationPerStage,
    qa_pass_rate: qaPassRate,
    qa_fail_rate: qaFailRate,
    review_approval_rate: reviewApprovalRate,
    review_rejection_rate: reviewRejectionRate,
    issue_severity_distribution: sortedIssueSevDist,
    avg_autonomous_steps: avgAutonomousSteps,
    avg_artifact_count: avgArtifactCount,
  };
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------
function buildRunAnalytics(options = {}) {
  const workspaceRoot = options.workspaceRoot || WORKSPACE_ROOT;
  const projectId = options.projectId;

  if (!projectId) {
    return { ok: false, error: 'projectId is required' };
  }

  const runsDir = path.join(workspaceRoot, '.claw', 'runs');
  const runs = [];

  if (fs.existsSync(runsDir)) {
    let entries;
    try {
      entries = fs.readdirSync(runsDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort();
    } catch {
      entries = [];
    }

    for (const runName of entries) {
      const runDir = path.join(runsDir, runName);
      const statusPath = path.join(runDir, 'status.json');
      if (!fs.existsSync(statusPath)) continue;

      // Check project ownership
      try {
        const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
        if (status.project !== projectId) continue;
      } catch {
        continue;
      }

      const relPath = `.claw/runs/${runName}`;
      const metrics = extractRunMetrics(runDir, relPath);
      if (metrics) runs.push(metrics);
    }
  }

  const aggregates = computeAggregates(runs);

  return {
    ok: true,
    action: 'analytics_computed',
    project_id: projectId,
    runs,
    aggregates,
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

  const result = buildRunAnalytics({ projectId });
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
module.exports = { buildRunAnalytics };
