#!/usr/bin/env node
'use strict';

/**
 * apply-dev-patch.js — Apply a 40-dev-patch.diff from a run folder to the workspace.
 *
 * Reads the unified diff from a completed dev stage and applies it to the
 * workspace source tree using `git apply`. Supports --dry_run for validation
 * without modification.
 *
 * Usage (CLI):
 *   node apply-dev-patch.js --workspace /path/to/repo --run_folder .claw/runs/20260220_T-01 [--dry_run]
 *
 * Programmatic:
 *   const { applyDevPatch } = require('./apply-dev-patch');
 *   const result = applyDevPatch({ runFolder: '.claw/runs/...' }, { workspaceRoot, dryRun });
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const PATCH_FILENAME = '40-dev-patch.diff';

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------
function applyDevPatch(params, options = {}) {
  const { runFolder } = params || {};
  const workspaceRoot = options.workspaceRoot || process.env.WORKSPACE_ROOT
    || path.resolve(os.homedir(), 'dev', 'agent-work');
  const dryRun = options.dryRun || false;

  if (!runFolder) {
    return { ok: false, error: 'runFolder is required' };
  }

  // --- Path validation (same rules as other tools) ---

  // Refuse absolute paths
  if (runFolder.startsWith('/')) {
    return { ok: false, error: 'absolute paths not allowed — use .claw/runs/<folder>' };
  }

  // Must start with .claw/runs/
  if (!runFolder.startsWith('.claw/runs/')) {
    return { ok: false, error: 'runFolder must start with .claw/runs/' };
  }

  // Refuse traversal
  if (runFolder.includes('..')) {
    return { ok: false, error: 'path traversal not allowed' };
  }

  // Resolve and validate the run folder
  const resolvedRun = path.resolve(workspaceRoot, runFolder);
  if (!resolvedRun.startsWith(workspaceRoot + path.sep)) {
    return { ok: false, error: 'runFolder resolves outside workspace' };
  }

  if (!fs.existsSync(resolvedRun) || !fs.statSync(resolvedRun).isDirectory()) {
    return { ok: false, error: `run folder does not exist: ${runFolder}` };
  }

  // --- Locate and validate the patch file ---

  const patchPath = path.join(resolvedRun, PATCH_FILENAME);
  if (!fs.existsSync(patchPath)) {
    return { ok: false, error: `${PATCH_FILENAME} not found in ${runFolder}` };
  }

  const patchContent = fs.readFileSync(patchPath, 'utf8');
  if (!patchContent.trim()) {
    return { ok: false, error: `${PATCH_FILENAME} is empty` };
  }

  // --- Parse file list from the diff ---
  const filesChanged = [];
  for (const line of patchContent.split('\n')) {
    // Match "diff --git a/path b/path" or "+++ b/path" or "--- a/path"
    const gitDiffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (gitDiffMatch) {
      const filePath = gitDiffMatch[2];
      if (!filesChanged.includes(filePath)) {
        filesChanged.push(filePath);
      }
      continue;
    }
  }

  // --- Apply the patch ---
  const gitArgs = ['apply'];
  if (dryRun) {
    gitArgs.push('--check');
  }
  gitArgs.push('--verbose', patchPath);

  try {
    const output = execFileSync('git', gitArgs, {
      cwd: workspaceRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });

    return {
      ok: true,
      action: dryRun ? 'dry_run_passed' : 'applied',
      run_folder: runFolder,
      patch_path: patchPath,
      files_changed: filesChanged,
      dry_run: dryRun,
    };
  } catch (e) {
    const stderr = (e.stderr || '').trim();
    return {
      ok: false,
      error: `git apply failed: ${stderr || e.message}`,
      run_folder: runFolder,
      patch_path: patchPath,
      files_changed: filesChanged,
      dry_run: dryRun,
    };
  }
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

  const workspaceRoot = getArg('workspace') || process.env.WORKSPACE_ROOT;
  const runFolder = getArg('run_folder');
  const dryRun = args.includes('--dry_run');

  if (!runFolder) {
    const err = { ok: false, error: 'Usage: apply-dev-patch.js --workspace <path> --run_folder <.claw/runs/folder> [--dry_run]' };
    process.stderr.write(JSON.stringify(err, null, 2) + '\n');
    process.exit(1);
  }

  const result = applyDevPatch({ runFolder }, { workspaceRoot, dryRun });
  if (!result.ok) {
    process.stderr.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(0);
}

module.exports = { applyDevPatch };
