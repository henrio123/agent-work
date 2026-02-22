#!/usr/bin/env node
'use strict';

/**
 * goal-selector.js — Deterministic intent+stack→capability mapping.
 *
 * No ML calls. Rules-based pattern matching on goal text and repo signals.
 *
 * Exports:
 *   parseIntents(goalText) → sorted string[]
 *   detectStack(workspaceRoot) → { stack: string, signals: string[] }
 *   selectCapabilities(intents, stack) → sorted string[]
 *   createMission(workspaceRoot, goalText) → mission object
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// Intent detection — deterministic keyword matching
// ---------------------------------------------------------------------------

const INTENT_PATTERNS = [
  { intent: 'ux', patterns: [/\bux\b/i, /\buser\s*experience\b/i, /\bfriction\b/i, /\busability\b/i, /\baccessibility\b/i, /\ba11y\b/i, /\bui\s*audit\b/i, /\buser\s*flow\b/i, /\bconversion\b/i] },
  { intent: 'security', patterns: [/\bsecurit/i, /\bvulnerabilit/i, /\bowasp\b/i, /\bauth\b/i, /\bxss\b/i, /\bsql\s*inject/i, /\bcve\b/i, /\bpentest/i, /\baudit\b.*\bsecur/i, /\bsecur.*\baudit\b/i] },
  { intent: 'performance', patterns: [/\bperformanc/i, /\boptimiz/i, /\blatency\b/i, /\bthroughput\b/i, /\bbenchmark/i, /\bprofil/i, /\bslow\b/i, /\bfast\b/i, /\bspeed\b/i, /\bcache\b/i, /\bbundle\s*siz/i] },
  { intent: 'refactor', patterns: [/\brefactor/i, /\bclean\s*up\b/i, /\btechnical\s*debt\b/i, /\bcode\s*quality\b/i, /\barchitect/i, /\brestructur/i] },
  { intent: 'research', patterns: [/\bresearch\b/i, /\binvestigat/i, /\bexplor/i, /\bstud(?:y|ies)\b/i, /\bevaluat/i, /\bcompar/i, /\bspike\b/i, /\bprototyp/i, /\bexperiment/i, /\bproof\s*of\s*concept\b/i, /\bpoc\b/i, /\bfeasibilit/i] },
];

/**
 * Parse goal text into deterministic sorted intents.
 * @param {string} goalText
 * @returns {string[]} sorted unique intent identifiers
 */
function parseIntents(goalText) {
  if (!goalText || typeof goalText !== 'string') return [];

  const intents = new Set();
  for (const { intent, patterns } of INTENT_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(goalText)) {
        intents.add(intent);
        break; // one match per intent is enough
      }
    }
  }

  return [...intents].sort();
}

// ---------------------------------------------------------------------------
// Stack detection — deterministic repo signal scanning
// ---------------------------------------------------------------------------

const STACK_SIGNALS = [
  { stack: 'nextjs', files: ['next.config.js', 'next.config.ts', 'next.config.mjs'] },
  { stack: 'react', files: ['package.json'], test: (content) => /"react"/.test(content) },
  { stack: 'vue', files: ['package.json'], test: (content) => /"vue"/.test(content) },
  { stack: 'angular', files: ['angular.json'] },
  { stack: 'rust', files: ['Cargo.toml'] },
  { stack: 'solidity', files: ['foundry.toml', 'hardhat.config.js', 'hardhat.config.ts'] },
  { stack: 'python', files: ['pyproject.toml', 'setup.py', 'requirements.txt'] },
  { stack: 'go', files: ['go.mod'] },
  { stack: 'prisma', files: ['prisma/schema.prisma'] },
];

/**
 * Detect project stack via repo signals.
 * @param {string} workspaceRoot
 * @returns {{ stack: string, signals: string[] }}
 */
function detectStack(workspaceRoot) {
  const detectedSignals = [];
  const stacks = new Set();

  for (const { stack, files, test: testFn } of STACK_SIGNALS) {
    for (const file of files) {
      const filePath = path.join(workspaceRoot, file);
      if (fs.existsSync(filePath)) {
        if (testFn) {
          try {
            const content = fs.readFileSync(filePath, 'utf8');
            if (testFn(content)) {
              stacks.add(stack);
              detectedSignals.push(`${file} → ${stack}`);
            }
          } catch {
            // skip unreadable files
          }
        } else {
          stacks.add(stack);
          detectedSignals.push(`${file} → ${stack}`);
        }
      }
    }
  }

  // Determine primary stack (most specific wins)
  // Priority: solidity > nextjs > react > vue > angular > rust > python > go
  const priority = ['solidity', 'nextjs', 'react', 'vue', 'angular', 'rust', 'python', 'go'];
  let primary = 'unknown';
  for (const s of priority) {
    if (stacks.has(s)) {
      primary = s;
      break;
    }
  }

  return { stack: primary, signals: detectedSignals.sort() };
}

// ---------------------------------------------------------------------------
// Capability selection — deterministic mapping from intents + stack
// ---------------------------------------------------------------------------

// Map: intent → capability id (may depend on stack)
const INTENT_CAPABILITY_MAP = {
  'ux': 'ux_audit',
  'security': 'security_audit',
  'performance': 'performance_audit',
  'research': 'research',
};

// Stack-specific capability overrides or additions
const STACK_CAPABILITY_MAP = {
  // Frontend stacks get ux_audit by default if goal is ambiguous
  'nextjs': { defaultIntents: [] },
  'react': { defaultIntents: [] },
  'vue': { defaultIntents: [] },
  // Smart contract stacks get security_audit by default
  'solidity': { defaultIntents: ['security'] },
};

/**
 * Select capabilities based on intents and stack.
 * @param {string[]} intents - sorted intent identifiers
 * @param {{ stack: string }} stackInfo - detected stack info
 * @returns {string[]} sorted capability ids
 */
function selectCapabilities(intents, stackInfo) {
  const capabilities = new Set();

  // Map each intent to a capability
  for (const intent of intents) {
    const capId = INTENT_CAPABILITY_MAP[intent];
    if (capId) capabilities.add(capId);
  }

  // If no intents were detected, apply stack defaults
  if (intents.length === 0 && stackInfo && stackInfo.stack !== 'unknown') {
    const stackConfig = STACK_CAPABILITY_MAP[stackInfo.stack];
    if (stackConfig && stackConfig.defaultIntents) {
      for (const intent of stackConfig.defaultIntents) {
        const capId = INTENT_CAPABILITY_MAP[intent];
        if (capId) capabilities.add(capId);
      }
    }
  }

  return [...capabilities].sort();
}

// ---------------------------------------------------------------------------
// Mission creation
// ---------------------------------------------------------------------------

/**
 * Create a mission: detect stack, parse intents, select capabilities.
 * @param {string} workspaceRoot
 * @param {string} goalText
 * @returns {{ id: string, goal: string, intents: string[], stack: object, capabilities: string[], created_at: string }}
 */
function createMission(workspaceRoot, goalText) {
  if (!goalText || typeof goalText !== 'string' || !goalText.trim()) {
    throw new Error('Goal text is required');
  }

  const intents = parseIntents(goalText);
  const stackInfo = detectStack(workspaceRoot);
  const capabilities = selectCapabilities(intents, stackInfo);

  const id = crypto.randomUUID();
  const created_at = new Date().toISOString();

  return {
    id,
    goal: goalText.trim(),
    intents,
    stack: stackInfo,
    capabilities,
    created_at,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { parseIntents, detectStack, selectCapabilities, createMission };
