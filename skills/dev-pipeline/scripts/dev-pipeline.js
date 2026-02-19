#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const TOOL_VERSION = '0.1.0';

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

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const fields = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    fields[key] = val;
  }
  return fields;
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function getGitHead() {
  try {
    const headPath = path.join(WORKSPACE_ROOT, '.git', 'HEAD');
    const head = fs.readFileSync(headPath, 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const refPath = path.join(WORKSPACE_ROOT, '.git', head.slice(5));
      return fs.readFileSync(refPath, 'utf8').trim();
    }
    return head; // detached HEAD
  } catch {
    return null;
  }
}

function writeRunManifest(runFolder, ticketId, createdAt) {
  const manifest = {
    ticket_id: ticketId,
    created_at: createdAt,
    tool_version: TOOL_VERSION,
    schema_version: '1.0.0',
    git_head: getGitHead(),
  };
  writeJSON(path.join(runFolder, 'run-manifest.json'), manifest);
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

  // run-manifest.json
  writeRunManifest(runFolder, ticketId, createdAt);

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
        artifact_paths: ['00-intake.json', 'run-manifest.json'],
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

function cmdCreateRunFromTicket(ticketId) {
  if (!ticketId) fail('Usage: create_run_from_ticket <ticket_id>');

  // safePath prevents traversal in ticket_id (e.g. ../foo)
  const ticketPath = safePath(path.join('tickets', `${ticketId}.md`));
  if (!fs.existsSync(ticketPath)) {
    fail(`Ticket file not found: tickets/${ticketId}.md`);
  }

  const text = fs.readFileSync(ticketPath, 'utf8');
  const fm = parseFrontmatter(text);

  if (!fm.ticket_id) fail('Missing required frontmatter field: ticket_id');
  if (!fm.title) fail('Missing required frontmatter field: title');
  if (!fm.project) fail('Missing required frontmatter field: project');

  const ts = timestamp();
  const folderName = `${ts}_${fm.ticket_id}`;
  const runFolder = safePath(path.join('runs', folderName));

  fs.mkdirSync(runFolder, { recursive: true });

  const createdAt = now();

  const intake = {
    ticket_id: fm.ticket_id,
    title: fm.title,
    project: fm.project,
    created_at: createdAt,
    source: 'ticket',
  };
  writeJSON(path.join(runFolder, '00-intake.json'), intake);

  // run-manifest.json
  writeRunManifest(runFolder, fm.ticket_id, createdAt);

  const status = {
    ticket_id: fm.ticket_id,
    title: fm.title,
    project: fm.project,
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
        artifact_paths: ['00-intake.json', 'run-manifest.json'],
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

  ok({
    run_folder: runFolder,
    status: 'intake',
    ticket_id: fm.ticket_id,
    title: fm.title,
    project: fm.project,
  });
}

// ---------------------------------------------------------------------------
// Stale policy
// ---------------------------------------------------------------------------
const STALE_THRESHOLDS = {
  'intake': 48 * 60 * 60 * 1000,              // 48 hours
  'task-pack-generated': 7 * 24 * 60 * 60 * 1000, // 7 days
  'blocked': 7 * 24 * 60 * 60 * 1000,             // 7 days
};

function getStaleRuns() {
  const runsDir = safePath('runs');
  if (!fs.existsSync(runsDir)) return [];

  const entries = fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory());

  const nowMs = Date.now();
  const stale = [];

  for (const entry of entries) {
    const runFolder = path.join(runsDir, entry.name);
    const statusPath = path.join(runFolder, 'status.json');

    if (!fs.existsSync(statusPath)) {
      stale.push({
        folder: runFolder,
        ticket_id: null,
        current_stage: null,
        updated_at: null,
        reason: 'status.json missing or unreadable',
      });
      continue;
    }

    try {
      const s = normalizeStatus(readJSON(statusPath));
      const threshold = STALE_THRESHOLDS[s.current_stage];
      if (!threshold) continue;

      const updatedMs = new Date(s.updated_at).getTime();
      if (nowMs - updatedMs > threshold) {
        const daysAgo = Math.floor((nowMs - updatedMs) / (24 * 60 * 60 * 1000));
        stale.push({
          folder: runFolder,
          ticket_id: s.ticket_id,
          current_stage: s.current_stage,
          updated_at: s.updated_at,
          reason: `${s.current_stage} for ${daysAgo} days`,
        });
      }
    } catch {
      stale.push({
        folder: runFolder,
        ticket_id: null,
        current_stage: null,
        updated_at: null,
        reason: 'status.json missing or unreadable',
      });
    }
  }

  return stale;
}

function cmdStaleList() {
  const stale = getStaleRuns();
  ok({ stale, count: stale.length });
}

function cmdStaleDelete(args) {
  if (!args.includes('--confirm')) {
    fail('Safety: pass --confirm to actually delete stale runs. Run stale_list first to review.');
  }

  const stale = getStaleRuns();
  if (stale.length === 0) {
    ok({ deleted: [], count: 0 });
    return;
  }

  const deleted = [];
  for (const run of stale) {
    const folder = safePath(run.folder);
    // Extra guard: must be inside runs/
    const runsDir = safePath('runs');
    if (!folder.startsWith(runsDir + path.sep)) {
      continue;
    }
    fs.rmSync(folder, { recursive: true, force: true });
    deleted.push({ folder: run.folder, ticket_id: run.ticket_id, reason: run.reason });
  }

  ok({ deleted, count: deleted.length });
}

// ---------------------------------------------------------------------------
// Orchestration: stage machine, roles, schema validation
// ---------------------------------------------------------------------------
const STAGE_CONFIG = {
  'pm-ready': {
    role: 'PM',
    requiredArtifacts: ['10-pm-brief.json'],
    taskFile: '31-pm-claude-task.txt',
    template: 'claude-pm-pack.txt',
    next: 'arch-ready',
  },
  'arch-ready': {
    role: 'Architect',
    requiredArtifacts: ['20-arch-design.json'],
    taskFile: '32-arch-claude-task.txt',
    template: 'claude-arch-pack.txt',
    next: 'dev-ready',
  },
  'dev-ready': {
    role: 'Dev',
    requiredArtifacts: ['40-dev-patch.diff', '41-dev-notes.json'],
    taskFile: '33-dev-claude-task.txt',
    template: 'claude-dev-pack.txt',
    next: 'qa-ready',
  },
  'qa-ready': {
    role: 'QA',
    requiredArtifacts: ['50-qa-report.json'],
    taskFile: '34-qa-claude-task.txt',
    template: 'claude-qa-pack.txt',
    next: 'review',
  },
  'review': {
    role: 'Review',
    requiredArtifacts: ['60-review-report.json'],
    taskFile: '35-review-claude-task.txt',
    template: 'claude-review-pack.txt',
    next: 'done',
  },
};

const ARTIFACT_SCHEMA_MAP = {
  '10-pm-brief.json': 'pm-brief.schema.json',
  '20-arch-design.json': 'arch-design.schema.json',
  '41-dev-notes.json': 'dev-notes.schema.json',
  '50-qa-report.json': 'qa-report.schema.json',
  '60-review-report.json': 'review-report.schema.json',
};

// Minimal JSON schema validator (supports type, required, properties, enum, items, additionalProperties)
function validateSchema(value, schema, pathStr) {
  pathStr = pathStr || '$';
  const errors = [];

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (!types.includes(actual)) {
      errors.push(`${pathStr}: expected ${types.join('|')}, got ${actual}`);
      return errors;
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${pathStr}: must be one of [${schema.enum.join(', ')}], got "${value}"`);
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in value) || value[key] === undefined) {
          errors.push(`${pathStr}.${key}: required field missing`);
        }
      }
    }
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in value && value[key] !== undefined) {
          errors.push(...validateSchema(value[key], propSchema, `${pathStr}.${key}`));
        }
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties)) {
          errors.push(`${pathStr}.${key}: additional property not allowed`);
        }
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      errors.push(...validateSchema(value[i], schema.items, `${pathStr}[${i}]`));
    }
  }

  return errors;
}

function loadArtifactSchema(artifactFilename) {
  const schemaName = ARTIFACT_SCHEMA_MAP[artifactFilename];
  if (!schemaName) return null;
  const schemaPath = safePath(path.join('skills', 'dev-pipeline', 'references', schemaName));
  if (!fs.existsSync(schemaPath)) return null;
  return readJSON(schemaPath);
}

function validateArtifact(runFolder, artifactFilename) {
  const artifactPath = path.join(runFolder, artifactFilename);
  if (!fs.existsSync(artifactPath)) {
    return { valid: false, errors: [`${artifactFilename}: file not found`] };
  }

  // .diff files: just check non-empty
  if (artifactFilename.endsWith('.diff')) {
    const content = fs.readFileSync(artifactPath, 'utf8').trim();
    if (!content) return { valid: false, errors: [`${artifactFilename}: file is empty`] };
    return { valid: true, errors: [] };
  }

  // JSON files: parse and validate
  let data;
  try {
    data = readJSON(artifactPath);
  } catch (e) {
    return { valid: false, errors: [`${artifactFilename}: invalid JSON — ${e.message}`] };
  }

  const schema = loadArtifactSchema(artifactFilename);
  if (!schema) {
    return { valid: true, errors: [] }; // no schema = pass
  }

  const errors = validateSchema(data, schema);
  return { valid: errors.length === 0, errors };
}

function getNextStageInfo(runFolder, status) {
  const stage = status.current_stage;

  if (stage === 'done') return { next_stage: null, role: null, message: 'Run is complete' };
  if (stage === 'blocked') return { next_stage: null, role: null, blocked: true };
  if (stage === 'intake') return { next_stage: 'task-pack-generated', role: null, action: 'generate_task_pack' };

  if (stage === 'task-pack-generated') {
    return { next_stage: 'pm-ready', role: 'PM', required_artifacts: ['10-pm-brief.json'] };
  }

  const config = STAGE_CONFIG[stage];
  if (!config) return { next_stage: null, role: null, error: `Unknown stage: ${stage}` };

  // Check if current stage's required artifacts are present and valid
  const missing = [];
  const invalid = [];
  for (const artifact of config.requiredArtifacts) {
    const result = validateArtifact(runFolder, artifact);
    if (!fs.existsSync(path.join(runFolder, artifact))) {
      missing.push(artifact);
    } else if (!result.valid) {
      invalid.push({ artifact, errors: result.errors });
    }
  }

  if (missing.length > 0 || invalid.length > 0) {
    return {
      next_stage: stage,
      role: config.role,
      required_artifacts: config.requiredArtifacts,
      missing_artifacts: missing,
      invalid_artifacts: invalid,
      gates_pass: false,
    };
  }

  // All gates pass — next stage
  const nextConfig = STAGE_CONFIG[config.next];
  return {
    next_stage: config.next,
    role: nextConfig ? nextConfig.role : null,
    required_artifacts: nextConfig ? nextConfig.requiredArtifacts : [],
    gates_pass: true,
  };
}

function cmdNextStage(runFolder) {
  if (!runFolder) fail('Usage: next_stage <run_folder>');
  runFolder = safePath(runFolder);
  const status = readStatus(runFolder);
  const info = getNextStageInfo(runFolder, status);
  ok(info);
}

function renderTemplate(templateName, vars) {
  const templatePath = safePath(path.join('templates', templateName));
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template not found: templates/${templateName}`);
  }
  let content = fs.readFileSync(templatePath, 'utf8');
  content = content
    .replace(/\{\{TICKET_ID\}\}/g, vars.ticket_id)
    .replace(/\{\{TITLE\}\}/g, vars.title)
    .replace(/\{\{PROJECT_NAME\}\}/g, vars.project)
    .replace(/\{\{RUN_FOLDER\}\}/g, vars.run_folder);
  return content;
}

function cmdGenerateRolePack(runFolder) {
  if (!runFolder) fail('Usage: generate_role_pack <run_folder>');
  runFolder = safePath(runFolder);

  const status = readStatus(runFolder);

  // generate_role_pack ONLY generates the task file for the current stage.
  // It does NOT advance stages. Use orchestrate_one or advance --confirm for that.
  const config = STAGE_CONFIG[status.current_stage];
  if (!config) {
    if (status.current_stage === 'task-pack-generated') {
      fail('Stage is task-pack-generated. Use orchestrate_one or advance --confirm to move to pm-ready first.');
    }
    if (status.current_stage === 'done') {
      fail('Run is complete, no more role packs to generate.');
    }
    fail(`No role pack available for stage: ${status.current_stage}`);
  }

  const intake = readJSON(path.join(runFolder, '00-intake.json'));
  const content = renderTemplate(config.template, {
    ticket_id: intake.ticket_id,
    title: intake.title,
    project: intake.project || intake.project_name,
    run_folder: runFolder,
  });

  const taskPath = path.join(runFolder, config.taskFile);
  fs.writeFileSync(taskPath, content, 'utf8');

  status.next_actions = [
    { label: `${config.role}: complete work`, command: `Follow ${config.taskFile}` },
    ...config.requiredArtifacts.map((a) => ({
      label: `Record artifact: ${a}`,
      command: `./tools/dp.sh record_artifact ${runFolder} ${path.join(runFolder, a)}`,
    })),
  ];
  writeStatus(runFolder, status);

  ok({ role: config.role, task_file: config.taskFile, stage: status.current_stage });
}

function cmdRecordArtifact(runFolder, artifactPath, agentId) {
  if (!runFolder || !artifactPath) fail('Usage: record_artifact <run_folder> <artifact_path>');
  runFolder = safePath(runFolder);
  artifactPath = safePath(artifactPath);

  // Role enforcement: check agent role matches current stage
  if (agentId) {
    const status = readStatus(runFolder);
    const roleCheck = checkRoleForStage(agentId, status.current_stage);
    if (!roleCheck.ok) fail(roleCheck.error);
  }

  const artifactFilename = path.basename(artifactPath);
  const result = validateArtifact(runFolder, artifactFilename);

  if (!result.valid) {
    // Block with first error as prompt
    const status = readStatus(runFolder);
    status._previous_stage = status.current_stage;

    const currentTime = now();
    const currentEntry = status.stage_history.find(
      (e) => e.stage === status.current_stage && !e.finished_at
    );
    if (currentEntry) currentEntry.finished_at = currentTime;

    status.blocked = true;
    status.blocked_reason = `Artifact validation failed: ${artifactFilename}`;
    status.current_stage = 'blocked';
    status.stage_history.push({
      stage: 'blocked',
      started_at: currentTime,
      finished_at: null,
      artifact_paths: [],
    });

    const input = {
      id: crypto.randomUUID(),
      prompt: result.errors[0],
      options: null,
      default: null,
      status: 'pending',
      answer: null,
    };
    status.required_user_input.push(input);
    status.next_actions = [{
      label: 'Fix artifact and re-record',
      command: `./tools/dp.sh record_artifact ${runFolder} ${artifactPath}`,
    }];
    writeStatus(runFolder, status);

    ok({ valid: false, errors: result.errors, blocked: true, input_id: input.id });
    return;
  }

  // Valid — record in stage history
  const status = readStatus(runFolder);
  const currentEntry = status.stage_history.find(
    (e) => e.stage === status.current_stage && !e.finished_at
  );
  if (currentEntry && !currentEntry.artifact_paths.includes(artifactFilename)) {
    currentEntry.artifact_paths.push(artifactFilename);
  }

  // Check if all gates pass for current stage
  const config = STAGE_CONFIG[status.current_stage];
  let gatesPass = false;
  if (config) {
    const allPresent = config.requiredArtifacts.every((a) => {
      const r = validateArtifact(runFolder, a);
      return r.valid;
    });
    gatesPass = allPresent;
  }

  writeStatus(runFolder, status);
  ok({ valid: true, artifact: artifactFilename, gates_pass: gatesPass });
}

function cmdAdvance(runFolder, args, agentId) {
  if (!runFolder) fail('Usage: advance <run_folder> --confirm');
  if (!args.includes('--confirm')) {
    fail('Safety: pass --confirm to advance. Run next_stage first to review.');
  }

  runFolder = safePath(runFolder);
  const status = readStatus(runFolder);

  // Role enforcement: check agent role matches current stage
  if (agentId) {
    const roleCheck = checkRoleForStage(agentId, status.current_stage);
    if (!roleCheck.ok) fail(roleCheck.error);
  }

  const info = getNextStageInfo(runFolder, status);

  if (!info.gates_pass) {
    fail(`Gates do not pass. Missing: ${JSON.stringify(info.missing_artifacts || [])}. Invalid: ${JSON.stringify(info.invalid_artifacts || [])}`);
  }

  if (!info.next_stage || info.next_stage === status.current_stage) {
    fail('No stage to advance to');
  }

  const currentTime = now();
  const currentEntry = status.stage_history.find(
    (e) => e.stage === status.current_stage && !e.finished_at
  );
  if (currentEntry) currentEntry.finished_at = currentTime;

  status.current_stage = info.next_stage;

  if (info.next_stage === 'done') {
    status.stage_history.push({
      stage: 'done',
      started_at: currentTime,
      finished_at: currentTime,
      artifact_paths: [],
    });
    status.next_actions = [];
  } else {
    status.stage_history.push({
      stage: info.next_stage,
      started_at: currentTime,
      finished_at: null,
      artifact_paths: [],
      role: info.role,
    });
    status.next_actions = [{
      label: `Generate ${info.role} task pack`,
      command: `./tools/dp.sh generate_role_pack ${runFolder}`,
    }];
  }

  writeStatus(runFolder, status);
  ok({ advanced_to: info.next_stage, role: info.role });
}

function cmdOrchestrateOne(runFolder, agentId) {
  if (!runFolder) fail('Usage: orchestrate_one <run_folder>');
  runFolder = safePath(runFolder);

  const status = readStatus(runFolder);

  // Role enforcement: check agent role matches current stage
  if (agentId) {
    const roleCheck = checkRoleForStage(agentId, status.current_stage);
    if (!roleCheck.ok) fail(roleCheck.error);
  }

  if (status.blocked) {
    const pending = status.required_user_input.filter((i) => i.status === 'pending');
    process.stdout.write(JSON.stringify({
      ok: true,
      action: 'blocked',
      current_stage: status.current_stage,
      required_user_input: pending,
    }, null, 2) + '\n');
    process.exit(0);
  }

  if (status.current_stage === 'done') {
    process.stdout.write(JSON.stringify({
      ok: true,
      action: 'done',
      current_stage: 'done',
      message: 'Run is complete',
    }, null, 2) + '\n');
    process.exit(0);
  }

  if (status.current_stage === 'intake') {
    process.stdout.write(JSON.stringify({
      ok: true,
      action: 'needs_task_pack',
      current_stage: 'intake',
      next_command: `./tools/dp.sh generate_task_pack ${runFolder}`,
    }, null, 2) + '\n');
    process.exit(0);
  }

  const info = getNextStageInfo(runFolder, status);

  // If gates pass and we can advance, do so then generate role pack
  if (info.gates_pass && info.next_stage !== status.current_stage) {
    const currentTime = now();
    const currentEntry = status.stage_history.find(
      (e) => e.stage === status.current_stage && !e.finished_at
    );
    if (currentEntry) currentEntry.finished_at = currentTime;

    status.current_stage = info.next_stage;

    if (info.next_stage === 'done') {
      status.stage_history.push({
        stage: 'done', started_at: currentTime, finished_at: currentTime, artifact_paths: [],
      });
      status.next_actions = [];
      writeStatus(runFolder, status);
      process.stdout.write(JSON.stringify({
        ok: true, action: 'completed', advanced_to: 'done',
      }, null, 2) + '\n');
      process.exit(0);
    }

    const nextConfig = STAGE_CONFIG[info.next_stage];
    status.stage_history.push({
      stage: info.next_stage, started_at: currentTime, finished_at: null,
      artifact_paths: [], role: nextConfig ? nextConfig.role : null,
    });

    // Generate role pack if config exists
    if (nextConfig) {
      const intake = readJSON(path.join(runFolder, '00-intake.json'));
      const content = renderTemplate(nextConfig.template, {
        ticket_id: intake.ticket_id, title: intake.title,
        project: intake.project || intake.project_name, run_folder: runFolder,
      });
      fs.writeFileSync(path.join(runFolder, nextConfig.taskFile), content, 'utf8');

      status.next_actions = [
        { label: `${nextConfig.role}: complete work`, command: `Follow ${nextConfig.taskFile}` },
        ...nextConfig.requiredArtifacts.map((a) => ({
          label: `Record: ${a}`,
          command: `./tools/dp.sh record_artifact ${runFolder} ${path.join(runFolder, a)}`,
        })),
      ];
    }

    writeStatus(runFolder, status);
    process.stdout.write(JSON.stringify({
      ok: true,
      action: 'advanced_and_generated',
      advanced_to: info.next_stage,
      role: nextConfig ? nextConfig.role : null,
      task_file: nextConfig ? nextConfig.taskFile : null,
      required_artifacts: nextConfig ? nextConfig.requiredArtifacts : [],
    }, null, 2) + '\n');
    process.exit(0);
  }

  // Gates don't pass yet — report what's needed
  const config = STAGE_CONFIG[status.current_stage];

  // If no task file generated for current stage yet, generate it
  if (config && !fs.existsSync(path.join(runFolder, config.taskFile))) {
    const intake = readJSON(path.join(runFolder, '00-intake.json'));
    const content = renderTemplate(config.template, {
      ticket_id: intake.ticket_id, title: intake.title,
      project: intake.project || intake.project_name, run_folder: runFolder,
    });
    fs.writeFileSync(path.join(runFolder, config.taskFile), content, 'utf8');

    status.next_actions = [
      { label: `${config.role}: complete work`, command: `Follow ${config.taskFile}` },
      ...config.requiredArtifacts.map((a) => ({
        label: `Record: ${a}`,
        command: `./tools/dp.sh record_artifact ${runFolder} ${path.join(runFolder, a)}`,
      })),
    ];
    writeStatus(runFolder, status);
  }

  // For task-pack-generated, advance to pm-ready
  if (status.current_stage === 'task-pack-generated') {
    const currentTime = now();
    const currentEntry = status.stage_history.find(
      (e) => e.stage === status.current_stage && !e.finished_at
    );
    if (currentEntry) currentEntry.finished_at = currentTime;

    status.current_stage = 'pm-ready';
    const pmConfig = STAGE_CONFIG['pm-ready'];
    status.stage_history.push({
      stage: 'pm-ready', started_at: currentTime, finished_at: null,
      artifact_paths: [], role: 'PM',
    });

    const intake = readJSON(path.join(runFolder, '00-intake.json'));
    const content = renderTemplate(pmConfig.template, {
      ticket_id: intake.ticket_id, title: intake.title,
      project: intake.project || intake.project_name, run_folder: runFolder,
    });
    fs.writeFileSync(path.join(runFolder, pmConfig.taskFile), content, 'utf8');

    status.next_actions = [
      { label: 'PM: complete work', command: `Follow ${pmConfig.taskFile}` },
      ...pmConfig.requiredArtifacts.map((a) => ({
        label: `Record: ${a}`,
        command: `./tools/dp.sh record_artifact ${runFolder} ${path.join(runFolder, a)}`,
      })),
    ];
    writeStatus(runFolder, status);

    process.stdout.write(JSON.stringify({
      ok: true, action: 'advanced_and_generated',
      advanced_to: 'pm-ready', role: 'PM', task_file: pmConfig.taskFile,
      required_artifacts: pmConfig.requiredArtifacts,
    }, null, 2) + '\n');
    process.exit(0);
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    action: 'waiting_for_artifacts',
    current_stage: status.current_stage,
    role: config ? config.role : null,
    missing_artifacts: info.missing_artifacts || [],
    invalid_artifacts: info.invalid_artifacts || [],
  }, null, 2) + '\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Shared advance helper: closes current stage, opens nextStage, generates
// role pack if applicable.  Returns a result object (no process.exit).
// ---------------------------------------------------------------------------
function _doAdvance(runFolder, status, nextStage, trace) {
  const currentTime = now();
  const currentEntry = status.stage_history.find(
    (e) => e.stage === status.current_stage && !e.finished_at
  );
  if (currentEntry) currentEntry.finished_at = currentTime;

  status.current_stage = nextStage;

  if (nextStage === 'done') {
    status.stage_history.push({
      stage: 'done', started_at: currentTime, finished_at: currentTime, artifact_paths: [],
    });
    status.next_actions = [];
    writeStatus(runFolder, status);
    trace.push('advanced to done');
    return { action: 'completed', advanced_to: 'done', current_stage: 'done', trace };
  }

  const nextConfig = STAGE_CONFIG[nextStage];
  status.stage_history.push({
    stage: nextStage, started_at: currentTime, finished_at: null,
    artifact_paths: [], role: nextConfig ? nextConfig.role : null,
  });

  if (nextConfig) {
    const intake = readJSON(path.join(runFolder, '00-intake.json'));
    const content = renderTemplate(nextConfig.template, {
      ticket_id: intake.ticket_id, title: intake.title,
      project: intake.project || intake.project_name, run_folder: runFolder,
    });
    fs.writeFileSync(path.join(runFolder, nextConfig.taskFile), content, 'utf8');
    status.next_actions = [
      { label: `${nextConfig.role}: complete work`, command: `Follow ${nextConfig.taskFile}` },
      ...nextConfig.requiredArtifacts.map((a) => ({
        label: `Record: ${a}`,
        command: `./tools/dp.sh record_artifact ${runFolder} ${path.join(runFolder, a)}`,
      })),
    ];
  }

  writeStatus(runFolder, status);
  trace.push(`advanced to ${nextStage}`);
  return {
    action: 'advanced_and_generated',
    advanced_to: nextStage,
    current_stage: nextStage,
    role: nextConfig ? nextConfig.role : null,
    task_file: nextConfig ? nextConfig.taskFile : null,
    required_artifacts: nextConfig ? nextConfig.requiredArtifacts : [],
    trace,
  };
}

// ---------------------------------------------------------------------------
// run_next_safe core: returns a result object (no process.exit, no stdout).
// Used by both cmdRunNextSafe (single step) and cmdRunNextLoop (loop).
// ---------------------------------------------------------------------------
function _runNextSafeCore(runFolder) {
  const status = readStatus(runFolder);
  const trace = [];

  // 1. Done — nothing to do
  if (status.current_stage === 'done') {
    trace.push('stage is done');
    return { action: 'none', current_stage: 'done', trace };
  }

  // 2. Blocked — report pending inputs
  if (status.blocked) {
    const pending = status.required_user_input.filter((i) => i.status === 'pending');
    trace.push(`blocked: ${status.blocked_reason || 'unknown'}`);
    trace.push(`pending inputs: ${pending.length}`);
    return {
      action: 'blocked',
      current_stage: status.current_stage,
      blocked_reason: status.blocked_reason,
      required_inputs: pending.map((i) => ({ id: i.id, prompt: i.prompt })),
      trace,
    };
  }

  // 3. Intake — needs task pack first
  if (status.current_stage === 'intake') {
    trace.push('stage is intake, needs generate_task_pack');
    return {
      action: 'needs_task_pack',
      current_stage: 'intake',
      next_command: `./tools/dp.sh generate_task_pack ${runFolder}`,
      trace,
    };
  }

  // 4. task-pack-generated — advance to pm-ready
  if (status.current_stage === 'task-pack-generated') {
    trace.push('stage is task-pack-generated, advancing to pm-ready');
    return _doAdvance(runFolder, status, 'pm-ready', trace);
  }

  // 5. Role stage — check config
  const config = STAGE_CONFIG[status.current_stage];
  if (!config) {
    trace.push(`unknown stage: ${status.current_stage}`);
    return { action: 'error', current_stage: status.current_stage, error: `Unknown stage: ${status.current_stage}`, trace };
  }

  trace.push(`stage: ${status.current_stage}, role: ${config.role}`);

  // 6. Check if task file exists for current stage
  const taskFilePath = path.join(runFolder, config.taskFile);
  if (!fs.existsSync(taskFilePath)) {
    trace.push(`task file missing: ${config.taskFile}, generating role pack`);
    const intake = readJSON(path.join(runFolder, '00-intake.json'));
    const content = renderTemplate(config.template, {
      ticket_id: intake.ticket_id,
      title: intake.title,
      project: intake.project || intake.project_name,
      run_folder: runFolder,
    });
    fs.writeFileSync(taskFilePath, content, 'utf8');

    status.next_actions = [
      { label: `${config.role}: complete work`, command: `Follow ${config.taskFile}` },
      ...config.requiredArtifacts.map((a) => ({
        label: `Record artifact: ${a}`,
        command: `./tools/dp.sh record_artifact ${runFolder} ${path.join(runFolder, a)}`,
      })),
    ];
    writeStatus(runFolder, status);

    return {
      action: 'generated_role_pack',
      current_stage: status.current_stage,
      role: config.role,
      task_file: config.taskFile,
      required_artifacts: config.requiredArtifacts,
      trace,
    };
  }

  trace.push(`task file exists: ${config.taskFile}`);

  // 7. Check artifact gates
  const info = getNextStageInfo(runFolder, status);

  if (!info.gates_pass) {
    const missing = info.missing_artifacts || [];
    const invalid = info.invalid_artifacts || [];
    trace.push(`gates fail: ${missing.length} missing, ${invalid.length} invalid`);
    return {
      action: 'needs_artifacts',
      current_stage: status.current_stage,
      role: config.role,
      missing_artifacts: missing,
      invalid_artifacts: invalid,
      required_artifacts: config.requiredArtifacts,
      trace,
    };
  }

  // 8. Gates pass — advance to next stage
  trace.push('gates pass, advancing');
  return _doAdvance(runFolder, status, info.next_stage, trace);
}

// ---------------------------------------------------------------------------
// run_next_safe: single safe autopilot step with decision trace (CLI command)
// ---------------------------------------------------------------------------
function cmdRunNextSafe(runFolder) {
  if (!runFolder) fail('Usage: run_next_safe <run_folder>');
  runFolder = safePath(runFolder);

  // Safety guard: run folder must exist
  const statusPath = path.join(runFolder, 'status.json');
  if (!fs.existsSync(runFolder) || !fs.existsSync(statusPath)) {
    ok({
      action: 'error',
      current_stage: null,
      error: `Run folder not found or missing status.json: ${runFolder}`,
      trace: ['run folder does not exist or has no status.json'],
    });
    return;
  }

  // Safety guard: forbid directory creation inside run_next_safe
  const origMkdirSync = fs.mkdirSync;
  fs.mkdirSync = function guardedMkdirSync() {
    fs.mkdirSync = origMkdirSync; // restore before throwing
    throw new Error('run_next_safe: directory creation is forbidden');
  };

  try {
    const result = _runNextSafeCore(runFolder);
    ok(result);
  } finally {
    fs.mkdirSync = origMkdirSync;
  }
}

// ---------------------------------------------------------------------------
// run_next_loop: repeatedly call run_next_safe until a stop condition
// ---------------------------------------------------------------------------
function _computeFingerprint(runFolder) {
  const status = readStatus(runFolder);
  const config = STAGE_CONFIG[status.current_stage];
  let artifactCount = 0;
  if (config) {
    for (const a of config.requiredArtifacts) {
      if (fs.existsSync(path.join(runFolder, a))) artifactCount++;
    }
  }
  return `${status.current_stage}|${status.blocked}|${artifactCount}|${status.stage_history.length}`;
}

const LOOP_STOP_ACTIONS = new Set(['none', 'blocked', 'needs_artifacts', 'needs_task_pack', 'error', 'completed']);

function cmdRunNextLoop(runFolder, maxSteps) {
  if (!runFolder) fail('Usage: run_next_loop <run_folder> [--max_steps N]');
  runFolder = safePath(runFolder);
  maxSteps = maxSteps || 10;

  const loopTrace = [];
  const steps = [];

  // Safety guard: run folder must exist
  const statusPath = path.join(runFolder, 'status.json');
  if (!fs.existsSync(runFolder) || !fs.existsSync(statusPath)) {
    ok({
      action: 'loop_complete',
      final_action: 'error',
      steps_run: 0,
      max_steps: maxSteps,
      steps: [],
      trace: ['run folder does not exist or has no status.json'],
    });
    return;
  }

  // Snapshot runs/ directory before loop
  const runsDir = safePath('runs');
  const runsBefore = fs.existsSync(runsDir)
    ? fs.readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];

  // Safety guard: forbid directory creation inside loop
  const origMkdirSync = fs.mkdirSync;
  fs.mkdirSync = function guardedMkdirSync() {
    fs.mkdirSync = origMkdirSync;
    throw new Error('run_next_loop: directory creation is forbidden');
  };

  let prevFingerprint = null;

  try {
    for (let i = 0; i < maxSteps; i++) {
      const result = _runNextSafeCore(runFolder);
      steps.push(result);
      loopTrace.push(`step ${i + 1}: action=${result.action}, stage=${result.current_stage || 'unknown'}`);

      // Immediate stop actions
      if (LOOP_STOP_ACTIONS.has(result.action)) {
        loopTrace.push(`stopping: ${result.action}`);
        break;
      }

      // Stall detection: compute fingerprint after state change
      const fingerprint = _computeFingerprint(runFolder);
      if (fingerprint === prevFingerprint) {
        loopTrace.push('no state change detected, stopping');
        // Mark the last step as stalled
        steps[steps.length - 1] = { ...result, action: 'stalled', _original_action: result.action };
        break;
      }
      prevFingerprint = fingerprint;
    }
  } finally {
    fs.mkdirSync = origMkdirSync;
  }

  // Safety: verify runs/ unchanged
  const runsAfter = fs.existsSync(runsDir)
    ? fs.readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];

  if (JSON.stringify(runsBefore) !== JSON.stringify(runsAfter)) {
    fail('run_next_loop: runs/ directory changed during execution');
  }

  const lastStep = steps[steps.length - 1];
  const finalAction = lastStep ? lastStep.action : 'none';

  if (steps.length >= maxSteps && !LOOP_STOP_ACTIONS.has(finalAction) && finalAction !== 'stalled') {
    loopTrace.push(`max_steps reached (${maxSteps})`);
  }

  ok({
    action: 'loop_complete',
    final_action: finalAction,
    steps_run: steps.length,
    max_steps: maxSteps,
    steps,
    trace: loopTrace,
  });
}

// ---------------------------------------------------------------------------
// Scaffold: create minimal schema-valid JSON artifacts for current stage
// ---------------------------------------------------------------------------

// Resolve $ref within a root schema's $defs/definitions
function resolveRef(ref, rootSchema) {
  if (!ref || !ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/');
  let node = rootSchema;
  for (const p of parts) {
    if (!node || typeof node !== 'object') return null;
    node = node[p];
  }
  return node || null;
}

function generateMinimalValue(schema, rootSchema) {
  rootSchema = rootSchema || schema;
  if (!schema) return null;

  // $ref resolution
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, rootSchema);
    if (resolved) return generateMinimalValue(resolved, rootSchema);
    return null;
  }

  // allOf: merge into one object schema
  if (schema.allOf) {
    const merged = {};
    for (const sub of schema.allOf) {
      const resolved = sub.$ref ? resolveRef(sub.$ref, rootSchema) : sub;
      if (!resolved) continue;
      if (resolved.properties) merged.properties = { ...merged.properties, ...resolved.properties };
      if (resolved.required) merged.required = [...(merged.required || []), ...resolved.required];
      if (resolved.type && !merged.type) merged.type = resolved.type;
    }
    // Copy over any top-level schema keys not in allOf
    if (schema.type && !merged.type) merged.type = schema.type;
    if (schema.properties) merged.properties = { ...merged.properties, ...schema.properties };
    if (schema.required) merged.required = [...(merged.required || []), ...schema.required];
    return generateMinimalValue(merged, rootSchema);
  }

  // oneOf / anyOf: pick first option
  if (schema.oneOf) return generateMinimalValue(schema.oneOf[0], rootSchema);
  if (schema.anyOf) return generateMinimalValue(schema.anyOf[0], rootSchema);

  // default value takes priority
  if (schema.default !== undefined) return schema.default;

  if (!schema.type) {
    // No type but has properties — treat as object
    if (schema.properties || schema.required) {
      return generateMinimalValue({ ...schema, type: 'object' }, rootSchema);
    }
    return null;
  }

  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  // Pick first non-null type if possible
  const type = types.find((t) => t !== 'null') || types[0];

  if (type === 'string') {
    if (schema.enum) return schema.enum[0];
    // format-aware defaults
    if (schema.format === 'date-time') return '1970-01-01T00:00:00.000Z';
    if (schema.format === 'date') return '1970-01-01';
    if (schema.format === 'uuid') return '00000000-0000-0000-0000-000000000000';
    if (schema.format === 'uri' || schema.format === 'uri-reference') return 'https://example.com';
    if (schema.format === 'email') return 'user@example.com';
    // minLength
    if (schema.minLength && schema.minLength > 0) return '_'.repeat(schema.minLength);
    return '';
  }
  if (type === 'integer' || type === 'number') {
    if (schema.minimum !== undefined) return schema.minimum;
    return 0;
  }
  if (type === 'boolean') return false;
  if (type === 'null') return null;
  if (type === 'array') {
    const min = schema.minItems || 0;
    if (min === 0) return [];
    const arr = [];
    for (let i = 0; i < min; i++) {
      arr.push(schema.items ? generateMinimalValue(schema.items, rootSchema) : null);
    }
    return arr;
  }
  if (type === 'object') {
    const obj = {};
    if (schema.required && schema.properties) {
      for (const key of schema.required) {
        const propSchema = schema.properties[key];
        obj[key] = propSchema ? generateMinimalValue(propSchema, rootSchema) : null;
      }
    } else if (schema.required) {
      for (const key of schema.required) {
        obj[key] = null;
      }
    }
    return obj;
  }
  return null;
}

function cmdScaffoldArtifacts(runFolder) {
  if (!runFolder) fail('Usage: scaffold_artifacts <run_folder>');
  runFolder = safePath(runFolder);

  const status = readStatus(runFolder);
  const config = STAGE_CONFIG[status.current_stage];
  if (!config) fail(`No artifacts to scaffold for stage: ${status.current_stage}`);

  const scaffolded = [];
  for (const artifact of config.requiredArtifacts) {
    // Skip .diff files — only scaffold JSON
    if (artifact.endsWith('.diff')) continue;

    const artifactPath = path.join(runFolder, artifact);
    if (fs.existsSync(artifactPath)) {
      continue; // don't overwrite existing artifacts
    }

    const schema = loadArtifactSchema(artifact);
    if (!schema) {
      // No schema — create empty object with ticket_id
      writeJSON(artifactPath, { ticket_id: status.ticket_id });
      scaffolded.push(artifact);
      continue;
    }

    const minimal = generateMinimalValue(schema);
    // Only inject ticket_id if the schema declares it
    const schemaHasTicketId = (schema.required && schema.required.includes('ticket_id'))
      || (schema.properties && schema.properties.ticket_id);
    if (schemaHasTicketId && minimal && typeof minimal === 'object' && !Array.isArray(minimal)) {
      minimal.ticket_id = status.ticket_id;
    }
    writeJSON(artifactPath, minimal);
    scaffolded.push(artifact);
  }

  ok({ stage: status.current_stage, role: config.role, scaffolded, skipped_diff: config.requiredArtifacts.filter((a) => a.endsWith('.diff')) });
}

// ---------------------------------------------------------------------------
// Role enforcement: check agent role matches stage role
// ---------------------------------------------------------------------------
function checkRoleForStage(agentId, stage, options) {
  if (!agentId) return { ok: true, skipped: true };

  const config = STAGE_CONFIG[stage];
  if (!config) return { ok: true, skipped: true }; // non-role stages: intake, task-pack-generated, done, blocked

  const { readAgentState } = require(path.resolve(__dirname, 'agent-state.js'));
  const state = readAgentState(agentId, options);
  if (!state) return { ok: false, error: `Agent ${agentId} not found` };

  const stageRole = config.role;
  if (state.role !== stageRole) {
    return { ok: false, error: `Role mismatch: agent ${agentId} has role ${state.role}, but stage ${stage} requires ${stageRole}` };
  }

  return { ok: true, agent_id: agentId, role: state.role, stage };
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TOOL_VERSION, STAGE_CONFIG, ARTIFACT_SCHEMA_MAP, WORKSPACE_ROOT,
    generateMinimalValue, validateSchema, resolveRef,
    getNextStageInfo, normalizeStatus, getGitHead,
    safePath, readJSON, writeJSON, readStatus, loadArtifactSchema, validateArtifact,
    _runNextSafeCore, checkRoleForStage,
  };
}

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------
if (require.main === module) {
  const rawArgs = process.argv.slice(2);
  // Extract --agent_id flag before dispatch (available to all commands)
  const agentIdIdx = rawArgs.indexOf('--agent_id');
  let _cliAgentId = null;
  if (agentIdIdx !== -1) {
    _cliAgentId = rawArgs[agentIdIdx + 1] || null;
    rawArgs.splice(agentIdIdx, 2);
  }
  const [command, ...args] = rawArgs;

  try {
    switch (command) {
      case 'help':
      case '--help':
      case '-h':
        process.stdout.write([
          `dev-pipeline ${TOOL_VERSION}`,
          '',
          'Run lifecycle:',
          '  create_run <ticket_id> <title> <project>   Create a new run',
          '  create_run_from_ticket <ticket_id>          Create run from tickets/<id>.md',
          '  generate_task_pack <run_folder>              Generate base task pack (intake → task-pack-generated)',
          '',
          'Orchestration:',
          '  next_stage <run_folder>                      Show next stage, role, and gate status',
          '  generate_role_pack <run_folder>               Generate task file for current stage (no advance)',
          '  record_artifact <run_folder> <artifact_path>  Validate and record an artifact',
          '  advance <run_folder> --confirm                Advance to next stage if gates pass',
          '  orchestrate_one <run_folder>                  Idempotent single-step orchestrator',
          '  run_next_safe <run_folder>                    Safe autopilot: one step with decision trace',
          '  run_next_loop <run_folder> [--max_steps N]   Loop autopilot: repeat run_next_safe until stop',
          '  run_next_autonomous <run_folder> [opts]       Autonomous multi-agent runner with draft-safe writes',
          '  scaffold_artifacts <run_folder>               Create minimal schema-valid JSON for current stage',
          '',
          'Status:',
          '  list                                          List all runs',
          '  status <run_folder>                           Full status of one run',
          '  block <run_folder> <reason> [prompts...]      Block run with user input prompts',
          '  respond <run_folder> <input_id> <answer>      Answer a pending input',
          '',
          'Maintenance:',
          '  stale_list                                    List stale runs',
          '  stale_delete --confirm                        Delete stale runs',
          '  help                                          Show this help',
          '  version                                       Show version',
          '',
        ].join('\n'));
        process.exit(0);
        break;
      case 'version':
      case '--version':
      case '-v':
        process.stdout.write(JSON.stringify({ ok: true, version: TOOL_VERSION }, null, 2) + '\n');
        process.exit(0);
        break;
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
      case 'create_run_from_ticket':
        cmdCreateRunFromTicket(args[0]);
        break;
      case 'stale_list':
        cmdStaleList();
        break;
      case 'stale_delete':
        cmdStaleDelete(args);
        break;
      case 'next_stage':
        cmdNextStage(args[0]);
        break;
      case 'generate_role_pack':
        cmdGenerateRolePack(args[0]);
        break;
      case 'record_artifact':
        cmdRecordArtifact(args[0], args[1], _cliAgentId);
        break;
      case 'advance':
        cmdAdvance(args[0], args.slice(1), _cliAgentId);
        break;
      case 'orchestrate_one':
        cmdOrchestrateOne(args[0], _cliAgentId);
        break;
      case 'scaffold_artifacts':
        cmdScaffoldArtifacts(args[0]);
        break;
      case 'run_next_safe':
        cmdRunNextSafe(args[0]);
        break;
      case 'run_next_loop': {
        const maxIdx = args.indexOf('--max_steps');
        const maxSteps = maxIdx !== -1 ? parseInt(args[maxIdx + 1], 10) : 10;
        const folder = args.find((a) => a !== '--max_steps' && (maxIdx === -1 || a !== args[maxIdx + 1]));
        cmdRunNextLoop(folder, maxSteps);
        break;
      }
      case 'run_next_autonomous': {
        const { runAutonomous } = require('./autonomous-runner.js');
        const optFlags = new Set(['--max_steps', '--max_agent_calls', '--dry_run', '--audit_log']);
        const aFolder = args.find((a) => !optFlags.has(a) && !args.some((f, i) => optFlags.has(f) && args[i + 1] === a));
        if (!aFolder) fail('Usage: run_next_autonomous <run_folder> [--max_steps N] [--max_agent_calls N] [--dry_run] [--audit_log] [--agent_id ID]');
        const resolvedFolder = safePath(aFolder);
        const aMaxStepsIdx = args.indexOf('--max_steps');
        const aMaxAgentIdx = args.indexOf('--max_agent_calls');
        const opts = {
          maxSteps: aMaxStepsIdx !== -1 ? parseInt(args[aMaxStepsIdx + 1], 10) : 50,
          maxAgentCalls: aMaxAgentIdx !== -1 ? parseInt(args[aMaxAgentIdx + 1], 10) : 20,
          dryRun: args.includes('--dry_run'),
          auditLog: args.includes('--audit_log') || process.env.DP_AUDIT_LOG === '1',
          agentId: _cliAgentId,
        };
        // Safety: snapshot runs/ before
        const aRunsDir = safePath('runs');
        const aRunsBefore = fs.existsSync(aRunsDir)
          ? fs.readdirSync(aRunsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
          : [];
        const result = runAutonomous(aFolder, opts);
        // Safety: verify runs/ unchanged
        const aRunsAfter = fs.existsSync(aRunsDir)
          ? fs.readdirSync(aRunsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
          : [];
        if (JSON.stringify(aRunsBefore) !== JSON.stringify(aRunsAfter)) {
          fail('run_next_autonomous: runs/ directory changed during execution');
        }
        // Dashboard: write summary to status.json (end of invocation only)
        try {
          const statusPath = path.join(resolvedFolder, 'status.json');
          if (fs.existsSync(statusPath)) {
            const status = readStatus(aFolder);
            status.last_autonomous_run_at = now();
            status.last_autonomous_summary = {
              final_action: result.final_action,
              steps_run: result.steps_run,
              agent_calls: result.agent_calls,
              artifacts_written: result.artifacts_written,
            };
            writeStatus(aFolder, status);
          }
        } catch {
          // Non-fatal: dashboard summary write failure should not affect result
        }
        ok(result);
        break;
      }
      default:
        fail(`Unknown command: ${command || '(none)'}. Available: create_run, create_run_from_ticket, generate_task_pack, generate_role_pack, next_stage, record_artifact, advance, orchestrate_one, run_next_safe, run_next_loop, run_next_autonomous, scaffold_artifacts, block, respond, list, status, stale_list, stale_delete`);
    }
  } catch (err) {
    fail(err.message);
  }
}
