#!/usr/bin/env node
'use strict';

/**
 * prompt-context.js — Assembles relevant agent memory and workflow suggestions
 * into a structured text block for injection into autonomous runner prompts.
 *
 * Collects:
 *   1. Agent memory entries (type=evaluation, lesson, warning) — last 3 evaluations, all active lessons/warnings
 *   2. Workflow suggestions for the project
 *   3. Formats as structured text for prompt injection
 *
 * Context is truncated to ~2000 chars to avoid bloating the prompt.
 * If no relevant context is found, returns empty string (backward compatible).
 *
 * CLI:
 *   node prompt-context.js --project <project_id> [--agent <agent_id>] [--ticket <ticket_id>]
 *
 * Exports:
 *   buildPromptContext({ workspaceRoot, projectId, agentId, ticketId }) → result
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
const MAX_CONTEXT_CHARS = 2000;

// Lazy-loaded modules
let _memoryModule = null;
let _workflowModule = null;

function getMemoryModule() {
  if (!_memoryModule) {
    _memoryModule = require(path.resolve(__dirname, 'agent-memory.js'));
  }
  return _memoryModule;
}

function getWorkflowModule() {
  if (!_workflowModule) {
    _workflowModule = require(path.resolve(__dirname, 'workflow-suggest.js'));
  }
  return _workflowModule;
}

// ---------------------------------------------------------------------------
// Memory collection
// ---------------------------------------------------------------------------
function collectMemoryEntries(workspaceRoot, projectId, agentId) {
  if (!agentId) return [];

  const entries = [];

  try {
    const { readMemory } = getMemoryModule();

    // Get evaluations (last 3)
    const evalResult = readMemory({
      workspaceRoot,
      agentId,
      filterType: 'evaluation',
      filterProject: projectId,
      limit: 3,
    });
    if (evalResult.ok && evalResult.entries) {
      for (const entry of evalResult.entries.slice(-3)) {
        entries.push({ type: 'evaluation', content: entry.content });
      }
    }

    // Get lessons (all active)
    const lessonResult = readMemory({
      workspaceRoot,
      agentId,
      filterType: 'lesson',
      filterProject: projectId,
    });
    if (lessonResult.ok && lessonResult.entries) {
      for (const entry of lessonResult.entries) {
        entries.push({ type: 'lesson', content: entry.content });
      }
    }

    // Get warnings (all active)
    const warningResult = readMemory({
      workspaceRoot,
      agentId,
      filterType: 'warning',
      filterProject: projectId,
    });
    if (warningResult.ok && warningResult.entries) {
      for (const entry of warningResult.entries) {
        entries.push({ type: 'warning', content: entry.content });
      }
    }
  } catch {
    // Non-fatal
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Workflow suggestions collection
// ---------------------------------------------------------------------------
function collectWorkflowSuggestions(workspaceRoot, projectId) {
  try {
    const { generateWorkflowSuggestions } = getWorkflowModule();
    const result = generateWorkflowSuggestions({ workspaceRoot, projectId });
    if (result.ok && result.suggestions && result.suggestions.length > 0) {
      return result.suggestions;
    }
  } catch {
    // Non-fatal
  }
  return [];
}

// ---------------------------------------------------------------------------
// Format context text
// ---------------------------------------------------------------------------
function formatContextText(memoryEntries, suggestions) {
  const lines = [];

  if (memoryEntries.length > 0) {
    lines.push('Prior insights for this project:');
    for (const entry of memoryEntries) {
      const truncated = entry.content.length > 200 ? entry.content.slice(0, 197) + '...' : entry.content;
      lines.push(`- [${entry.type}] ${truncated}`);
    }
  }

  if (suggestions.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Workflow suggestions:');
    for (const s of suggestions) {
      lines.push(`- ${s.category}: ${s.title}`);
    }
  }

  const text = lines.join('\n');

  // Truncate to max chars
  if (text.length > MAX_CONTEXT_CHARS) {
    return text.slice(0, MAX_CONTEXT_CHARS - 3) + '...';
  }

  return text;
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------
function buildPromptContext(options = {}) {
  const workspaceRoot = options.workspaceRoot || WORKSPACE_ROOT;
  const projectId = options.projectId;
  const agentId = options.agentId || null;

  if (!projectId) return { ok: false, action: 'no_context', context_text: '', context_length: 0, memory_entries_used: 0, workflow_suggestions_used: 0 };

  const memoryEntries = collectMemoryEntries(workspaceRoot, projectId, agentId);
  const suggestions = collectWorkflowSuggestions(workspaceRoot, projectId);

  if (memoryEntries.length === 0 && suggestions.length === 0) {
    return {
      ok: true,
      action: 'no_context',
      project_id: projectId,
      agent_id: agentId,
      context_text: '',
      context_length: 0,
      memory_entries_used: 0,
      workflow_suggestions_used: 0,
    };
  }

  const contextText = formatContextText(memoryEntries, suggestions);

  return {
    ok: true,
    action: 'context_built',
    project_id: projectId,
    agent_id: agentId,
    context_text: contextText,
    context_length: contextText.length,
    memory_entries_used: memoryEntries.length,
    workflow_suggestions_used: suggestions.length,
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

  const projectId = getArg('project');
  const agentId = getArg('agent');

  if (!projectId) {
    process.stderr.write(JSON.stringify({ ok: false, error: '--project is required' }) + '\n');
    process.exit(1);
  }

  const result = buildPromptContext({ projectId, agentId });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = { buildPromptContext };
