#!/usr/bin/env node
'use strict';

/**
 * adapter-prompt-builder.js — Build enriched prompts for the autonomous runner.
 *
 * Phase 6 module that replaces the minimal prompt in claudeCodeAdapter with
 * template-enriched instructions. Reads stage task files from run folders,
 * injects prior artifact content, and provides retry prompts for validation
 * failures.
 *
 * Exports:
 *   buildAdapterPrompt(context, options)   → { prompt, template_used, artifact_context_length }
 *   buildArtifactContext(runFolder, currentStage, options) → { text, artifacts_included, total_chars, truncated }
 *   buildRetryPrompt(params)               → { prompt }
 *   STAGE_ARTIFACT_DEPS
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PROMPT_CONTEXT_PATH = path.resolve(__dirname, 'prompt-context.js');

// ---------------------------------------------------------------------------
// Stage artifact dependency map — which prior artifacts each stage needs
// ---------------------------------------------------------------------------
const STAGE_ARTIFACT_DEPS = {
  'analyze':   ['00-intake.json'],
  'plan':      ['10-pm-brief.json', '00-intake.json'],
  'implement': ['20-arch-design.json', '10-pm-brief.json'],
  'validate':  ['10-pm-brief.json', '20-arch-design.json', '40-dev-patch.diff', '41-dev-notes.json'],
  'review':    ['00-intake.json', '10-pm-brief.json', '20-arch-design.json',
                '40-dev-patch.diff', '41-dev-notes.json', '50-qa-report.json'],
};

// ---------------------------------------------------------------------------
// buildArtifactContext — read prior artifacts and format as prompt sections
// ---------------------------------------------------------------------------
function buildArtifactContext(runFolder, currentStage, options = {}) {
  const maxPerArtifactChars = options.maxPerArtifactChars || 4000;
  const maxTotalChars = options.maxTotalChars || 8000;

  const deps = STAGE_ARTIFACT_DEPS[currentStage];
  if (!deps || deps.length === 0) {
    return { text: '', artifacts_included: [], total_chars: 0, truncated: false };
  }

  const sections = [];
  const included = [];
  let totalChars = 0;
  let truncated = false;

  for (const artifactName of deps) {
    const artifactPath = path.join(runFolder, artifactName);
    if (!fs.existsSync(artifactPath)) continue;

    let content;
    try {
      const raw = fs.readFileSync(artifactPath, 'utf8');
      if (artifactName.endsWith('.json')) {
        // Parse and re-stringify for consistent formatting
        const parsed = JSON.parse(raw);
        content = JSON.stringify(parsed, null, 2);
      } else {
        content = raw;
      }
    } catch {
      continue; // Skip unreadable artifacts
    }

    // Per-artifact truncation
    let artifactTruncated = false;
    if (content.length > maxPerArtifactChars) {
      content = content.slice(0, maxPerArtifactChars) + '\n... [truncated]';
      artifactTruncated = true;
    }

    // Total budget check
    if (totalChars + content.length > maxTotalChars) {
      truncated = true;
      break;
    }

    const section = `=== Prior Artifact: ${artifactName} ===\n${content}`;
    sections.push(section);
    included.push(artifactName);
    totalChars += section.length;
  }

  const text = sections.join('\n\n');
  return {
    text,
    artifacts_included: included,
    total_chars: text.length,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// buildAdapterPrompt — assemble enriched prompt from task file + context
// ---------------------------------------------------------------------------
function buildAdapterPrompt(context, options = {}) {
  const maxPromptChars = options.maxPromptChars || 32000;
  const WORKSPACE_ROOT = options.workspaceRoot
    || process.env.WORKSPACE_ROOT
    || path.resolve(os.homedir(), 'dev', 'agent-work');

  // Lazy-load STAGE_CONFIG
  let STAGE_CONFIG;
  try {
    STAGE_CONFIG = require(path.resolve(__dirname, 'dev-pipeline.js')).STAGE_CONFIG;
  } catch {
    STAGE_CONFIG = {};
  }

  // Lazy-load loadArtifactSchema
  let loadArtifactSchema;
  try {
    loadArtifactSchema = require(path.resolve(__dirname, 'dev-pipeline.js')).loadArtifactSchema;
  } catch {
    loadArtifactSchema = () => null;
  }

  const parts = [];
  let templateUsed = false;

  // 1. Agent identity
  const agentIdentity = context.agentId
    ? `You are agent ${context.agentId}, a ${context.role} agent working on ticket ${context.status.ticket_id}: ${context.status.title}`
    : `You are a ${context.role} agent working on ticket ${context.status.ticket_id}: ${context.status.title}`;
  parts.push(agentIdentity);
  parts.push(`Project: ${context.status.project}`);
  parts.push(`Current stage: ${context.status.current_stage}`);

  // 2. Task file content (primary instructions)
  const stageConfig = STAGE_CONFIG[context.currentStage];
  if (stageConfig && stageConfig.taskFile) {
    const taskFilePath = path.join(context.runFolder, stageConfig.taskFile);
    if (fs.existsSync(taskFilePath)) {
      try {
        const taskContent = fs.readFileSync(taskFilePath, 'utf8');
        if (taskContent.trim()) {
          parts.push('');
          parts.push('=== Stage Instructions ===');
          parts.push(taskContent);
          templateUsed = true;
        }
      } catch {
        // Fall through to schema-based instructions
      }
    }
  }

  // 3. Prior artifact context
  let artifactContextLength = 0;
  const artifactCtx = buildArtifactContext(context.runFolder, context.currentStage, {
    maxPerArtifactChars: options.maxPerArtifactChars || 4000,
    maxTotalChars: options.maxTotalArtifactChars || 8000,
  });
  if (artifactCtx.text) {
    parts.push('');
    parts.push('=== Prior Artifacts ===');
    parts.push(artifactCtx.text);
    artifactContextLength = artifactCtx.total_chars;
  }

  // 4. Phase 5 adaptive prompt context
  let promptContextText = '';
  try {
    const { buildPromptContext } = require(PROMPT_CONTEXT_PATH);
    const ctxResult = buildPromptContext({
      workspaceRoot: WORKSPACE_ROOT,
      projectId: context.status.project,
      agentId: context.agentId || null,
    });
    if (ctxResult.ok && ctxResult.context_text) {
      promptContextText = ctxResult.context_text;
    }
  } catch {
    // Non-fatal
  }

  if (promptContextText) {
    parts.push('');
    parts.push(promptContextText);
  }

  // 5. Schema-level requirements (supplementary)
  const artifactList = context.missingArtifacts.sort();
  const schemaDescriptions = artifactList.map((a) => {
    const schema = loadArtifactSchema(a);
    if (!schema) return `- ${a}: no schema (write valid JSON with ticket_id)`;
    const required = (schema.required || []).sort().join(', ');
    return `- ${a}: required fields: [${required}]`;
  }).join('\n');

  parts.push('');
  parts.push('Produce the following artifact drafts:');
  parts.push(schemaDescriptions);
  parts.push('');
  parts.push(`Write each artifact as a file with .draft suffix in: ${context.runFolder}`);
  parts.push(`For example, write ${artifactList[0]} content to ${path.join(context.runFolder, artifactList[0] + '.draft')}`);
  parts.push('');
  parts.push('Requirements:');
  parts.push('- Each JSON artifact must be valid against its schema');
  parts.push('- Diff artifacts must be valid unified diff format');
  parts.push('- Do not create any directories');
  parts.push('- Do not modify any existing files');
  parts.push(`- Use ticket_id: "${context.status.ticket_id}" in all artifacts that require it`);

  let prompt = parts.join('\n');

  // 6. Enforce maxPromptChars — truncate least-critical sections first
  const TRUNCATION_SUFFIX = '\n... [prompt truncated]';
  if (prompt.length > maxPromptChars) {
    prompt = prompt.slice(0, maxPromptChars - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
  }

  return {
    prompt,
    template_used: templateUsed,
    artifact_context_length: artifactContextLength,
  };
}

// ---------------------------------------------------------------------------
// buildRetryPrompt — error feedback prompt for validation retries
// ---------------------------------------------------------------------------
function buildRetryPrompt(params) {
  const {
    originalPrompt,
    draftContent,
    validationErrors,
    retryNum,
    maxRetries,
    artifactName,
  } = params;

  const truncatedDraft = draftContent && draftContent.length > 2000
    ? draftContent.slice(0, 2000) + '\n... [truncated]'
    : (draftContent || '');

  const errorList = (validationErrors || []).map(e => `- ${e}`).join('\n');

  const prompt = [
    `VALIDATION FAILED — RETRY ${retryNum}/${maxRetries}`,
    '',
    `The artifact ${artifactName} had these errors:`,
    errorList,
    '',
    'Your invalid draft:',
    '---',
    truncatedDraft,
    '---',
    '',
    'Fix the errors above and write the corrected artifact to the same path.',
  ].join('\n');

  return { prompt };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  buildAdapterPrompt,
  buildArtifactContext,
  buildRetryPrompt,
  STAGE_ARTIFACT_DEPS,
};
