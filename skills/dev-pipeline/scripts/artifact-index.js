#!/usr/bin/env node
'use strict';

/**
 * artifact-index.js — Read-only global artifact index.
 *
 * Scans all runs across a workspace and classifies every artifact.
 * Returns a deterministic, filterable JSON payload.
 * Never creates, modifies, or deletes files.
 *
 * Usage (CLI):
 *   node artifact-index.js [--type <semantic_type>] [--project <id>] [--stage <stage>]
 *
 * Programmatic:
 *   const { buildArtifactIndex } = require('./artifact-index.js');
 *   const result = buildArtifactIndex({ workspaceRoot: '/path/to/repo' });
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { classifyRunArtifacts } = require('./artifact-classify.js');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');

// ---------------------------------------------------------------------------
// Core index builder
// ---------------------------------------------------------------------------

/**
 * Build the global artifact index for a workspace.
 *
 * @param {object} [options]
 * @param {string} [options.workspaceRoot] - Workspace root path.
 * @param {string} [options.filterType] - Filter by semantic_type.
 * @param {string} [options.filterProject] - Filter by project_id.
 * @param {string} [options.filterStage] - Filter by stage.
 * @param {object} [options.capabilityContext] - Capability context for enrichment.
 * @returns {object} Artifact index output conforming to artifact-index.output.schema.json.
 */
function buildArtifactIndex(options = {}) {
  const ws = options.workspaceRoot || WORKSPACE_ROOT;
  const runsDir = path.join(ws, '.claw', 'runs');

  if (!fs.existsSync(runsDir)) {
    return {
      ok: true,
      generated_at: new Date().toISOString(),
      artifacts: [],
      summary: { total_artifacts: 0, by_type: {}, by_project: {}, runs_scanned: 0 },
    };
  }

  const runDirs = fs.readdirSync(runsDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();

  let allArtifacts = [];
  let runsScanned = 0;

  for (const runName of runDirs) {
    const runPath = path.join(runsDir, runName);
    runsScanned++;

    // Read status.json for project_id
    let projectId = 'unknown';
    const statusPath = path.join(runPath, 'status.json');
    if (fs.existsSync(statusPath)) {
      try {
        const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
        projectId = status.project || 'unknown';
      } catch { /* ignore corrupt status */ }
    }

    // Classify all artifacts in this run
    const classified = classifyRunArtifacts(runPath, options.capabilityContext);

    for (const item of classified) {
      // Get file creation time
      let createdAt = new Date().toISOString();
      try {
        const stat = fs.statSync(path.join(runPath, item.artifact_file));
        createdAt = stat.birthtime.toISOString();
      } catch { /* use current time as fallback */ }

      allArtifacts.push({
        artifact_file: item.artifact_file,
        semantic_type: item.semantic_type,
        stage: item.stage,
        run_id: runName,
        project_id: projectId,
        created_at: createdAt,
        size_bytes: item.size_bytes,
        schema_file: item.schema_file,
        capability: item.capability,
      });
    }
  }

  // Apply filters
  if (options.filterType) {
    allArtifacts = allArtifacts.filter(a => a.semantic_type === options.filterType);
  }
  if (options.filterProject) {
    allArtifacts = allArtifacts.filter(a => a.project_id === options.filterProject);
  }
  if (options.filterStage) {
    allArtifacts = allArtifacts.filter(a => a.stage === options.filterStage);
  }

  // Sort deterministically: run_id ASC, semantic_type ASC, artifact_file ASC
  allArtifacts.sort((a, b) => {
    if (a.run_id !== b.run_id) return a.run_id.localeCompare(b.run_id);
    if (a.semantic_type !== b.semantic_type) return a.semantic_type.localeCompare(b.semantic_type);
    return a.artifact_file.localeCompare(b.artifact_file);
  });

  // Build summary
  const byType = {};
  const byProject = {};
  for (const a of allArtifacts) {
    byType[a.semantic_type] = (byType[a.semantic_type] || 0) + 1;
    byProject[a.project_id] = (byProject[a.project_id] || 0) + 1;
  }

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    artifacts: allArtifacts,
    summary: {
      total_artifacts: allArtifacts.length,
      by_type: byType,
      by_project: byProject,
      runs_scanned: runsScanned,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  const opts = { workspaceRoot: WORKSPACE_ROOT };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--type' && args[i + 1]) { opts.filterType = args[++i]; }
    else if (args[i] === '--project' && args[i + 1]) { opts.filterProject = args[++i]; }
    else if (args[i] === '--stage' && args[i + 1]) { opts.filterStage = args[++i]; }
  }

  const result = buildArtifactIndex(opts);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = { buildArtifactIndex };
