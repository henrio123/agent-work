#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// Security: all paths must resolve inside WORKSPACE_ROOT
// ---------------------------------------------------------------------------
const WORKSPACE_ROOT = path.resolve(os.homedir(), 'dev', 'agent-work');

function safePath(p) {
  const resolved = path.resolve(WORKSPACE_ROOT, p);
  if (!resolved.startsWith(WORKSPACE_ROOT + path.sep) && resolved !== WORKSPACE_ROOT) {
    throw new Error(`Path outside workspace: ${resolved}`);
  }
  return resolved;
}

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

function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function ok(data) {
  process.stdout.write(JSON.stringify({ ok: true, ...data }, null, 2) + '\n');
  process.exit(0);
}

function fail(msg) {
  process.stderr.write(JSON.stringify({ ok: false, error: msg }, null, 2) + '\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Old-format migration: normalize status.json on read
// ---------------------------------------------------------------------------
function normalizeStatus(s) {
  // project_name → project
  if (s.project_name && !s.project) {
    s.project = s.project_name;
    delete s.project_name;
  }
  // status → current_stage
  if (s.status && !s.current_stage) {
    s.current_stage = s.status;
    delete s.status;
  }
  // Ensure updated_at
  if (!s.updated_at) {
    s.updated_at = s.created_at || now();
  }
  // Migrate string array required_user_input → object array
  if (Array.isArray(s.required_user_input)) {
    s.required_user_input = s.required_user_input.map((item) => {
      if (typeof item === 'string') {
        return {
          id: crypto.randomUUID(),
          prompt: item,
          options: null,
          default: null,
          status: 'pending',
          answer: null,
        };
      }
      return item;
    });
  } else {
    s.required_user_input = [];
  }
  // Ensure stage_history
  if (!Array.isArray(s.stage_history)) {
    s.stage_history = [];
  }
  // Ensure next_actions
  if (!Array.isArray(s.next_actions)) {
    s.next_actions = [];
  }
  // Ensure blocked fields
  if (typeof s.blocked !== 'boolean') s.blocked = false;
  if (s.blocked_reason === undefined) s.blocked_reason = null;
  return s;
}

function readStatus(runFolder) {
  const statusPath = safePath(path.join(runFolder, 'status.json'));
  const raw = readJSON(statusPath);
  return normalizeStatus(raw);
}

function writeStatus(runFolder, data) {
  data.updated_at = now();
  const statusPath = safePath(path.join(runFolder, 'status.json'));
  writeJSON(statusPath, data);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdCreateRun(ticketId, title, project) {
  if (!ticketId || !title || !project) {
    fail('Usage: create_run <ticket_id> <title> <project>');
  }

  const ts = timestamp();
  const folderName = `${ts}_${ticketId}`;
  const runFolder = safePath(path.join('runs', folderName));

  fs.mkdirSync(runFolder, { recursive: true });

  const createdAt = now();

  // 00-intake.json
  const intake = {
    ticket_id: ticketId,
    title,
    project,
    created_at: createdAt,
    source: 'manual',
  };
  writeJSON(path.join(runFolder, '00-intake.json'), intake);

  // status.json (full schema)
  const status = {
    ticket_id: ticketId,
    title,
    project,
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
    next_actions: [
      {
        label: 'Generate task pack',
        command: `node {baseDir}/scripts/dev-pipeline.js generate_task_pack ${runFolder}`,
      },
    ],
  };
  writeJSON(path.join(runFolder, 'status.json'), status);

  ok({ run_folder: runFolder, status: 'intake' });
}

function cmdGenerateTaskPack(runFolder) {
  if (!runFolder) fail('Usage: generate_task_pack <run_folder>');

  runFolder = safePath(runFolder);
  const intake = readJSON(safePath(path.join(runFolder, '00-intake.json')));
  const templatePath = safePath(path.join('templates', 'claude-task-pack.txt'));
  let template = fs.readFileSync(templatePath, 'utf8');

  const project = intake.project || intake.project_name;
  template = template
    .replace(/\{\{TICKET_ID\}\}/g, intake.ticket_id)
    .replace(/\{\{TITLE\}\}/g, intake.title)
    .replace(/\{\{PROJECT_NAME\}\}/g, project)
    .replace(/\{\{RUN_FOLDER\}\}/g, runFolder);

  const artifactPath = path.join(runFolder, '30-dev-claude-task.txt');
  fs.writeFileSync(artifactPath, template, 'utf8');

  // Update status
  const status = readStatus(runFolder);
  const currentTime = now();

  // Close current stage
  const currentEntry = status.stage_history.find(
    (e) => e.stage === status.current_stage && !e.finished_at
  );
  if (currentEntry) currentEntry.finished_at = currentTime;

  // Add new stage
  status.stage_history.push({
    stage: 'task-pack-generated',
    started_at: currentTime,
    finished_at: null,
    artifact_paths: ['30-dev-claude-task.txt'],
  });
  status.current_stage = 'task-pack-generated';
  status.next_actions = [
    {
      label: 'Start development',
      command: `Use the task pack at ${artifactPath}`,
    },
  ];
  writeStatus(runFolder, status);

  ok({ artifact: '30-dev-claude-task.txt' });
}

function cmdBlock(runFolder, reason, ...prompts) {
  if (!runFolder || !reason) fail('Usage: block <run_folder> <reason> [prompt1] [prompt2] ...');

  runFolder = safePath(runFolder);
  const status = readStatus(runFolder);
  const currentTime = now();

  // Save previous stage so respond can restore it
  status._previous_stage = status.current_stage;

  // Close current stage
  const currentEntry = status.stage_history.find(
    (e) => e.stage === status.current_stage && !e.finished_at
  );
  if (currentEntry) currentEntry.finished_at = currentTime;

  status.blocked = true;
  status.blocked_reason = reason;
  status.current_stage = 'blocked';
  status.stage_history.push({
    stage: 'blocked',
    started_at: currentTime,
    finished_at: null,
    artifact_paths: [],
  });

  const inputs = prompts.map((prompt) => ({
    id: crypto.randomUUID(),
    prompt,
    options: null,
    default: null,
    status: 'pending',
    answer: null,
  }));
  status.required_user_input.push(...inputs);

  status.next_actions = inputs.map((inp) => ({
    label: `Answer: ${inp.prompt}`,
    command: `node {baseDir}/scripts/dev-pipeline.js respond ${runFolder} ${inp.id} <answer>`,
  }));

  writeStatus(runFolder, status);
  ok({ inputs: inputs.map((i) => ({ id: i.id, prompt: i.prompt })) });
}

function cmdRespond(runFolder, inputId, choice) {
  if (!runFolder || !inputId || choice === undefined) {
    fail('Usage: respond <run_folder> <input_id> <choice>');
  }

  runFolder = safePath(runFolder);
  const status = readStatus(runFolder);

  const input = status.required_user_input.find((i) => i.id === inputId);
  if (!input) fail(`Input not found: ${inputId}`);
  if (input.status === 'answered') fail(`Input already answered: ${inputId}`);

  input.status = 'answered';
  input.answer = choice;

  const allAnswered = status.required_user_input.every((i) => i.status === 'answered');
  let unblocked = false;

  if (allAnswered) {
    const currentTime = now();

    // Close blocked stage
    const blockedEntry = status.stage_history.find(
      (e) => e.stage === 'blocked' && !e.finished_at
    );
    if (blockedEntry) blockedEntry.finished_at = currentTime;

    // Restore previous stage
    const prevStage = status._previous_stage || 'intake';
    status.current_stage = prevStage;
    status.blocked = false;
    status.blocked_reason = null;
    delete status._previous_stage;

    status.stage_history.push({
      stage: prevStage,
      started_at: currentTime,
      finished_at: null,
      artifact_paths: [],
    });

    status.next_actions = [];
    unblocked = true;
  }

  writeStatus(runFolder, status);
  ok({ all_answered: allAnswered, unblocked });
}

function cmdList() {
  const runsDir = safePath('runs');
  if (!fs.existsSync(runsDir)) {
    ok({ runs: [] });
    return;
  }

  const entries = fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  const runs = [];
  for (const entry of entries) {
    const runFolder = path.join(runsDir, entry.name);
    const statusPath = path.join(runFolder, 'status.json');
    if (!fs.existsSync(statusPath)) continue;
    try {
      const s = normalizeStatus(readJSON(statusPath));
      runs.push({
        folder: runFolder,
        ticket_id: s.ticket_id,
        title: s.title,
        project: s.project,
        current_stage: s.current_stage,
        blocked: s.blocked,
      });
    } catch {
      // skip corrupt entries
    }
  }

  ok({ runs });
}

function cmdStatus(runFolder) {
  if (!runFolder) fail('Usage: status <run_folder>');
  runFolder = safePath(runFolder);
  const status = readStatus(runFolder);
  ok({ run: status });
}

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------
const [command, ...args] = process.argv.slice(2);

try {
  switch (command) {
    case 'create_run':
      cmdCreateRun(args[0], args[1], args[2]);
      break;
    case 'generate_task_pack':
      cmdGenerateTaskPack(args[0]);
      break;
    case 'block':
      cmdBlock(args[0], args[1], ...args.slice(2));
      break;
    case 'respond':
      cmdRespond(args[0], args[1], args[2]);
      break;
    case 'list':
      cmdList();
      break;
    case 'status':
      cmdStatus(args[0]);
      break;
    default:
      fail(`Unknown command: ${command || '(none)'}. Available: create_run, generate_task_pack, block, respond, list, status`);
  }
} catch (err) {
  fail(err.message);
}
