#!/usr/bin/env node
'use strict';

/**
 * init-workspace.js — Bootstrap .claw/ directory structure in a target repo.
 *
 * Creates:
 *   <workspace>/.claw/
 *   <workspace>/.claw/backlog/
 *   <workspace>/.claw/runs/
 *   <workspace>/.claw/tickets/
 *   <workspace>/.claw/task-packs/
 *   <workspace>/.claw/artifacts/
 *   <workspace>/.claw/agents/
 *   <workspace>/.claw/project.json   (scaffold with project_id)
 *   <workspace>/.claw/agents.json    (scaffold with empty agents array)
 *
 * Usage (CLI):
 *   node init-workspace.js --workspace /path/to/target-repo --project_id my-project --title "My Project"
 *
 * Programmatic:
 *   const { initWorkspace } = require('./init-workspace');
 *   const result = initWorkspace({ workspaceRoot, projectId, title, description });
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const wp = require('./workspace-paths');
const { validateAgainstSchema } = require('./validate-json-schema');

const projectSchema = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'project.schema.json'), 'utf8')
);
const agentsSchema = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'schemas', 'agents.schema.json'), 'utf8')
);

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------
function initWorkspace(params) {
  const {
    workspaceRoot,
    projectId,
    title,
    description = '',
  } = params || {};

  if (!workspaceRoot) {
    return { ok: false, error: 'workspaceRoot is required' };
  }
  if (!projectId) {
    return { ok: false, error: 'projectId is required' };
  }
  if (!title) {
    return { ok: false, error: 'title is required' };
  }

  // Resolve workspace root
  const resolvedWs = path.resolve(workspaceRoot);
  if (!fs.existsSync(resolvedWs)) {
    return { ok: false, error: `Workspace root does not exist: ${resolvedWs}` };
  }

  const paths = wp.resolve(resolvedWs);

  // Check if already initialized
  if (fs.existsSync(paths.root)) {
    // Check if project.json exists
    if (fs.existsSync(paths.project)) {
      return { ok: false, error: `.claw/ already initialized at ${paths.root}` };
    }
  }

  // Create directory structure
  const created = [];
  fs.mkdirSync(paths.root, { recursive: true });
  created.push(paths.root);

  for (const sub of wp.subdirs()) {
    const dir = path.join(paths.root, sub);
    fs.mkdirSync(dir, { recursive: true });
    created.push(dir);
  }

  // Build project.json
  const now = new Date().toISOString();
  const projectData = {
    project_id: projectId,
    title,
    description,
    repo_path: resolvedWs,
    created_at: now,
    updated_at: now,
  };

  // Validate project.json against schema
  const pv = validateAgainstSchema(projectData, projectSchema);
  if (!pv.ok) {
    // Cleanup on failure
    try { fs.rmSync(paths.root, { recursive: true, force: true }); } catch {}
    return { ok: false, error: `project.json schema validation failed: ${(pv.details || []).join('; ')}` };
  }

  // Build agents.json
  const agentsData = { agents: [] };
  const av = validateAgainstSchema(agentsData, agentsSchema);
  if (!av.ok) {
    try { fs.rmSync(paths.root, { recursive: true, force: true }); } catch {}
    return { ok: false, error: `agents.json schema validation failed: ${(av.details || []).join('; ')}` };
  }

  // Write files
  fs.writeFileSync(paths.project, JSON.stringify(projectData, null, 2) + '\n', 'utf8');
  fs.writeFileSync(paths.agentsConfig, JSON.stringify(agentsData, null, 2) + '\n', 'utf8');

  return {
    ok: true,
    action: 'initialized',
    workspace_root: resolvedWs,
    claw_root: paths.root,
    project_id: projectId,
    created_dirs: created,
    files_written: [paths.project, paths.agentsConfig],
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

  const workspaceRoot = getArg('workspace') || process.env.WORKSPACE_ROOT;
  const projectId = getArg('project_id');
  const title = getArg('title');
  const description = getArg('description') || '';

  if (!workspaceRoot || !projectId || !title) {
    const err = { ok: false, error: 'Usage: init-workspace.js --workspace <path> --project_id <id> --title <title> [--description <desc>]' };
    process.stderr.write(JSON.stringify(err, null, 2) + '\n');
    process.exit(1);
  }

  const result = initWorkspace({ workspaceRoot, projectId, title, description });
  if (!result.ok) {
    process.stderr.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(0);
}

module.exports = { initWorkspace };
