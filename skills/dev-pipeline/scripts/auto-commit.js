#!/usr/bin/env node
'use strict';

/**
 * auto-commit.js — Structured git commit after successful patch + tests.
 *
 * Phase 7 module. Creates a git commit with a structured message when:
 *   - A dev patch was successfully applied
 *   - Tests passed (or no tests were found)
 *   - autoCommit option is enabled (opt-in, default off)
 *
 * Never pushes. Commit is local only.
 *
 * Exports:
 *   autoCommit(options) → { ok, commit_sha, message, error }
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------
function autoCommit(options = {}) {
  const workspaceRoot = options.workspaceRoot;
  if (!workspaceRoot) {
    return { ok: false, commit_sha: null, message: null, error: 'workspaceRoot is required' };
  }

  // Pre-conditions
  if (!options.patchApplied) {
    return { ok: false, commit_sha: null, message: null, error: 'patch was not applied' };
  }

  if (options.testsOk === false) {
    return { ok: false, commit_sha: null, message: null, error: 'tests failed' };
  }

  // Check for changes
  let porcelain;
  try {
    porcelain = execFileSync('git', ['status', '--porcelain'], {
      encoding: 'utf8',
      cwd: workspaceRoot,
      timeout: 10000,
    }).trim();
  } catch (e) {
    return { ok: false, commit_sha: null, message: null, error: `git status failed: ${e.message}` };
  }

  if (!porcelain) {
    return { ok: false, commit_sha: null, message: null, error: 'no changes to commit' };
  }

  // Stage changes
  try {
    execFileSync('git', ['add', '-A'], {
      encoding: 'utf8',
      cwd: workspaceRoot,
      timeout: 10000,
    });
  } catch (e) {
    return { ok: false, commit_sha: null, message: null, error: `git add failed: ${e.message}` };
  }

  // Build commit message
  const ticketId = options.ticketId || 'unknown';
  const title = options.title || ticketId;
  const runFolder = options.runFolder || '';
  const agentId = options.agentId || 'autonomous';

  const message = [
    `feat(${ticketId}): ${title}`,
    '',
    `Run: ${runFolder}`,
    `Agent: ${agentId}`,
    'Source: dev-pipeline autonomous runner',
  ].join('\n');

  // Commit
  try {
    execFileSync('git', ['commit', '-m', message], {
      encoding: 'utf8',
      cwd: workspaceRoot,
      timeout: 10000,
    });
  } catch (e) {
    return { ok: false, commit_sha: null, message, error: `git commit failed: ${e.message}` };
  }

  // Get SHA
  let commitSha;
  try {
    commitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      cwd: workspaceRoot,
      timeout: 5000,
    }).trim();
  } catch {
    commitSha = 'unknown';
  }

  return { ok: true, commit_sha: commitSha, message, error: null };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  const workspaceRoot = args[0] || process.cwd();
  const result = autoCommit({
    workspaceRoot,
    patchApplied: true,
    ticketId: args[1] || 'CLI-COMMIT',
    title: args[2] || 'manual auto-commit',
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = { autoCommit };
