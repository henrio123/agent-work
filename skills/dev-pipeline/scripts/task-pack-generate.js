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

const { buildArtifactIndex } = require(path.resolve(__dirname, 'artifact-index.js'));
const { readMemory } = require(path.resolve(__dirname, 'agent-memory.js'));

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
// Gather prior knowledge from artifact index + agent memory
// ---------------------------------------------------------------------------
const MAX_PRIOR_ARTIFACTS = 5;
const MAX_PRIOR_MEMORIES = 5;
const MAX_PRIOR_FINDINGS = 3;

function gatherPriorKnowledge(projectId, workspaceRoot) {
  const result = {
    related_artifacts: [],
    agent_memories: [],
    related_findings: [],
  };

  // 1. Scan artifact index for same project (most recent runs first)
  try {
    const index = buildArtifactIndex({
      workspaceRoot,
      filterProject: projectId,
    });

    if (index.ok && index.artifacts.length > 0) {
      // Artifacts are sorted by run_id ASC → take from end for most recent
      // Exclude metadata and task artifacts — they're not useful context
      const meaningful = index.artifacts.filter(
        (a) => !['metadata', 'task'].includes(a.semantic_type)
      );

      // Take most recent N (from end of sorted array)
      const recent = meaningful.slice(Math.max(0, meaningful.length - MAX_PRIOR_ARTIFACTS));

      for (const art of recent) {
        result.related_artifacts.push({
          artifact_file: art.artifact_file,
          run_id: art.run_id,
          semantic_type: art.semantic_type,
          relevance: 'same-project',
        });
      }
    }
  } catch {
    // Non-fatal — missing index means no prior artifacts
  }

  // 2. Scan agent memory for same project (all agents, most recent entries)
  try {
    const agentsDir = path.join(workspaceRoot, '.claw', 'agents');
    if (fs.existsSync(agentsDir)) {
      const agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);

      let allMemories = [];
      for (const agentId of agentDirs) {
        try {
          const mem = readMemory({
            agentId,
            filterProject: projectId,
            workspaceRoot,
          });
          if (mem.ok && mem.entries.length > 0) {
            allMemories.push(...mem.entries);
          }
        } catch {
          // Skip agents with unreadable memory
        }
      }

      // Sort by created_at descending (most recent first) and take top N
      allMemories.sort((a, b) => b.created_at.localeCompare(a.created_at));
      const topMemories = allMemories.slice(0, MAX_PRIOR_MEMORIES);

      for (const mem of topMemories) {
        result.agent_memories.push({
          content: mem.content,
          type: mem.type,
          from_run: mem.run_id,
        });
      }
    }
  } catch {
    // Non-fatal — missing agents dir means no memories
  }

  // 3. Scan for research findings in same project
  try {
    const runsDir = path.join(workspaceRoot, '.claw', 'runs');
    if (fs.existsSync(runsDir)) {
      const runDirs = fs.readdirSync(runsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
        .reverse(); // most recent first

      let findingsCount = 0;
      for (const runName of runDirs) {
        if (findingsCount >= MAX_PRIOR_FINDINGS) break;

        const runDir = path.join(runsDir, runName);
        const findingsPath = path.join(runDir, '18-research-findings.json');
        if (!fs.existsSync(findingsPath)) continue;

        // Check this run belongs to same project
        const statusPath = path.join(runDir, 'status.json');
        if (fs.existsSync(statusPath)) {
          try {
            const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
            if (status.project !== projectId) continue;
          } catch {
            continue;
          }
        }

        try {
          const findings = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
          result.related_findings.push({
            run_id: runName,
            conclusion: findings.conclusion || '',
            hypothesis_count: (findings.hypotheses || []).length,
            finding_count: (findings.findings || []).length,
          });
          findingsCount++;
        } catch {
          // Skip malformed findings
        }
      }
    }
  } catch {
    // Non-fatal
  }

  return result;
}

// ---------------------------------------------------------------------------
// Generate a task pack for a backlog item
// ---------------------------------------------------------------------------
function generateTaskPack(projectId, taskId, options = {}) {
  const workspaceRoot = options.workspaceRoot || WORKSPACE_ROOT;
  const clawRoot = path.join(workspaceRoot, '.claw');

  // Validate project exists
  const projectJsonPath = options.projectJsonPath || path.join(clawRoot, 'project.json');
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
  const backlogDir = options.backlogDir || path.join(clawRoot, 'backlog');
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
  references.push('.claw/project.json');

  // agents.json
  const agentsPath = path.join(clawRoot, 'agents.json');
  let agents = [];
  if (fs.existsSync(agentsPath)) {
    inputsPresent.push('agents.json');
    references.push('.claw/agents.json');
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
  references.push(`.claw/backlog/${taskId}.json`);

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

  // -----------------------------------------------------------------------
  // Gather prior knowledge from artifact index + agent memory
  // -----------------------------------------------------------------------
  const priorKnowledge = gatherPriorKnowledge(projectId, workspaceRoot);

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
    prior_knowledge: priorKnowledge,
    created_at: ts,
    updated_at: ts,
  };

  // Write the task pack
  const taskPacksDir = options.taskPacksDir || path.join(clawRoot, 'task-packs');
  fs.mkdirSync(taskPacksDir, { recursive: true });
  const taskPackPath = path.join(taskPacksDir, `${taskId}.json`);
  fs.writeFileSync(taskPackPath, JSON.stringify(taskPack, null, 2) + '\n', 'utf8');

  return {
    ok: true,
    task_pack_path: `.claw/task-packs/${taskId}.json`,
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
  const taskPacksDir = options.taskPacksDir || path.join(workspaceRoot, '.claw', 'task-packs');

  if (!fs.existsSync(taskPacksDir)) {
    return { ok: true, task_packs: [] };
  }

  const taskPacks = [];
  const files = fs.readdirSync(taskPacksDir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(taskPacksDir, file), 'utf8'));
      taskPacks.push({
        project_id: data.project_id || '',
        task_id: data.task_id || file.replace('.json', ''),
        title: data.title || '',
        owner_role: data.owner_role || '',
        open_questions_count: (data.open_questions || []).length,
        file_path: `.claw/task-packs/${file}`,
        created_at: data.created_at || null,
      });
    } catch {
      // Skip invalid
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
module.exports = { generateTaskPack, validateTaskPack, listTaskPacks, gatherPriorKnowledge };
