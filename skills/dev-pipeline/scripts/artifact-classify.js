'use strict';

/**
 * artifact-classify.js — Deterministic artifact classification.
 *
 * Maps pipeline artifact filenames to semantic types using pattern matching.
 * Supports core artifacts and capability-provided artifacts.
 * No LLM calls. Pure filename → type mapping.
 */

const path = require('node:path');
const fs = require('node:fs');

// ─── Core classification rules ──────────────────────────────────────────────
// Order matters: first match wins. Patterns are tested against the basename.

const CORE_RULES = [
  // Metadata
  { pattern: /^00-intake\.json$/, type: 'metadata', stage: 'intake' },
  { pattern: /^run-manifest\.json$/, type: 'metadata', stage: 'intake' },
  { pattern: /^status\.json$/, type: 'metadata', stage: null },

  // Analysis
  { pattern: /^10-pm-brief\.json$/, type: 'analysis', stage: 'analyze' },

  // Design
  { pattern: /^20-arch-design\.json$/, type: 'design', stage: 'plan' },

  // Implementation
  { pattern: /^40-dev-patch\.diff$/, type: 'implementation', stage: 'implement' },
  { pattern: /^41-dev-notes\.json$/, type: 'implementation', stage: 'implement' },

  // Test result
  { pattern: /^50-qa-report\.json$/, type: 'test-result', stage: 'validate' },

  // Review verdict
  { pattern: /^60-review-report\.json$/, type: 'review-verdict', stage: 'review' },

  // Task files (generated instructions for each stage)
  { pattern: /^3\d+-.*-task\.txt$/, type: 'task', stage: null },
  { pattern: /^30-dev-claude-task\.txt$/, type: 'task', stage: null },
];

// Capability artifact patterns: 15-ux-audit.json, 16-security-audit.json, etc.
// These are classified as 'audit' by default.
const CAPABILITY_ARTIFACT_PATTERN = /^1[5-9]-.*\.json$/;

// ─── Schema map for core artifacts ──────────────────────────────────────────

const CORE_SCHEMA_MAP = {
  '10-pm-brief.json': 'pm-brief.schema.json',
  '20-arch-design.json': 'arch-design.schema.json',
  '41-dev-notes.json': 'dev-notes.schema.json',
  '50-qa-report.json': 'qa-report.schema.json',
  '60-review-report.json': 'review-report.schema.json',
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Classify a single artifact filename.
 *
 * @param {string} filename - Basename of the artifact file.
 * @param {object} [capabilityContext] - Optional capability metadata.
 * @param {object} [capabilityContext.artifactSchemaMap] - Merged schema map from capability registry.
 * @param {object} [capabilityContext.stageConfig] - Merged stage config from capability registry.
 * @returns {{ semantic_type: string, stage: string|null, schema_file: string|null, capability: string|null } | null}
 *   Classification result, or null if the filename is not a recognized artifact.
 */
function classifyArtifact(filename, capabilityContext) {
  const base = path.basename(filename);

  // 1. Try core rules first
  for (const rule of CORE_RULES) {
    if (rule.pattern.test(base)) {
      return {
        semantic_type: rule.type,
        stage: rule.stage,
        schema_file: CORE_SCHEMA_MAP[base] || null,
        capability: null,
      };
    }
  }

  // 2. Try capability artifacts (15-xxx.json, 16-xxx.json, etc.)
  if (CAPABILITY_ARTIFACT_PATTERN.test(base)) {
    const result = {
      semantic_type: 'audit',
      stage: null,
      schema_file: null,
      capability: null,
    };

    // Enrich from capability context if available
    if (capabilityContext) {
      if (capabilityContext.artifactSchemaMap && capabilityContext.artifactSchemaMap[base]) {
        result.schema_file = capabilityContext.artifactSchemaMap[base];
      }
      // Find which stage produces this artifact
      if (capabilityContext.stageConfig) {
        for (const [stageName, config] of Object.entries(capabilityContext.stageConfig)) {
          if (config.requiredArtifacts && config.requiredArtifacts.includes(base)) {
            result.stage = stageName;
            // Derive capability name from stage config (capability stages have a template from capability dir)
            break;
          }
        }
      }
    }

    return result;
  }

  // 3. Not a recognized artifact
  return null;
}

/**
 * Classify all artifacts in a run folder.
 *
 * @param {string} runFolder - Absolute path to the run folder.
 * @param {object} [capabilityContext] - Optional capability metadata.
 * @returns {Array<{ artifact_file: string, semantic_type: string, stage: string|null, schema_file: string|null, capability: string|null, size_bytes: number }>}
 */
function classifyRunArtifacts(runFolder, capabilityContext) {
  if (!fs.existsSync(runFolder)) return [];

  const files = fs.readdirSync(runFolder);
  const results = [];

  for (const file of files) {
    const classification = classifyArtifact(file, capabilityContext);
    if (classification) {
      const filePath = path.join(runFolder, file);
      let sizeBytes = 0;
      try {
        sizeBytes = fs.statSync(filePath).size;
      } catch { /* ignore */ }

      results.push({
        artifact_file: file,
        semantic_type: classification.semantic_type,
        stage: classification.stage,
        schema_file: classification.schema_file,
        capability: classification.capability,
        size_bytes: sizeBytes,
      });
    }
  }

  // Sort deterministically: by semantic_type, then artifact_file
  results.sort((a, b) => {
    if (a.semantic_type !== b.semantic_type) return a.semantic_type.localeCompare(b.semantic_type);
    return a.artifact_file.localeCompare(b.artifact_file);
  });

  return results;
}

/**
 * Get all valid semantic types.
 * @returns {string[]}
 */
function getSemanticTypes() {
  return ['analysis', 'audit', 'design', 'implementation', 'metadata', 'review-verdict', 'task', 'test-result'];
}

module.exports = { classifyArtifact, classifyRunArtifacts, getSemanticTypes };
