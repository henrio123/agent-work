#!/usr/bin/env node
'use strict';

/**
 * create-mission.js — CLI entry point for mission creation.
 *
 * Writes:
 *   .claw/missions/<id>.json   — mission metadata
 *   .claw/capabilities.json    — selected capability ids
 *
 * Usage:
 *   node create-mission.js --workspace /path --goal "improve UX of checkout"
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createMission } = require('./goal-selector.js');

function fail(msg) {
  process.stderr.write(JSON.stringify({ ok: false, error: msg }) + '\n');
  process.exit(1);
}

function ok(data) {
  process.stdout.write(JSON.stringify({ ok: true, ...data }, null, 2) + '\n');
  process.exit(0);
}

// Parse CLI args
const args = process.argv.slice(2);
let workspace = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');
let goal = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--workspace' && i + 1 < args.length) {
    workspace = args[i + 1];
    i++;
  } else if (args[i] === '--goal' && i + 1 < args.length) {
    goal = args[i + 1];
    i++;
  }
}

if (!goal) {
  fail('Usage: create-mission.js --workspace <path> --goal "<text>"');
}

// Create mission
let mission;
try {
  mission = createMission(workspace, goal);
} catch (e) {
  fail(e.message);
}

// Write .claw/missions/<id>.json
const clawDir = path.join(workspace, '.claw');
if (!fs.existsSync(clawDir)) {
  fs.mkdirSync(clawDir, { recursive: true });
}

const missionsDir = path.join(clawDir, 'missions');
fs.mkdirSync(missionsDir, { recursive: true });

const missionPath = path.join(missionsDir, `${mission.id}.json`);
fs.writeFileSync(missionPath, JSON.stringify(mission, null, 2) + '\n', 'utf8');

// Write .claw/capabilities.json
const capabilitiesPath = path.join(clawDir, 'capabilities.json');
const capabilitiesData = { capabilities: mission.capabilities };
fs.writeFileSync(capabilitiesPath, JSON.stringify(capabilitiesData, null, 2) + '\n', 'utf8');

ok({
  mission_id: mission.id,
  goal: mission.goal,
  intents: mission.intents,
  stack: mission.stack.stack,
  capabilities: mission.capabilities,
  mission_path: path.relative(workspace, missionPath),
  capabilities_path: path.relative(workspace, capabilitiesPath),
});
