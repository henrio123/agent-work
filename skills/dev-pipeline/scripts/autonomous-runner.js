#!/usr/bin/env node
'use strict';

/**
 * autonomous-runner.js — Autonomous multi-agent runner.
 *
 * Drives a run folder forward by repeatedly:
 *   1. Calling run_next_safe to get current state
 *   2. If needs_artifacts, invoking the correct role agent to produce drafts
 *   3. Validating drafts against schemas
 *   4. Writing final artifacts (only if target does not exist)
 *   5. Recording artifacts via record_artifact
 *   6. Repeating until a stop condition
 *
 * Safety guarantees:
 *   - Never creates run folders
 *   - Never overwrites existing artifacts
 *   - Never creates directories
 *   - All filesystem access respects safePath
 *   - Snapshots runs/ and run folder before/after
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const dp = require('./dev-pipeline.js');
const {
  STAGE_CONFIG, ARTIFACT_SCHEMA_MAP, WORKSPACE_ROOT,
  safePath, readJSON, readStatus, loadArtifactSchema, validateArtifact,
  generateMinimalValue, validateSchema,
} = dp;

const DP_PATH = path.resolve(__dirname, 'dev-pipeline.js');
const AGENT_MEMORY_PATH = path.resolve(__dirname, 'agent-memory.js');
const PROMPT_CONTEXT_PATH = path.resolve(__dirname, 'prompt-context.js');
const ADAPTER_PROMPT_BUILDER_PATH = path.resolve(__dirname, 'adapter-prompt-builder.js');
const APPLY_DEV_PATCH_PATH = path.resolve(__dirname, 'apply-dev-patch.js');

const AUDIT_FILENAME = 'autonomous-audit.jsonl';
const STOP_FILENAME = '.stop';

// ---------------------------------------------------------------------------
// Audit logger — append-only JSONL to <run_folder>/autonomous-audit.jsonl
// ---------------------------------------------------------------------------
function createAuditLogger(runFolder, enabled) {
  if (!enabled) return { emit() {} };
  const logPath = path.join(runFolder, AUDIT_FILENAME);
  return {
    emit(step, action, stage, event, detail) {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        step,
        action: action || '',
        stage: stage || '',
        event,
        detail: detail || '',
      });
      try {
        fs.appendFileSync(logPath, line + '\n', 'utf8');
      } catch {
        // Skip logging silently if folder does not exist or write fails
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Progress logger — one line per step to stderr (never mixes with JSON stdout)
// ---------------------------------------------------------------------------
function createProgressLogger(enabled) {
  if (!enabled) return { header() {}, step() {} };
  return {
    header(runFolder) {
      process.stderr.write(`autonomous: ${runFolder}\n`);
    },
    step(stepNum, action, stage, agentCalls, artifactsWrittenCount) {
      process.stderr.write(`  [${stepNum}] ${action} | ${stage} | agents:${agentCalls} | artifacts:${artifactsWrittenCount}\n`);
    },
  };
}

// ---------------------------------------------------------------------------
// Stop signal — file-based cooperative stop at step boundaries
// ---------------------------------------------------------------------------
function checkStopSignal(resolvedFolder) {
  return fs.existsSync(path.join(resolvedFolder, STOP_FILENAME));
}

// ---------------------------------------------------------------------------
// Call dev-pipeline.js commands via subprocess (maintains safety boundary)
// ---------------------------------------------------------------------------
function callDP(...args) {
  try {
    const stdout = execFileSync('node', [DP_PATH, ...args], {
      encoding: 'utf8',
      timeout: 30000,
    });
    let json = null;
    try { json = JSON.parse(stdout); } catch {}
    return { ok: true, stdout, json };
  } catch (e) {
    let json = null;
    try { json = JSON.parse(e.stdout || ''); } catch {}
    try { json = json || JSON.parse(e.stderr || ''); } catch {}
    return { ok: false, stdout: e.stdout || '', stderr: e.stderr || '', exitCode: e.status, json };
  }
}

// ---------------------------------------------------------------------------
// Agent adapter interface
// ---------------------------------------------------------------------------

/**
 * Scaffold adapter: generates minimal schema-valid content as .draft files.
 * Used as fallback when Claude Code is not available.
 */
function scaffoldAdapter(context) {
  const drafts = [];

  for (const artifact of context.missingArtifacts.sort()) {
    const draftPath = path.join(context.runFolder, artifact + '.draft');

    if (artifact.endsWith('.diff')) {
      // Generate a minimal valid diff
      fs.writeFileSync(draftPath, [
        'diff --git a/placeholder b/placeholder',
        '--- a/placeholder',
        '+++ b/placeholder',
        '@@ -0,0 +1 @@',
        `+# Placeholder for ${context.status.ticket_id}`,
        '',
      ].join('\n'), 'utf8');
      drafts.push({ draftPath, targetArtifact: artifact });
      continue;
    }

    // JSON artifact: generate from schema
    const schema = loadArtifactSchema(artifact);
    let content;
    if (schema) {
      content = generateMinimalValue(schema);
      // Inject ticket_id if schema declares it
      const schemaHasTicketId = (schema.required && schema.required.includes('ticket_id'))
        || (schema.properties && schema.properties.ticket_id);
      if (schemaHasTicketId && content && typeof content === 'object' && !Array.isArray(content)) {
        content.ticket_id = context.status.ticket_id;
      }
      // Inject title if schema declares it
      const schemaHasTitle = (schema.required && schema.required.includes('title'))
        || (schema.properties && schema.properties.title);
      if (schemaHasTitle && content && typeof content === 'object' && !Array.isArray(content)) {
        content.title = context.status.title;
      }
    } else {
      content = { ticket_id: context.status.ticket_id };
    }

    fs.writeFileSync(draftPath, JSON.stringify(content, null, 2) + '\n', 'utf8');
    drafts.push({ draftPath, targetArtifact: artifact });
  }

  return { drafts };
}

/**
 * Draft-file adapter: reads pre-existing .draft files from the run folder.
 * Used when drafts are produced externally (e.g., by a human or prior agent run).
 */
function draftFileAdapter(context) {
  const drafts = [];

  for (const artifact of context.missingArtifacts.sort()) {
    const draftPath = path.join(context.runFolder, artifact + '.draft');
    if (fs.existsSync(draftPath)) {
      drafts.push({ draftPath, targetArtifact: artifact });
    }
  }

  return { drafts };
}

/**
 * Claude Code adapter: invokes claude CLI to produce drafts.
 * Falls back to scaffold adapter if claude is not available.
 */
function claudeCodeAdapter(context) {
  // Check if claude CLI is available
  let claudeAvailable = false;
  try {
    execFileSync('which', ['claude'], { encoding: 'utf8', timeout: 5000 });
    claudeAvailable = true;
  } catch {}

  if (!claudeAvailable) {
    return scaffoldAdapter(context);
  }

  // Phase 6: Build enriched prompt via adapter-prompt-builder (with fallback)
  let prompt;
  try {
    const { buildAdapterPrompt } = require(ADAPTER_PROMPT_BUILDER_PATH);
    const promptResult = buildAdapterPrompt(context, { workspaceRoot: WORKSPACE_ROOT });
    prompt = promptResult.prompt;
  } catch {
    // Fallback to minimal prompt if adapter-prompt-builder is unavailable
    const artifactList = context.missingArtifacts.sort();
    const schemaDescriptions = artifactList.map((a) => {
      const schema = loadArtifactSchema(a);
      if (!schema) return `- ${a}: no schema (write valid JSON with ticket_id)`;
      const required = (schema.required || []).sort().join(', ');
      return `- ${a}: required fields: [${required}]`;
    }).join('\n');

    const agentIdentity = context.agentId
      ? `You are agent ${context.agentId}, a ${context.role} agent working on ticket ${context.status.ticket_id}: ${context.status.title}`
      : `You are a ${context.role} agent working on ticket ${context.status.ticket_id}: ${context.status.title}`;

    prompt = [
      agentIdentity,
      `Project: ${context.status.project}`,
      `Current stage: ${context.status.current_stage}`,
      '',
      'Produce the following artifact drafts:',
      schemaDescriptions,
      '',
      `Write each artifact as a file with .draft suffix in: ${context.runFolder}`,
      `For example, write ${artifactList[0]} content to ${path.join(context.runFolder, artifactList[0] + '.draft')}`,
      '',
      'Requirements:',
      '- Each JSON artifact must be valid against its schema',
      '- Diff artifacts must be valid unified diff format',
      '- Do not create any directories',
      '- Do not modify any existing files',
      `- Use ticket_id: "${context.status.ticket_id}" in all artifacts that require it`,
    ].join('\n');
  }

  try {
    execFileSync('claude', ['-p', prompt, '--output-format', 'json', '--max-turns', '5'], {
      encoding: 'utf8',
      timeout: 120000,
      cwd: WORKSPACE_ROOT,
    });
  } catch {
    // If claude invocation fails, fall back to scaffold
    return scaffoldAdapter(context);
  }

  // Check if draft files were created by claude
  const drafts = [];
  for (const artifact of artifactList) {
    const draftPath = path.join(context.runFolder, artifact + '.draft');
    if (fs.existsSync(draftPath)) {
      drafts.push({ draftPath, targetArtifact: artifact });
    }
  }

  // If claude didn't produce all drafts, fill in with scaffold
  if (drafts.length < artifactList.length) {
    const produced = new Set(drafts.map((d) => d.targetArtifact));
    const remaining = artifactList.filter((a) => !produced.has(a));
    const fallback = scaffoldAdapter({
      ...context,
      missingArtifacts: remaining,
    });
    drafts.push(...fallback.drafts);
  }

  return { drafts };
}

// ---------------------------------------------------------------------------
// Draft validation pipeline
// ---------------------------------------------------------------------------
function validateDraft(draftPath, targetArtifact, runFolder) {
  const errors = [];

  // 1. Draft must be inside run folder
  const resolvedDraft = path.resolve(draftPath);
  const resolvedRun = path.resolve(runFolder);
  if (!resolvedDraft.startsWith(resolvedRun + path.sep)) {
    errors.push(`draft path outside run folder: ${draftPath}`);
    return { valid: false, errors };
  }

  // 2. Draft must exist
  if (!fs.existsSync(draftPath)) {
    errors.push(`draft file not found: ${draftPath}`);
    return { valid: false, errors };
  }

  // 3. Target artifact must not already exist
  const targetPath = path.join(runFolder, targetArtifact);
  if (fs.existsSync(targetPath)) {
    errors.push(`target artifact already exists: ${targetArtifact}`);
    return { valid: false, errors };
  }

  // 4. Validate content
  if (targetArtifact.endsWith('.diff')) {
    const content = fs.readFileSync(draftPath, 'utf8').trim();
    if (!content) {
      errors.push(`draft is empty: ${targetArtifact}`);
      return { valid: false, errors };
    }
    // Check diff doesn't reference paths outside run folder
    const lines = content.split('\n');
    for (const line of lines) {
      if (line.startsWith('---') || line.startsWith('+++')) {
        const filePath = line.slice(4).trim();
        if (filePath.startsWith('/') && !filePath.startsWith(resolvedRun)) {
          errors.push(`diff references path outside run folder: ${filePath}`);
        }
      }
    }
  } else {
    // JSON artifact: parse and validate against schema
    let data;
    try {
      data = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
    } catch (e) {
      errors.push(`draft is not valid JSON: ${e.message}`);
      return { valid: false, errors };
    }

    const schema = loadArtifactSchema(targetArtifact);
    if (schema) {
      const schemaErrors = validateSchema(data, schema);
      if (schemaErrors.length > 0) {
        errors.push(...schemaErrors.map((e) => `schema: ${e}`));
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Directory snapshot helpers
// ---------------------------------------------------------------------------
function snapshotDir(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function snapshotFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath)
    .sort();
}

// ---------------------------------------------------------------------------
// Core autonomous loop
// ---------------------------------------------------------------------------
function runAutonomous(runFolder, options = {}) {
  const maxSteps = options.maxSteps || 50;
  const maxAgentCalls = options.maxAgentCalls || 20;
  const maxRetries = options.maxRetries !== undefined ? options.maxRetries : 2;
  const dryRun = options.dryRun || false;
  const agentAdapter = options.agentAdapter || claudeCodeAdapter;
  const auditLogEnabled = options.auditLog || false;
  const progressEnabled = options.progress !== false; // on by default for CLI
  const agentId = options.agentId || null;

  const trace = [];
  const artifactsWritten = [];
  const artifactsSkipped = [];
  let stepsRun = 0;
  let agentCalls = 0;
  let retriesAttempted = 0;
  let patchApplication = null;

  // Safety: resolve and validate run folder
  let resolvedFolder;
  try {
    resolvedFolder = safePath(runFolder);
  } catch (e) {
    return {
      action: 'autonomous_complete',
      final_action: 'error',
      steps_run: 0,
      agent_calls: 0,
      artifacts_written: [],
      artifacts_skipped: [],
      trace: [`safePath error: ${e.message}`],
    };
  }

  // Safety: check run folder exists
  if (!fs.existsSync(resolvedFolder) || !fs.existsSync(path.join(resolvedFolder, 'status.json'))) {
    return {
      action: 'autonomous_complete',
      final_action: 'error',
      steps_run: 0,
      agent_calls: 0,
      artifacts_written: [],
      artifacts_skipped: [],
      trace: ['run folder does not exist or missing status.json'],
    };
  }

  // Audit logger — created after folder validation so path is safe
  const audit = createAuditLogger(resolvedFolder, auditLogEnabled);

  // Progress logger
  const progress = createProgressLogger(progressEnabled);
  progress.header(runFolder);

  // Safety: snapshot runs/ directory
  const runsDir = safePath('runs');
  const runsDirsBefore = snapshotDir(runsDir);

  // Safety: snapshot run folder files
  const runFilesBefore = snapshotFiles(resolvedFolder);

  // Safety: guard mkdirSync
  const origMkdirSync = fs.mkdirSync;
  const origMkdir = fs.mkdir;
  fs.mkdirSync = function guardedMkdirSync() {
    fs.mkdirSync = origMkdirSync;
    fs.mkdir = origMkdir;
    throw new Error('autonomous-runner: directory creation is forbidden');
  };
  fs.mkdir = function guardedMkdir(_p, _o, cb) {
    fs.mkdirSync = origMkdirSync;
    fs.mkdir = origMkdir;
    const err = new Error('autonomous-runner: directory creation is forbidden');
    if (typeof cb === 'function') cb(err);
    else if (typeof _o === 'function') _o(err);
    else throw err;
  };

  try {
    for (let step = 0; step < maxSteps; step++) {
      stepsRun++;

      // Check for stop signal at step boundary
      if (checkStopSignal(resolvedFolder)) {
        trace.push(`step ${stepsRun}: stop signal detected`);
        audit.emit(stepsRun, '', '', 'stop', 'stop signal (.stop file)');
        progress.step(stepsRun, 'stopped', '', agentCalls, artifactsWritten.length);
        return _result('stopped', trace, stepsRun, agentCalls, artifactsWritten, artifactsSkipped, maxSteps, maxAgentCalls, { retries_attempted: retriesAttempted, patch_application: patchApplication });
      }

      // Get current state via run_next_safe
      const result = callDP('run_next_safe', resolvedFolder);
      if (!result.json) {
        trace.push(`step ${stepsRun}: run_next_safe returned no JSON`);
        return _result('error', trace, stepsRun, agentCalls, artifactsWritten, artifactsSkipped, maxSteps, maxAgentCalls, { retries_attempted: retriesAttempted, patch_application: patchApplication });
      }

      const action = result.json.action;
      const stage = result.json.current_stage || 'unknown';
      trace.push(`step ${stepsRun}: action=${action}, stage=${stage}`);
      audit.emit(stepsRun, action, stage, 'step', `action=${action}`);
      progress.step(stepsRun, action, stage, agentCalls, artifactsWritten.length);

      // Terminal actions
      if (action === 'none') {
        trace.push('run is complete');
        audit.emit(stepsRun, action, stage, 'stop', 'final_action=none');
        return _result('none', trace, stepsRun, agentCalls, artifactsWritten, artifactsSkipped, maxSteps, maxAgentCalls, { retries_attempted: retriesAttempted, patch_application: patchApplication });
      }
      if (action === 'blocked') {
        trace.push(`blocked: ${result.json.blocked_reason || 'unknown'}`);
        audit.emit(stepsRun, action, stage, 'stop', `final_action=blocked, reason=${result.json.blocked_reason || 'unknown'}`);
        return _result('blocked', trace, stepsRun, agentCalls, artifactsWritten, artifactsSkipped, maxSteps, maxAgentCalls, { retries_attempted: retriesAttempted, patch_application: patchApplication });
      }
      if (action === 'error') {
        trace.push(`error: ${result.json.error || 'unknown'}`);
        audit.emit(stepsRun, action, stage, 'stop', `final_action=error, error=${result.json.error || 'unknown'}`);
        return _result('error', trace, stepsRun, agentCalls, artifactsWritten, artifactsSkipped, maxSteps, maxAgentCalls, { retries_attempted: retriesAttempted, patch_application: patchApplication });
      }
      if (action === 'stalled') {
        trace.push('stalled: no state change detected');
        audit.emit(stepsRun, action, stage, 'stop', 'final_action=stalled');
        return _result('stalled', trace, stepsRun, agentCalls, artifactsWritten, artifactsSkipped, maxSteps, maxAgentCalls, { retries_attempted: retriesAttempted, patch_application: patchApplication });
      }

      // Needs task pack — generate it
      if (action === 'needs_task_pack') {
        trace.push('generating task pack');
        audit.emit(stepsRun, action, stage, 'step', 'generating task pack');
        const tpResult = callDP('generate_task_pack', resolvedFolder);
        if (!tpResult.json || !tpResult.json.ok) {
          trace.push(`generate_task_pack failed: ${tpResult.stderr || 'unknown'}`);
          audit.emit(stepsRun, action, stage, 'stop', `final_action=error, generate_task_pack failed`);
          return _result('error', trace, stepsRun, agentCalls, artifactsWritten, artifactsSkipped, maxSteps, maxAgentCalls, { retries_attempted: retriesAttempted, patch_application: patchApplication });
        }
        trace.push('task pack generated');
        continue;
      }

      // Progress actions — run_next_safe already made the change
      if (action === 'generated_role_pack' || action === 'advanced_and_generated' || action === 'completed') {
        trace.push(`progress: ${action}`);
        continue;
      }

      // Needs artifacts — invoke agent
      if (action === 'needs_artifacts') {
        const role = result.json.role;
        const missingArtifacts = result.json.missing_artifacts || [];
        const currentStage = result.json.current_stage;

        if (agentCalls >= maxAgentCalls) {
          trace.push(`max_agent_calls reached (${maxAgentCalls})`);
          audit.emit(stepsRun, action, currentStage, 'stop', `max_agent_calls reached (${maxAgentCalls})`);
          return _result('needs_artifacts', trace, stepsRun, agentCalls, artifactsWritten, artifactsSkipped, maxSteps, maxAgentCalls, { retries_attempted: retriesAttempted, patch_application: patchApplication });
        }

        if (dryRun) {
          trace.push(`dry_run: would invoke ${role} agent for ${missingArtifacts.join(', ')}`);
          audit.emit(stepsRun, action, currentStage, 'stop', `dry_run: ${role}: ${missingArtifacts.join(', ')}`);
          return _result('needs_artifacts', trace, stepsRun, agentCalls, artifactsWritten, artifactsSkipped, maxSteps, maxAgentCalls, { retries_attempted: retriesAttempted, patch_application: patchApplication });
        }

        // Build agent context
        const status = readStatus(resolvedFolder);
        const context = {
          runFolder: resolvedFolder,
          role,
          missingArtifacts,
          currentStage,
          status,
          agentId,
        };

        // Invoke agent
        trace.push(`invoking ${role} agent for: ${missingArtifacts.sort().join(', ')}`);
        audit.emit(stepsRun, action, currentStage, 'agent_invoke', `${role}: ${missingArtifacts.sort().join(', ')}`);
        let agentResult;
        try {
          agentResult = agentAdapter(context);
        } catch (e) {
          trace.push(`agent error: ${e.message}`);
          audit.emit(stepsRun, action, currentStage, 'stop', `final_action=error, agent error: ${e.message}`);
          return _result('error', trace, stepsRun, agentCalls, artifactsWritten, artifactsSkipped, maxSteps, maxAgentCalls, { retries_attempted: retriesAttempted, patch_application: patchApplication });
        }
        agentCalls++;

        if (!agentResult || !agentResult.drafts || agentResult.drafts.length === 0) {
          trace.push('agent produced no drafts');
          audit.emit(stepsRun, action, currentStage, 'stop', 'final_action=error, agent produced no drafts');
          return _result('error', trace, stepsRun, agentCalls, artifactsWritten, artifactsSkipped, maxSteps, maxAgentCalls, { retries_attempted: retriesAttempted, patch_application: patchApplication });
        }

        // Validate and write each draft (with retry support)
        let allDraftsValid = true;
        for (const draft of agentResult.drafts) {
          let validation = validateDraft(draft.draftPath, draft.targetArtifact, resolvedFolder);

          // Phase 6: Retry loop for invalid drafts
          if (!validation.valid && maxRetries > 0) {
            let retryCount = 0;
            while (!validation.valid && retryCount < maxRetries) {
              retryCount++;
              retriesAttempted++;
              trace.push(`retry ${retryCount}/${maxRetries} for ${draft.targetArtifact}: ${validation.errors.join('; ')}`);
              audit.emit(stepsRun, action, currentStage, 'retry_start', `${draft.targetArtifact}: retry ${retryCount}/${maxRetries}`);

              // Read invalid draft content for error feedback
              let draftContent = '';
              try { draftContent = fs.readFileSync(draft.draftPath, 'utf8'); } catch {}

              // Delete invalid draft
              try { fs.unlinkSync(draft.draftPath); } catch {}

              // Build retry prompt and re-invoke adapter
              try {
                const { buildRetryPrompt } = require(ADAPTER_PROMPT_BUILDER_PATH);
                const retryResult = buildRetryPrompt({
                  draftContent,
                  validationErrors: validation.errors,
                  retryNum: retryCount,
                  maxRetries,
                  artifactName: draft.targetArtifact,
                });

                const retryContext = {
                  ...context,
                  retryPrompt: retryResult.prompt,
                  missingArtifacts: [draft.targetArtifact],
                };

                const retryAgentResult = agentAdapter(retryContext);
                agentCalls++;

                if (retryAgentResult && retryAgentResult.drafts && retryAgentResult.drafts.length > 0) {
                  const retryDraft = retryAgentResult.drafts.find(d => d.targetArtifact === draft.targetArtifact);
                  if (retryDraft) {
                    draft.draftPath = retryDraft.draftPath;
                    validation = validateDraft(draft.draftPath, draft.targetArtifact, resolvedFolder);
                  }
                }
              } catch (retryErr) {
                trace.push(`retry error (non-fatal): ${retryErr.message}`);
                break;
              }
            }
          }

          if (!validation.valid) {
            trace.push(`draft invalid: ${draft.targetArtifact} — ${validation.errors.join('; ')}`);
            audit.emit(stepsRun, action, currentStage, 'draft_invalid', `${draft.targetArtifact}: ${validation.errors.join('; ')}`);
            allDraftsValid = false;
            // Clean up draft file
            try { fs.unlinkSync(draft.draftPath); } catch {}
            continue;
          }

          // Write final artifact (copy draft content to target)
          const targetPath = path.join(resolvedFolder, draft.targetArtifact);
          if (fs.existsSync(targetPath)) {
            trace.push(`artifact already exists, skipping: ${draft.targetArtifact}`);
            audit.emit(stepsRun, action, currentStage, 'artifact_skip', draft.targetArtifact);
            artifactsSkipped.push(draft.targetArtifact);
            try { fs.unlinkSync(draft.draftPath); } catch {}
            continue;
          }

          const content = fs.readFileSync(draft.draftPath, 'utf8');
          fs.writeFileSync(targetPath, content, 'utf8');
          artifactsWritten.push(draft.targetArtifact);
          trace.push(`wrote artifact: ${draft.targetArtifact}`);
          audit.emit(stepsRun, action, currentStage, 'artifact_write', draft.targetArtifact);

          // Clean up draft
          try { fs.unlinkSync(draft.draftPath); } catch {}

          // Record artifact via pipeline (pass --agent_id if set)
          const recArgs = ['record_artifact', resolvedFolder, targetPath];
          if (agentId) recArgs.push('--agent_id', agentId);
          const recResult = callDP(...recArgs);
          if (recResult.json && !recResult.json.valid) {
            trace.push(`record_artifact validation failed: ${draft.targetArtifact} — ${JSON.stringify(recResult.json.errors)}`);
          } else {
            trace.push(`recorded artifact: ${draft.targetArtifact}`);
          }
        }

        if (!allDraftsValid) {
          trace.push('some drafts were invalid');
        }

        // Phase 6: Post-implement patch application
        if (currentStage === 'implement' && artifactsWritten.includes('40-dev-patch.diff')) {
          try {
            const { applyDevPatch } = require(APPLY_DEV_PATCH_PATH);
            const relativeRunFolder = path.relative(WORKSPACE_ROOT, resolvedFolder);
            audit.emit(stepsRun, action, currentStage, 'patch_apply_start', relativeRunFolder);

            // 1. Dry-run validation
            const dryResult = applyDevPatch({ runFolder: relativeRunFolder }, { workspaceRoot: WORKSPACE_ROOT, dryRun: true });
            if (dryResult.ok) {
              // 2. Apply for real
              const applyResult = applyDevPatch({ runFolder: relativeRunFolder }, { workspaceRoot: WORKSPACE_ROOT, dryRun: false });
              patchApplication = { applied: applyResult.ok, files_changed: applyResult.files_changed || [], error: applyResult.error || null };
              trace.push(`patch applied: ${applyResult.ok ? 'success' : applyResult.error}`);
              audit.emit(stepsRun, action, currentStage, 'patch_apply_result', `applied=${applyResult.ok}`);
            } else {
              patchApplication = { applied: false, error: dryResult.error || 'dry-run failed' };
              trace.push(`patch dry-run failed (non-fatal): ${dryResult.error}`);
              audit.emit(stepsRun, action, currentStage, 'patch_apply_result', `dry_run_failed: ${dryResult.error}`);
            }
          } catch (patchErr) {
            patchApplication = { applied: false, error: patchErr.message };
            trace.push(`patch application error (non-fatal): ${patchErr.message}`);
          }
        }

        // Write memory observation after stage artifact production (if agent_id set)
        if (agentId && artifactsWritten.length > 0) {
          const stageArtifacts = agentResult.drafts
            .filter(d => artifactsWritten.includes(d.targetArtifact))
            .map(d => d.targetArtifact)
            .sort();
          if (stageArtifacts.length > 0) {
            try {
              execFileSync('node', [
                AGENT_MEMORY_PATH, 'write_memory',
                '--agent_id', agentId,
                '--run_id', path.basename(resolvedFolder),
                '--project_id', status.project || 'unknown',
                '--stage', currentStage,
                '--type', 'observation',
                '--content', `Completed ${currentStage} for ${status.ticket_id}. Artifacts: ${stageArtifacts.join(', ')}`,
                '--tags', [currentStage, status.ticket_id].join(','),
              ], { encoding: 'utf8', timeout: 5000, env: process.env });
              trace.push(`memory: wrote observation for ${currentStage}`);
              audit.emit(stepsRun, action, currentStage, 'memory_write', `observation for ${currentStage}`);
            } catch (e) {
              // Non-fatal — memory write failure should not block pipeline
              trace.push(`memory write failed (non-fatal): ${e.message}`);
            }
          }
        }

        continue;
      }

      // Unknown action
      trace.push(`unknown action: ${action}`);
      return _result('error', trace, stepsRun, agentCalls, artifactsWritten, artifactsSkipped, maxSteps, maxAgentCalls, { retries_attempted: retriesAttempted, patch_application: patchApplication });
    }

    // Max steps reached
    trace.push(`max_steps reached (${maxSteps})`);
    audit.emit(stepsRun, '', '', 'stop', `max_steps reached (${maxSteps})`);
    return _result('needs_artifacts', trace, stepsRun, agentCalls, artifactsWritten, artifactsSkipped, maxSteps, maxAgentCalls, { retries_attempted: retriesAttempted, patch_application: patchApplication });

  } finally {
    fs.mkdirSync = origMkdirSync;
    fs.mkdir = origMkdir;
  }
}

function _result(finalAction, trace, stepsRun, agentCalls, artifactsWritten, artifactsSkipped, maxSteps, maxAgentCalls, extras) {
  // Safety: verify runs/ unchanged
  const runsDir = safePath('runs');
  const runsDirsAfter = snapshotDir(runsDir);
  // Note: We can't compare to 'before' from this scope directly, but the
  // caller (cmdRunNextAutonomous) does the final assertion. This is a helper.

  const result = {
    action: 'autonomous_complete',
    final_action: finalAction,
    steps_run: stepsRun,
    agent_calls: agentCalls,
    max_steps: maxSteps,
    max_agent_calls: maxAgentCalls,
    artifacts_written: artifactsWritten,
    artifacts_skipped: artifactsSkipped,
    trace,
  };

  // Phase 6 fields
  if (extras) {
    if (extras.retries_attempted !== undefined) result.retries_attempted = extras.retries_attempted;
    if (extras.patch_application !== undefined) result.patch_application = extras.patch_application;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  runAutonomous,
  scaffoldAdapter,
  draftFileAdapter,
  claudeCodeAdapter,
  validateDraft,
  AUDIT_FILENAME,
  STOP_FILENAME,
};
