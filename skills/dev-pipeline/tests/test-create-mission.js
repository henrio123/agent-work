#!/usr/bin/env node
'use strict';

/**
 * Tests for create-mission.js — writes mission + capabilities.json correctly.
 * Run: node skills/dev-pipeline/tests/test-create-mission.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'create-mission.js');

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${label}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${label}`);
    console.log(`         ${e.message}`);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-test-'));
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

function makeWorkspace(files) {
  const dir = fs.mkdtempSync(path.join(TMP, 'ws-'));
  fs.mkdirSync(path.join(dir, '.claw'), { recursive: true });
  if (files) {
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(dir, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content || '', 'utf8');
    }
  }
  return dir;
}

function runMission(workspace, goal) {
  const cmd = `node "${SCRIPT}" --workspace "${workspace}" --goal "${goal}"`;
  return JSON.parse(execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
}

// =========================================================================
// Tests
// =========================================================================
console.log('\n--- create-mission CLI ---');

test('fails without --goal', () => {
  const ws = makeWorkspace();
  try {
    execSync(`node "${SCRIPT}" --workspace "${ws}"`, { encoding: 'utf8', stdio: 'pipe' });
    assert.fail('should have thrown');
  } catch (e) {
    assert.notStrictEqual(e.status, 0);
  }
});

test('creates mission JSON and capabilities.json for UX goal', () => {
  const ws = makeWorkspace({ 'next.config.js': '' });
  const result = runMission(ws, 'improve UX of checkout');

  assert.strictEqual(result.ok, true);
  assert.ok(result.mission_id);
  assert.deepStrictEqual(result.capabilities, ['ux_audit']);

  // Verify mission file exists
  const missionPath = path.join(ws, result.mission_path);
  assert.ok(fs.existsSync(missionPath), 'mission file should exist');
  const mission = JSON.parse(fs.readFileSync(missionPath, 'utf8'));
  assert.strictEqual(mission.goal, 'improve UX of checkout');
  assert.ok(mission.intents.includes('ux'));

  // Verify capabilities.json
  const capPath = path.join(ws, '.claw', 'capabilities.json');
  assert.ok(fs.existsSync(capPath), 'capabilities.json should exist');
  const caps = JSON.parse(fs.readFileSync(capPath, 'utf8'));
  assert.deepStrictEqual(caps.capabilities, ['ux_audit']);
});

test('creates mission with security capability for Solidity', () => {
  const ws = makeWorkspace({ 'foundry.toml': '[profile.default]' });
  const result = runMission(ws, 'audit security vulnerabilities');

  assert.strictEqual(result.ok, true);
  assert.ok(result.capabilities.includes('security_audit'));
  assert.strictEqual(result.stack, 'solidity');
});

test('creates mission with performance capability', () => {
  const ws = makeWorkspace({ 'next.config.js': '' });
  const result = runMission(ws, 'optimize performance and reduce latency');

  assert.strictEqual(result.ok, true);
  assert.ok(result.capabilities.includes('performance_audit'));
});

test('creates mission with multiple capabilities', () => {
  const ws = makeWorkspace({ 'next.config.js': '' });
  const result = runMission(ws, 'improve UX and fix security issues');

  assert.strictEqual(result.ok, true);
  assert.ok(result.capabilities.includes('ux_audit'));
  assert.ok(result.capabilities.includes('security_audit'));
  // Capabilities should be sorted
  const sorted = [...result.capabilities].sort();
  assert.deepStrictEqual(result.capabilities, sorted);
});

test('mission file is valid JSON with required fields', () => {
  const ws = makeWorkspace({});
  const result = runMission(ws, 'add a new feature');

  const missionPath = path.join(ws, result.mission_path);
  const mission = JSON.parse(fs.readFileSync(missionPath, 'utf8'));

  assert.ok(mission.id);
  assert.strictEqual(mission.goal, 'add a new feature');
  assert.ok(Array.isArray(mission.intents));
  assert.ok(mission.stack);
  assert.ok(Array.isArray(mission.capabilities));
  assert.ok(mission.created_at);
});

test('capabilities.json overwrites on subsequent missions', () => {
  const ws = makeWorkspace({ 'next.config.js': '' });

  // First mission: UX
  runMission(ws, 'improve UX');
  const caps1 = JSON.parse(fs.readFileSync(path.join(ws, '.claw', 'capabilities.json'), 'utf8'));
  assert.deepStrictEqual(caps1.capabilities, ['ux_audit']);

  // Second mission: security
  runMission(ws, 'audit security');
  const caps2 = JSON.parse(fs.readFileSync(path.join(ws, '.claw', 'capabilities.json'), 'utf8'));
  assert.deepStrictEqual(caps2.capabilities, ['security_audit']);
});

test('mission files accumulate in missions directory', () => {
  const ws = makeWorkspace({});
  runMission(ws, 'task one');
  runMission(ws, 'task two');

  const missionsDir = path.join(ws, '.claw', 'missions');
  const files = fs.readdirSync(missionsDir);
  assert.strictEqual(files.length, 2);
});

test('creates .claw if not present', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'noclawws-'));
  // No .claw dir
  const result = runMission(dir, 'add feature');
  assert.strictEqual(result.ok, true);
  assert.ok(fs.existsSync(path.join(dir, '.claw', 'capabilities.json')));
});

// =========================================================================
// Summary
// =========================================================================
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
