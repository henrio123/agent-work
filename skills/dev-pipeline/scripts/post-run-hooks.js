#!/usr/bin/env node
'use strict';

/**
 * post-run-hooks.js — Post-run lifecycle orchestrator.
 *
 * After a run completes, automatically triggers:
 *   1. Self-evaluation with memory recording
 *   2. Gap scanning with auto-create
 *
 * Both hooks are non-fatal — errors are logged but do not fail the caller.
 * Only runs if the run has reached a terminal stage (done, or a completed
 * QA/review stage). Skips if the run is still in-progress (needs_artifacts).
 *
 * CLI:
 *   node post-run-hooks.js --run_folder <relative_path> --project <project_id> [--agent <agent_id>]
 *
 * Exports:
 *   runPostRunHooks({ workspaceRoot, runFolder, projectId, agentId }) → result
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');

// Terminal stages where post-run hooks should fire
const TERMINAL_STAGES = new Set(['done', 'qa', 'review']);

// Terminal final_actions from autonomous runner
const TERMINAL_ACTIONS = new Set(['none', 'blocked', 'error', 'stalled', 'stopped']);

// Lazy-loaded modules
let _selfEvalModule = null;
let _gapScanModule = null;

function getSelfEvalModule() {
  if (!_selfEvalModule) {
    _selfEvalModule = require(path.resolve(__dirname, 'self-evaluate.js'));
  }
  return _selfEvalModule;
}

function getGapScanModule() {
  if (!_gapScanModule) {
    _gapScanModule = require(path.resolve(__dirname, 'gap-scanner.js'));
  }
  return _gapScanModule;
}

// ---------------------------------------------------------------------------
// Determine if run is in a terminal state
// ---------------------------------------------------------------------------
function isRunTerminal(runFolder, workspaceRoot) {
  const ws = workspaceRoot || WORKSPACE_ROOT;
  const absRunFolder = path.resolve(ws, runFolder);
  const statusPath = path.join(absRunFolder, 'status.json');

  if (!fs.existsSync(statusPath)) return false;

  try {
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    const stage = status.current_stage;

    // Done stage is always terminal
    if (stage === 'done') return true;

    // QA or review stages are terminal if they have completed artifacts
    if (TERMINAL_STAGES.has(stage)) {
      // Check if last autonomous action was terminal
      if (status.last_autonomous_summary) {
        const fa = status.last_autonomous_summary.final_action;
        if (TERMINAL_ACTIONS.has(fa)) return true;
      }
      return true;
    }

    // Check if last autonomous action was a terminal one
    if (status.last_autonomous_summary) {
      const fa = status.last_autonomous_summary.final_action;
      if (fa === 'none' || fa === 'blocked' || fa === 'error' || fa === 'stalled') return true;
    }

    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------
function runPostRunHooks(options = {}) {
  const workspaceRoot = options.workspaceRoot || WORKSPACE_ROOT;
  const runFolder = options.runFolder;
  const projectId = options.projectId;
  const agentId = options.agentId || null;

  if (!runFolder) return { ok: false, action: 'post_run_hooks_skipped', skip_reason: 'runFolder is required' };
  if (!projectId) return { ok: false, action: 'post_run_hooks_skipped', skip_reason: 'projectId is required' };

  // Check if run is in a terminal state
  if (!isRunTerminal(runFolder, workspaceRoot)) {
    return {
      ok: true,
      action: 'post_run_hooks_skipped',
      skip_reason: 'run is not in a terminal state',
    };
  }

  const result = {
    ok: true,
    action: 'post_run_hooks_complete',
    self_evaluation: null,
    gaps: null,
  };

  // Hook 1: Self-evaluation
  try {
    const { selfEvaluateAndRecord, selfEvaluate } = getSelfEvalModule();

    let evalResult;
    if (agentId) {
      evalResult = selfEvaluateAndRecord({ workspaceRoot, runFolder, projectId, agentId });
    } else {
      evalResult = selfEvaluate({ workspaceRoot, runFolder, projectId });
    }

    if (evalResult.ok) {
      result.self_evaluation = {
        quality_score: evalResult.quality_score,
        deviations_count: evalResult.deviations ? evalResult.deviations.filter(d => d.direction === 'worse').length : 0,
        suggestions_count: evalResult.suggestions ? evalResult.suggestions.length : 0,
        memory_written: evalResult.memory_written || false,
      };
    } else {
      result.self_evaluation = {
        quality_score: null,
        deviations_count: 0,
        suggestions_count: 0,
        memory_written: false,
        error: evalResult.error || 'unknown',
      };
    }
  } catch (e) {
    result.self_evaluation = {
      quality_score: null,
      deviations_count: 0,
      suggestions_count: 0,
      memory_written: false,
      error: e.message,
    };
  }

  // Hook 2: Gap scanning with auto-create
  try {
    const { scanGaps } = getGapScanModule();
    const gapResult = scanGaps({ workspaceRoot, projectId, autoCreate: true });

    if (gapResult.ok) {
      result.gaps = {
        total_found: gapResult.summary.total_gaps,
        auto_created_count: gapResult.summary.auto_created_count,
      };
    } else {
      result.gaps = {
        total_found: 0,
        auto_created_count: 0,
        error: gapResult.error || 'unknown',
      };
    }
  } catch (e) {
    result.gaps = {
      total_found: 0,
      auto_created_count: 0,
      error: e.message,
    };
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
  const agentId = getArg('agent');

  if (!runFolder || !projectId) {
    process.stderr.write(JSON.stringify({ ok: false, error: '--run_folder and --project are required' }) + '\n');
    process.exit(1);
  }

  const result = runPostRunHooks({ runFolder, projectId, agentId });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = { runPostRunHooks };
