#!/usr/bin/env node
'use strict';

/**
 * project-next-drive.js — One-shot deterministic project-level driver.
 *
 * 1. Picks the next eligible backlog task via project-next-pick.js
 * 2. If the task has no run_folder, creates one and links it back
 * 3. Calls existing run-next-drive's driveOnce() for that run
 * 4. Returns a single JSON object with all results
 *
 * Never backgrounds anything, never loops.
 *
 * Stdout is JSON-only by default (quiet mode). Use --verbose for human-readable
 * progress on stderr.
 *
 * Usage (via CLI):
 *   node project-next-drive.js [--max_steps N] [--max_agent_calls N] [--dry_run] [--audit_log] [--verbose]
 *
 * Or require() for programmatic use:
 *   const { projectDriveOnce } = require('./project-next-drive.js');
 *   const result = projectDriveOnce({ dryRun: true });
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = path.resolve(os.homedir(), 'dev', 'agent-work');

function safePath(p, workspaceRoot) {
  const root = workspaceRoot || WORKSPACE_ROOT;
  const resolved = path.resolve(root, p);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(`Path outside workspace: ${resolved}`);
  }
  return resolved;
}

const { pickNextTask } = require(path.resolve(__dirname, 'project-next-pick.js'));
const { driveOnce } = require(path.resolve(__dirname, 'run-next-drive.js'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function now() {
  return new Date().toISOString();
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Create a run folder for a backlog task
// ---------------------------------------------------------------------------
function createRunForTask(taskItem, projectId, options = {}) {
  const workspaceRoot = options.workspaceRoot || WORKSPACE_ROOT;
  const ts = timestamp();
  const folderName = `${ts}_${taskItem.id}`;
  const runFolder = `runs/${folderName}`;
  const absRunFolder = safePath(runFolder, workspaceRoot);

  fs.mkdirSync(absRunFolder, { recursive: true });

  const createdAt = now();

  // 00-intake.json
  const intake = {
    ticket_id: taskItem.id,
    title: taskItem.title,
    project: projectId,
    created_at: createdAt,
    source: 'project-brain',
  };
  writeJSON(path.join(absRunFolder, '00-intake.json'), intake);

  // status.json
  const status = {
    ticket_id: taskItem.id,
    title: taskItem.title,
    project: projectId,
    created_at: createdAt,
    updated_at: createdAt,
    current_stage: 'intake',
    blocked: false,
    blocked_reason: null,
    required_user_input: [],
    stage_history: [
      {
        stage: 'intake',
        started_at: createdAt,
        finished_at: null,
        artifact_paths: ['00-intake.json'],
      },
    ],
    next_actions: [],
  };
  writeJSON(path.join(absRunFolder, 'status.json'), status);

  return runFolder;
}

// ---------------------------------------------------------------------------
// Link run_folder back to backlog item
// ---------------------------------------------------------------------------
function linkRunToBacklogItem(taskId, projectId, runFolder, options = {}) {
  const workspaceRoot = options.workspaceRoot || WORKSPACE_ROOT;
  const projectsDir = options.projectsDir || path.join(workspaceRoot, 'projects');
  const backlogDir = path.join(projectsDir, projectId, 'backlog');

  // Find and update the backlog item
  if (fs.existsSync(backlogDir)) {
    const files = fs.readdirSync(backlogDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(backlogDir, file);
      try {
        const item = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (item.id === taskId) {
          item.run_folder = runFolder;
          item.updated_at = now();
          if (item.status === 'todo') item.status = 'in_progress';
          writeJSON(filePath, item);
          return;
        }
      } catch {
        // Skip invalid files
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Core driver
// ---------------------------------------------------------------------------
function projectDriveOnce(options = {}) {
  const maxSteps = options.maxSteps || 50;
  const maxAgentCalls = options.maxAgentCalls || 20;
  const dryRun = options.dryRun || false;
  const auditLog = options.auditLog || false;
  const quiet = options.quiet !== false; // quiet by default
  const agentAdapter = options.agentAdapter || undefined;
  const workspaceRoot = options.workspaceRoot || WORKSPACE_ROOT;

  // Step 1: Pick task
  const pickResult = pickNextTask(options);
  if (!pickResult.ok) {
    return { ok: false, error: pickResult.error };
  }

  if (pickResult.action === 'no_eligible_tasks') {
    return {
      ok: true,
      action: 'drive_skipped',
      picked: pickResult,
    };
  }

  const projectId = pickResult.project_id;
  const taskId = pickResult.task_id;
  let runFolder = pickResult.run_folder;
  let createdRun = false;

  // Step 2: Ensure run folder exists
  if (!runFolder) {
    if (dryRun) {
      return {
        ok: true,
        action: 'drive_skipped',
        picked: pickResult,
        run_folder: null,
      };
    }

    // Read the full backlog item for title/description
    const projectsDir = options.projectsDir || path.join(workspaceRoot, 'projects');
    const backlogDir = path.join(projectsDir, projectId, 'backlog');
    let taskItem = { id: taskId, title: taskId, description: '' };
    if (fs.existsSync(backlogDir)) {
      const files = fs.readdirSync(backlogDir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        try {
          const item = JSON.parse(fs.readFileSync(path.join(backlogDir, file), 'utf8'));
          if (item.id === taskId) {
            taskItem = item;
            break;
          }
        } catch {
          // Skip
        }
      }
    }

    runFolder = createRunForTask(taskItem, projectId, options);
    linkRunToBacklogItem(taskId, projectId, runFolder, options);
    createdRun = true;
  }

  // Step 3: Drive the run using existing run-next-drive
  const driveOpts = {
    maxSteps,
    maxAgentCalls,
    dryRun,
    auditLog,
    quiet,
  };
  if (agentAdapter) driveOpts.agentAdapter = agentAdapter;

  // Override pick in driveOnce — we need to drive a specific run, not pick again
  // So we call runAutonomous directly via the same pattern as run-next-drive
  const { runAutonomous } = require(path.resolve(__dirname, 'autonomous-runner.js'));
  const { pickNextRun } = require(path.resolve(__dirname, 'run-next-pick.js'));

  // Safety snapshot
  const runsDir = safePath('runs', workspaceRoot);
  const runsBefore = fs.existsSync(runsDir)
    ? fs.readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];

  // Run autonomous
  const autoOpts = { maxSteps, maxAgentCalls, dryRun, auditLog, progress: !quiet };
  if (agentAdapter) autoOpts.agentAdapter = agentAdapter;
  const autoResult = runAutonomous(runFolder, autoOpts);

  // Safety verify (ignore test dirs and the newly created run)
  const runsAfter = fs.existsSync(runsDir)
    ? fs.readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];

  // Safety snapshot was taken after run creation, so both should match
  const filterFn = (n) => !n.startsWith('_test_');
  const realBefore = runsBefore.filter(filterFn);
  const realAfter = runsAfter.filter(filterFn);
  if (JSON.stringify(realBefore) !== JSON.stringify(realAfter)) {
    return { ok: false, error: 'runs/ directory changed during drive execution' };
  }

  // Dashboard summary on status.json
  const resolvedFolder = safePath(runFolder, workspaceRoot);
  try {
    const statusPath = path.join(resolvedFolder, 'status.json');
    if (fs.existsSync(statusPath)) {
      const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      status.last_autonomous_run_at = now();
      status.last_autonomous_summary = {
        final_action: autoResult.final_action,
        steps_run: autoResult.steps_run,
        agent_calls: autoResult.agent_calls,
        artifacts_written: autoResult.artifacts_written,
      };
      fs.writeFileSync(statusPath, JSON.stringify(status, null, 2) + '\n', 'utf8');
    }
  } catch {
    // Non-fatal
  }

  // Update backlog item with last_summary
  try {
    const projectsDir = options.projectsDir || path.join(workspaceRoot, 'projects');
    const backlogDir = path.join(projectsDir, projectId, 'backlog');
    if (fs.existsSync(backlogDir)) {
      const files = fs.readdirSync(backlogDir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const filePath = path.join(backlogDir, file);
        try {
          const item = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (item.id === taskId) {
            item.last_summary = {
              final_action: autoResult.final_action,
              steps_run: autoResult.steps_run,
              agent_calls: autoResult.agent_calls,
              artifacts_written: autoResult.artifacts_written,
            };
            item.updated_at = now();
            writeJSON(filePath, item);
            break;
          }
        } catch {
          // Skip
        }
      }
    }
  } catch {
    // Non-fatal
  }

  return {
    ok: true,
    action: createdRun ? 'drive_created_run' : 'drive_complete',
    picked: pickResult,
    run_folder: runFolder,
    autonomous: autoResult,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);

  const maxStepsIdx = args.indexOf('--max_steps');
  const maxAgentIdx = args.indexOf('--max_agent_calls');

  const verbose = args.includes('--verbose');
  const opts = {
    maxSteps: maxStepsIdx !== -1 ? parseInt(args[maxStepsIdx + 1], 10) : 50,
    maxAgentCalls: maxAgentIdx !== -1 ? parseInt(args[maxAgentIdx + 1], 10) : 20,
    dryRun: args.includes('--dry_run'),
    auditLog: args.includes('--audit_log') || process.env.DP_AUDIT_LOG === '1',
    quiet: !verbose,
  };

  const result = projectDriveOnce(opts);
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
module.exports = { projectDriveOnce, createRunForTask, linkRunToBacklogItem };
