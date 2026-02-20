#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Capability Registry — pure loader module
//
// Three exports:
//   loadCapabilities(workspaceRoot, engineRoot, defaultStages, coreArtifactSchemaMap)
//   resolveTemplatePath(templateName, capabilityDirs, engineRoot)
//   resolveSchemaPath(schemaName, capabilityDirs, engineRoot)
// ---------------------------------------------------------------------------

const RESERVED_STAGE_NAMES = new Set([
  'intake', 'task-pack-generated', 'done', 'blocked',
  'analyze', 'plan', 'implement', 'validate', 'review',
]);

// Validate a capability name: bare directory name only
function validateCapabilityName(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('Capability name must be a non-empty string');
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..') || path.isAbsolute(name)) {
    throw new Error(`Invalid capability name (path traversal): ${name}`);
  }
}

// Validate a manifest against basic structural rules
function validateManifest(manifest, capName) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error(`Capability ${capName}: manifest must be a JSON object`);
  }
  if (!manifest.name || typeof manifest.name !== 'string') {
    throw new Error(`Capability ${capName}: missing required field "name"`);
  }
  if (!manifest.version || typeof manifest.version !== 'string') {
    throw new Error(`Capability ${capName}: missing required field "version"`);
  }
  if (!Array.isArray(manifest.stages) || manifest.stages.length === 0) {
    throw new Error(`Capability ${capName}: missing or empty "stages" array`);
  }
  for (const stage of manifest.stages) {
    if (!stage.name) throw new Error(`Capability ${capName}: stage missing "name"`);
    if (!stage.after) throw new Error(`Capability ${capName}: stage "${stage.name}" missing "after"`);
    if (!stage.role) throw new Error(`Capability ${capName}: stage "${stage.name}" missing "role"`);
    if (!Array.isArray(stage.requiredArtifacts)) {
      throw new Error(`Capability ${capName}: stage "${stage.name}" missing "requiredArtifacts"`);
    }
    if (!stage.taskFile) throw new Error(`Capability ${capName}: stage "${stage.name}" missing "taskFile"`);
    if (!stage.template) throw new Error(`Capability ${capName}: stage "${stage.name}" missing "template"`);
  }
}

/**
 * Load and merge capabilities into the pipeline stage chain.
 *
 * @param {string} workspaceRoot - Workspace root (contains .claw/)
 * @param {string} engineRoot - Engine root (contains skills/, templates/)
 * @param {object} defaultStages - The DEFAULT_STAGES object (will NOT be mutated)
 * @param {object} coreArtifactSchemaMap - The DEFAULT_ARTIFACT_SCHEMA_MAP (for override detection)
 * @returns {{ stageConfig: object, artifactSchemaMap: object, stageMigrations: object, capabilityDirs: string[] }}
 */
function loadCapabilities(workspaceRoot, engineRoot, defaultStages, coreArtifactSchemaMap) {
  const capFilePath = path.join(workspaceRoot, '.claw', 'capabilities.json');

  // No capabilities file → return empty (full backward compat)
  if (!fs.existsSync(capFilePath)) {
    return { stageConfig: {}, artifactSchemaMap: {}, stageMigrations: {}, capabilityDirs: [] };
  }

  let capFile;
  try {
    capFile = JSON.parse(fs.readFileSync(capFilePath, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to parse .claw/capabilities.json: ${e.message}`);
  }

  if (!capFile || !Array.isArray(capFile.capabilities)) {
    throw new Error('.claw/capabilities.json must have a "capabilities" array');
  }

  // Empty array → no-op
  if (capFile.capabilities.length === 0) {
    return { stageConfig: {}, artifactSchemaMap: {}, stageMigrations: {}, capabilityDirs: [] };
  }

  // Sort for deterministic ordering
  const capNames = [...capFile.capabilities].sort();

  const mergedStages = {};
  const mergedArtifactSchemas = {};
  const mergedStageMigrations = {};
  const capabilityDirs = [];

  // Track the next pointers so we can relink
  // Deep-clone the default stage next pointers into a mutable map
  const nextPointers = {};
  for (const [name, config] of Object.entries(defaultStages)) {
    nextPointers[name] = config.next;
  }

  for (const capName of capNames) {
    validateCapabilityName(capName);

    const capDir = path.join(engineRoot, 'skills', 'capabilities', capName);
    if (!fs.existsSync(capDir)) {
      throw new Error(`Capability directory not found: skills/capabilities/${capName}`);
    }

    const manifestPath = path.join(capDir, 'capability.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Capability manifest not found: skills/capabilities/${capName}/capability.json`);
    }

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      throw new Error(`Failed to parse capability manifest for ${capName}: ${e.message}`);
    }

    validateManifest(manifest, capName);
    capabilityDirs.push(capDir);

    // Process stages
    for (const stageDef of manifest.stages) {
      // Check reserved names
      if (RESERVED_STAGE_NAMES.has(stageDef.name)) {
        throw new Error(`Capability ${capName}: stage name "${stageDef.name}" conflicts with a reserved/default stage name`);
      }

      // Check duplicate from another capability
      if (mergedStages[stageDef.name]) {
        throw new Error(`Capability ${capName}: stage name "${stageDef.name}" already defined by another capability`);
      }

      // Check that 'after' target exists (in defaults or already-inserted stages)
      if (!defaultStages[stageDef.after] && !mergedStages[stageDef.after]) {
        throw new Error(`Capability ${capName}: stage "${stageDef.name}" references unknown "after" target "${stageDef.after}"`);
      }

      // Relink: newStage.next = currentNext(after), after.next = newStage
      const afterNext = nextPointers[stageDef.after];
      mergedStages[stageDef.name] = {
        role: stageDef.role,
        requiredArtifacts: stageDef.requiredArtifacts,
        taskFile: stageDef.taskFile,
        template: stageDef.template,
        next: afterNext,
      };
      nextPointers[stageDef.name] = afterNext;
      nextPointers[stageDef.after] = stageDef.name;
    }

    // Merge artifact schemas
    if (manifest.artifactSchemas && typeof manifest.artifactSchemas === 'object') {
      for (const [artifact, schema] of Object.entries(manifest.artifactSchemas)) {
        if (coreArtifactSchemaMap && coreArtifactSchemaMap[artifact]) {
          throw new Error(`Capability ${capName}: cannot override core artifact schema for "${artifact}"`);
        }
        mergedArtifactSchemas[artifact] = schema;
      }
    }

    // Merge stage migrations
    if (manifest.stageMigrations && typeof manifest.stageMigrations === 'object') {
      Object.assign(mergedStageMigrations, manifest.stageMigrations);
    }
  }

  // Build the final stageConfig with updated next pointers for default stages
  const stageConfig = {};
  for (const [name, config] of Object.entries(defaultStages)) {
    stageConfig[name] = { ...config, next: nextPointers[name] };
  }
  // Add capability stages
  Object.assign(stageConfig, mergedStages);

  return {
    stageConfig,
    artifactSchemaMap: mergedArtifactSchemas,
    stageMigrations: mergedStageMigrations,
    capabilityDirs,
  };
}

/**
 * Resolve a template file path, checking capability dirs first, then ENGINE_ROOT/templates/.
 *
 * @param {string} templateName - Template filename
 * @param {string[]} capabilityDirs - Capability directories to search
 * @param {string} engineRoot - Engine root directory
 * @returns {string} Absolute path to the template file
 * @throws If template not found anywhere
 */
function resolveTemplatePath(templateName, capabilityDirs, engineRoot) {
  // Check capability template dirs first
  if (capabilityDirs) {
    for (const dir of capabilityDirs) {
      const candidate = path.join(dir, 'templates', templateName);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  // Fall back to engine templates
  const fallback = path.join(engineRoot, 'templates', templateName);
  if (fs.existsSync(fallback)) return fallback;

  throw new Error(`Template not found: ${templateName}`);
}

/**
 * Resolve a schema file path, checking capability dirs first, then ENGINE_ROOT/skills/dev-pipeline/references/.
 *
 * @param {string} schemaName - Schema filename
 * @param {string[]} capabilityDirs - Capability directories to search
 * @param {string} engineRoot - Engine root directory
 * @returns {string|null} Absolute path to the schema file, or null if not found
 */
function resolveSchemaPath(schemaName, capabilityDirs, engineRoot) {
  // Check capability reference dirs first
  if (capabilityDirs) {
    for (const dir of capabilityDirs) {
      const candidate = path.join(dir, 'references', schemaName);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  // Fall back to engine references
  const fallback = path.join(engineRoot, 'skills', 'dev-pipeline', 'references', schemaName);
  if (fs.existsSync(fallback)) return fallback;

  return null;
}

module.exports = { loadCapabilities, resolveTemplatePath, resolveSchemaPath };
