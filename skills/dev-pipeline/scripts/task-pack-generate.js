#!/usr/bin/env node
'use strict';

/**
 * task-pack-generate.js — Deterministic task pack generator.
 *
 * Produces a structured task pack JSON file for a backlog item by scanning
 * available project files, agents, backlog item metadata, linked run folder,
 * and SKILL.md patterns. No LLM calls — purely filesystem-driven inference.
 *
 * Never mutates existing runs. Only writes to projects/<project_id>/task-packs/.
 *
 * Usage (via CLI):
 *   node task-pack-generate.js <project_id> <task_id>
 *   node task-pack-generate.js validate <task_pack_path>
 *   node task-pack-generate.js list [project_id]
 *
 * Or require() for programmatic use:
 *   const { generateTaskPack, validateTaskPack, listTaskPacks } = require('./task-pack-generate.js');
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
const PROJECTS_DIR = path.join(WORKSPACE_ROOT, 'projects');

function safePath(p, workspaceRoot) {
  const root = workspaceRoot || WORKSPACE_ROOT;
  const resolved = path.resolve(root, p);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(`Path outside workspace: ${resolved}`);
  }
  return resolved;
}

function now() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Load task pack schema
// ---------------------------------------------------------------------------
function loadTaskPackSchema() {
  const schemaPath = path.resolve(__dirname, '..', 'schemas', 'task-pack.schema.json');
  return JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
}

// ---------------------------------------------------------------------------
// Generate a task pack for a backlog item
// ---------------------------------------------------------------------------
function generateTaskPack(projectId, taskId, options = {}) {
  const workspaceRoot = options.workspaceRoot || WORKSPACE_ROOT;
  const projectsDir = options.projectsDir || path.join(workspaceRoot, 'projects');
  const projectDir = path.join(projectsDir, projectId);

  // Validate project exists
  const projectJsonPath = path.join(projectDir, 'project.json');
  if (!fs.existsSync(projectJsonPath)) {
    return { ok: false, error: `project ${projectId} does not exist` };
  }

  let projectMeta;
  try {
    projectMeta = JSON.parse(fs.readFileSync(projectJsonPath, 'utf8'));
  } catch {
    return { ok: false, error: `invalid project.json for ${projectId}` };
  }

  // Find the backlog item
  const backlogDir = path.join(projectDir, 'backlog');
  let taskItem = null;
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
        // Skip invalid
      }
    }
  }

  if (!taskItem) {
    return { ok: false, error: `backlog item ${taskId} not found in project ${projectId}` };
  }

  // Scan inputs
  const inputsPresent = [];
  const references = [];
  const openQuestions = [];

  // project.json
  inputsPresent.push('project.json');
  references.push(`projects/${projectId}/project.json`);

  // agents.json
  const agentsPath = path.join(projectDir, 'agents.json');
  let agents = [];
  if (fs.existsSync(agentsPath)) {
    inputsPresent.push('agents.json');
    references.push(`projects/${projectId}/agents.json`);
    try {
      const agentsData = JSON.parse(fs.readFileSync(agentsPath, 'utf8'));
      agents = agentsData.agents || [];
    } catch {
      // Invalid — skip
    }
  } else {
    openQuestions.push('No agents.json found — which agent roles should own this task?');
  }

  // Backlog item itself
  inputsPresent.push(`backlog/${taskId}.json`);
  references.push(`projects/${projectId}/backlog/${taskId}.json`);

  // Check linked run folder
  if (taskItem.run_folder) {
    const runAbsDir = path.resolve(workspaceRoot, taskItem.run_folder);
    if (fs.existsSync(runAbsDir)) {
      inputsPresent.push(taskItem.run_folder);
      references.push(taskItem.run_folder);

      // Scan for existing artifacts in the run
      const runFiles = fs.readdirSync(runAbsDir).filter((f) => !f.startsWith('.'));
      for (const file of runFiles) {
        if (file !== 'status.json' && file !== '00-intake.json') {
          inputsPresent.push(`${taskItem.run_folder}/${file}`);
        }
      }
    }
  }

  // SKILL.md reference
  const skillMdPath = path.resolve(__dirname, '..', 'SKILL.md');
  if (fs.existsSync(skillMdPath)) {
    references.push('skills/dev-pipeline/SKILL.md');
  }

  // Infer artifacts expected from the stage config
  const artifactsExpected = taskItem.artifacts_expected || [];
  if (artifactsExpected.length === 0) {
    // Default: expect the standard pipeline artifacts
    artifactsExpected.push(
      '10-pm-brief.json',
      '20-arch-design.json',
      '40-dev-patch.diff',
      '41-dev-notes.json',
      '50-qa-report.json',
      '60-review-report.json'
    );
  }

  // Build acceptance criteria from task description
  const acceptanceCriteria = [];
  if (taskItem.description) {
    acceptanceCriteria.push(`Task "${taskItem.title}" is completed as described`);
  } else {
    acceptanceCriteria.push(`Task "${taskItem.title}" is completed`);
    openQuestions.push('Task has no description — what are the detailed requirements?');
  }
  acceptanceCriteria.push('All pipeline artifacts pass schema validation');
  acceptanceCriteria.push('No regressions in existing test suite');

  // Build constraints
  const constraints = ['Zero external npm dependencies', 'All outputs must be JSON and schema-validated'];

  // Infer suggested next agents from owner_role and agent definitions
  const suggestedNextAgents = [];
  if (taskItem.owner_role) {
    suggestedNextAgents.push(taskItem.owner_role);
  }
  // Add the natural pipeline sequence
  const roleSequence = ['PM', 'ARCHITECT', 'DEV', 'QA'];
  const ownerIdx = roleSequence.indexOf(taskItem.owner_role);
  if (ownerIdx !== -1 && ownerIdx < roleSequence.length - 1) {
    suggestedNextAgents.push(roleSequence[ownerIdx + 1]);
  }

  // Check for dependency tasks
  if (taskItem.depends_on && taskItem.depends_on.length > 0) {
    // Check if dependencies are done
    for (const depId of taskItem.depends_on) {
      let depDone = false;
      if (fs.existsSync(backlogDir)) {
        const files = fs.readdirSync(backlogDir).filter((f) => f.endsWith('.json'));
        for (const file of files) {
          try {
            const dep = JSON.parse(fs.readFileSync(path.join(backlogDir, file), 'utf8'));
            if (dep.id === depId && dep.status === 'done') {
              depDone = true;
            }
          } catch {
            // Skip
          }
        }
      }
      if (!depDone) {
        openQuestions.push(`Dependency "${depId}" is not yet done — should this task start?`);
      }
    }
  }

  const ts = now();
  const taskPack = {
    task_id: taskId,
    project_id: projectId,
    title: taskItem.title || taskId,
    description: taskItem.description || '',
    owner_role: taskItem.owner_role || 'DEV',
    inputs_present: inputsPresent,
    open_questions: openQuestions,
    artifacts_expected: artifactsExpected,
    acceptance_criteria: acceptanceCriteria,
    constraints,
    suggested_next_agents: suggestedNextAgents,
    references,
    created_at: ts,
    updated_at: ts,
  };

  // Write the task pack
  const taskPacksDir = path.join(projectDir, 'task-packs');
  fs.mkdirSync(taskPacksDir, { recursive: true });
  const taskPackPath = path.join(taskPacksDir, `${taskId}.json`);
  fs.writeFileSync(taskPackPath, JSON.stringify(taskPack, null, 2) + '\n', 'utf8');

  return {
    ok: true,
    task_pack_path: `projects/${projectId}/task-packs/${taskId}.json`,
    task_pack: taskPack,
  };
}

// ---------------------------------------------------------------------------
// Validate a task pack against schema
// ---------------------------------------------------------------------------
function validateTaskPack(taskPackPathOrData, options = {}) {
  const { validateAgainstSchema } = require(path.resolve(__dirname, 'validate-json-schema.js'));
  const schema = loadTaskPackSchema();

  let data;
  if (typeof taskPackPathOrData === 'string') {
    const workspaceRoot = options.workspaceRoot || WORKSPACE_ROOT;
    const absPath = path.resolve(workspaceRoot, taskPackPathOrData);
    if (!fs.existsSync(absPath)) {
      return { ok: false, error: `file not found: ${taskPackPathOrData}` };
    }
    try {
      data = JSON.parse(fs.readFileSync(absPath, 'utf8'));
    } catch (e) {
      return { ok: false, error: `invalid JSON: ${e.message}` };
    }
  } else {
    data = taskPackPathOrData;
  }

  return validateAgainstSchema(data, schema);
}

// ---------------------------------------------------------------------------
// List task packs across projects
// ---------------------------------------------------------------------------
function listTaskPacks(options = {}) {
  const workspaceRoot = options.workspaceRoot || WORKSPACE_ROOT;
  const projectsDir = options.projectsDir || path.join(workspaceRoot, 'projects');
  const filterProjectId = options.projectId || null;

  if (!fs.existsSync(projectsDir)) {
    return { ok: true, task_packs: [] };
  }

  const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const taskPacks = [];

  for (const projectId of projectDirs) {
    if (filterProjectId && projectId !== filterProjectId) continue;

    const taskPacksDir = path.join(projectsDir, projectId, 'task-packs');
    if (!fs.existsSync(taskPacksDir)) continue;

    const files = fs.readdirSync(taskPacksDir)
      .filter((f) => f.endsWith('.json'))
      .sort();

    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(taskPacksDir, file), 'utf8'));
        taskPacks.push({
          project_id: projectId,
          task_id: data.task_id || file.replace('.json', ''),
          title: data.title || '',
          owner_role: data.owner_role || '',
          open_questions_count: (data.open_questions || []).length,
          file_path: `projects/${projectId}/task-packs/${file}`,
          created_at: data.created_at || null,
        });
      } catch {
        // Skip invalid
      }
    }
  }

  return { ok: true, task_packs: taskPacks };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    process.stderr.write(JSON.stringify({
      ok: false,
      error: 'Usage: node task-pack-generate.js <project_id> <task_id> | validate <path> | list [project_id]',
    }) + '\n');
    process.exit(1);
  }

  const command = args[0];

  if (command === 'validate') {
    if (args.length < 2) {
      process.stderr.write(JSON.stringify({ ok: false, error: 'validate requires a file path' }) + '\n');
      process.exit(1);
    }
    const result = validateTaskPack(args[1]);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.ok ? 0 : 1);
  } else if (command === 'list') {
    const result = listTaskPacks({ projectId: args[1] || null });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(0);
  } else {
    // generate: <project_id> <task_id>
    const projectId = args[0];
    const taskId = args[1];
    if (!taskId) {
      process.stderr.write(JSON.stringify({ ok: false, error: 'task_id required' }) + '\n');
      process.exit(1);
    }
    const result = generateTaskPack(projectId, taskId);
    if (!result.ok) {
      process.stderr.write(JSON.stringify(result, null, 2) + '\n');
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = { generateTaskPack, validateTaskPack, listTaskPacks };
