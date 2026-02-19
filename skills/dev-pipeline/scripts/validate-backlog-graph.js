#!/usr/bin/env node
'use strict';

/**
 * validate-backlog-graph.js — Read-only DAG validator for backlog dependency and parent graphs.
 *
 * Reads all backlog items for a project, builds a directed graph from depends_on
 * and parent_id edges, validates it is a DAG, detects cycles, and validates
 * parent_id references.
 *
 * Usage (CLI):
 *   node validate-backlog-graph.js <project_id> [--projects_dir <path>]
 *
 * Programmatic:
 *   const { validateBacklogGraph } = require('./validate-backlog-graph.js');
 *   const result = validateBacklogGraph('my-project', { projectsDir });
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = path.resolve(os.homedir(), 'dev', 'agent-work');
const PROJECTS_DIR = path.join(WORKSPACE_ROOT, 'projects');

// ---------------------------------------------------------------------------
// Core validator
// ---------------------------------------------------------------------------
function validateBacklogGraph(projectId, options) {
  const projectsDir = options && options.projectsDir ? options.projectsDir : PROJECTS_DIR;

  const projectDir = path.join(projectsDir, projectId);
  if (!fs.existsSync(projectDir)) {
    return { ok: false, error: `Project directory not found: ${projectId}` };
  }

  const backlogDir = path.join(projectDir, 'backlog');
  const items = [];

  if (fs.existsSync(backlogDir)) {
    const files = fs.readdirSync(backlogDir)
      .filter(f => f.endsWith('.json'))
      .sort();

    for (const file of files) {
      try {
        const item = JSON.parse(fs.readFileSync(path.join(backlogDir, file), 'utf8'));
        items.push({
          id: item.id || '',
          type: item.type || 'task',
          status: item.status || 'todo',
          depends_on: Array.isArray(item.depends_on) ? item.depends_on : [],
          parent_id: item.parent_id || null,
        });
      } catch {
        // Skip invalid JSON
      }
    }
  }

  // Build lookup
  const byId = new Map();
  for (const item of items) {
    byId.set(item.id, item);
  }

  const cycles = [];
  const parentErrors = [];
  const warnings = [];
  let dependsOnEdgeCount = 0;
  let parentChildEdgeCount = 0;

  // --- depends_on edge counting and dangling detection ---
  const adjList = new Map(); // id -> [ids that depend on it] (forward edges for topo sort: dep -> item)
  const inDegree = new Map();

  for (const item of items) {
    if (!adjList.has(item.id)) adjList.set(item.id, []);
    if (!inDegree.has(item.id)) inDegree.set(item.id, 0);

    for (const depId of item.depends_on) {
      if (!byId.has(depId)) {
        warnings.push(`${item.id}: depends_on '${depId}' does not exist`);
        continue;
      }
      dependsOnEdgeCount++;
      // Edge: depId -> item.id (depId must finish before item can start)
      if (!adjList.has(depId)) adjList.set(depId, []);
      adjList.get(depId).push(item.id);
      inDegree.set(item.id, (inDegree.get(item.id) || 0) + 1);
    }
  }

  // --- Cycle detection via Kahn's algorithm ---
  const queue = [];
  for (const item of items) {
    if ((inDegree.get(item.id) || 0) === 0) {
      queue.push(item.id);
    }
  }

  const sorted = [];
  while (queue.length > 0) {
    const node = queue.shift();
    sorted.push(node);
    for (const neighbor of (adjList.get(node) || [])) {
      const deg = inDegree.get(neighbor) - 1;
      inDegree.set(neighbor, deg);
      if (deg === 0) queue.push(neighbor);
    }
  }

  // Nodes not in sorted output are part of cycles
  const sortedSet = new Set(sorted);
  const cycleNodes = items.filter(i => !sortedSet.has(i.id)).map(i => i.id);

  if (cycleNodes.length > 0) {
    // Extract cycle path(s) via DFS from cycle nodes
    const cyclePaths = extractCycles(cycleNodes, byId);
    for (const cp of cyclePaths) {
      cycles.push(cp);
    }
  }

  // --- parent_id validation ---
  for (const item of items) {
    if (item.parent_id === null) continue;

    parentChildEdgeCount++;

    if (item.parent_id === item.id) {
      parentErrors.push(`${item.id}: parent_id is self-referencing`);
      continue;
    }

    const parent = byId.get(item.parent_id);
    if (!parent) {
      parentErrors.push(`${item.id}: parent_id '${item.parent_id}' does not exist`);
      continue;
    }

    if (parent.type !== 'epic') {
      parentErrors.push(`${item.id}: parent_id '${item.parent_id}' has type '${parent.type}', expected 'epic'`);
    }
  }

  // --- Circular parent chain detection ---
  for (const item of items) {
    if (item.parent_id === null) continue;
    const visited = new Set();
    let current = item.id;
    while (current) {
      if (visited.has(current)) {
        parentErrors.push(`${item.id}: circular parent chain detected`);
        break;
      }
      visited.add(current);
      const node = byId.get(current);
      current = node ? node.parent_id : null;
    }
  }

  const valid = cycles.length === 0 && parentErrors.length === 0;

  return {
    ok: true,
    project_id: projectId,
    valid,
    nodes: items.length,
    edges: { depends_on: dependsOnEdgeCount, parent_child: parentChildEdgeCount },
    cycles,
    parent_errors: parentErrors,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Extract cycle paths from nodes known to be in cycles
// ---------------------------------------------------------------------------
function extractCycles(cycleNodeIds, byId) {
  const cycleSet = new Set(cycleNodeIds);
  const visited = new Set();
  const paths = [];

  for (const startId of cycleNodeIds) {
    if (visited.has(startId)) continue;

    // DFS to find the cycle path
    const path = [];
    const onStack = new Set();
    let found = false;

    function dfs(nodeId) {
      if (found) return;
      if (onStack.has(nodeId)) {
        // Found cycle — extract from the repeated node onward
        const idx = path.indexOf(nodeId);
        const cyclePath = path.slice(idx);
        cyclePath.push(nodeId); // close the cycle
        paths.push(cyclePath);
        found = true;
        return;
      }
      if (visited.has(nodeId)) return;
      if (!cycleSet.has(nodeId)) return;

      onStack.add(nodeId);
      path.push(nodeId);

      const node = byId.get(nodeId);
      if (node) {
        for (const depId of node.depends_on) {
          if (cycleSet.has(depId)) {
            dfs(depId);
            if (found) return;
          }
        }
      }

      onStack.delete(nodeId);
      path.pop();
      visited.add(nodeId);
    }

    dfs(startId);
  }

  return paths;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);

  const projDirIdx = args.indexOf('--projects_dir');
  let projectsDir = PROJECTS_DIR;
  if (projDirIdx !== -1) {
    projectsDir = args[projDirIdx + 1] || PROJECTS_DIR;
    args.splice(projDirIdx, 2);
  }

  const projectId = args[0];
  if (!projectId) {
    process.stderr.write(JSON.stringify({ ok: false, error: 'Usage: validate-backlog-graph <project_id> [--projects_dir <path>]' }, null, 2) + '\n');
    process.exit(1);
  }

  const result = validateBacklogGraph(projectId, { projectsDir });
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
module.exports = { validateBacklogGraph };
