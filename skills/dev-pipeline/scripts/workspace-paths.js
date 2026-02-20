#!/usr/bin/env node
'use strict';

/**
 * workspace-paths.js — Central path resolver for .claw/ workspace layout.
 *
 * All orchestration state lives inside TARGET_REPO/.claw/. This module
 * provides deterministic path resolution for every subdirectory.
 *
 * Usage:
 *   const wp = require('./workspace-paths');
 *   const paths = wp.resolve('/path/to/target-repo');
 *   // paths.root        → /path/to/target-repo/.claw
 *   // paths.backlog      → /path/to/target-repo/.claw/backlog
 *   // paths.runs         → /path/to/target-repo/.claw/runs
 *   // paths.tickets      → /path/to/target-repo/.claw/tickets
 *   // paths.taskPacks    → /path/to/target-repo/.claw/task-packs
 *   // paths.artifacts    → /path/to/target-repo/.claw/artifacts
 *   // paths.agents       → /path/to/target-repo/.claw/agents
 *   // paths.project      → /path/to/target-repo/.claw/project.json
 *   // paths.agentsConfig → /path/to/target-repo/.claw/agents.json
 */

const path = require('node:path');
const os = require('node:os');

const CLAW_DIR = '.claw';

/**
 * Resolve all .claw/ paths for a workspace root.
 * @param {string} [workspaceRoot] — absolute path to target repo. Falls back
 *   to WORKSPACE_ROOT env var or ~/dev/agent-work.
 * @returns {object} all resolved paths
 */
function resolve(workspaceRoot) {
  const ws = workspaceRoot || process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
  const root = path.join(ws, CLAW_DIR);
  return {
    workspaceRoot: ws,
    root,
    backlog:      path.join(root, 'backlog'),
    runs:         path.join(root, 'runs'),
    tickets:      path.join(root, 'tickets'),
    taskPacks:    path.join(root, 'task-packs'),
    artifacts:    path.join(root, 'artifacts'),
    agents:       path.join(root, 'agents'),
    project:      path.join(root, 'project.json'),
    agentsConfig: path.join(root, 'agents.json'),
  };
}

/**
 * Return the list of subdirectory names that init-workspace must create.
 */
function subdirs() {
  return ['backlog', 'runs', 'tickets', 'task-packs', 'artifacts', 'agents'];
}

/**
 * Security: ensure a path resolves inside the workspace root.
 * @param {string} p — path segment relative to workspaceRoot
 * @param {string} [workspaceRoot]
 * @returns {string} resolved absolute path
 */
function safePath(p, workspaceRoot) {
  const ws = workspaceRoot || process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
  const resolved = path.resolve(ws, p);
  if (!resolved.startsWith(ws + path.sep) && resolved !== ws) {
    throw new Error(`Path outside workspace: ${resolved}`);
  }
  return resolved;
}

module.exports = { resolve, subdirs, safePath, CLAW_DIR };
