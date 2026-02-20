#!/usr/bin/env node
'use strict';

/**
 * Tests for goal-selector.js — deterministic intent+stack→capability mapping.
 * Run: node skills/dev-pipeline/tests/test-goal-selector.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { parseIntents, detectStack, selectCapabilities, createMission } = require('../scripts/goal-selector.js');

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

// Temp directory for stack detection fixtures
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-sel-test-'));
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

function makeFixture(files) {
  const dir = fs.mkdtempSync(path.join(TMP, 'fix-'));
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content || '', 'utf8');
  }
  return dir;
}

// =========================================================================
// parseIntents
// =========================================================================
console.log('\n--- parseIntents ---');

test('empty/null goal returns empty intents', () => {
  assert.deepStrictEqual(parseIntents(''), []);
  assert.deepStrictEqual(parseIntents(null), []);
  assert.deepStrictEqual(parseIntents(undefined), []);
});

test('detects UX intent from keywords', () => {
  assert.ok(parseIntents('improve the UX of the checkout flow').includes('ux'));
  assert.ok(parseIntents('fix usability issues').includes('ux'));
  assert.ok(parseIntents('improve accessibility').includes('ux'));
  assert.ok(parseIntents('reduce friction in onboarding').includes('ux'));
});

test('detects security intent from keywords', () => {
  assert.ok(parseIntents('audit security vulnerabilities').includes('security'));
  assert.ok(parseIntents('fix XSS vulnerability').includes('security'));
  assert.ok(parseIntents('OWASP compliance review').includes('security'));
  assert.ok(parseIntents('pentest the API endpoints').includes('security'));
});

test('detects performance intent from keywords', () => {
  assert.ok(parseIntents('optimize page load performance').includes('performance'));
  assert.ok(parseIntents('reduce latency of API calls').includes('performance'));
  assert.ok(parseIntents('fix slow database queries').includes('performance'));
  assert.ok(parseIntents('reduce bundle size').includes('performance'));
});

test('detects refactor intent from keywords', () => {
  assert.ok(parseIntents('refactor the authentication module').includes('refactor'));
  assert.ok(parseIntents('clean up technical debt').includes('refactor'));
});

test('detects multiple intents from compound goal', () => {
  const intents = parseIntents('improve UX and fix security vulnerabilities');
  assert.ok(intents.includes('ux'));
  assert.ok(intents.includes('security'));
  assert.strictEqual(intents.length, 2);
});

test('intents are sorted alphabetically', () => {
  const intents = parseIntents('security audit and UX review and optimize performance');
  const sorted = [...intents].sort();
  assert.deepStrictEqual(intents, sorted);
});

test('no intents detected for generic goal', () => {
  const intents = parseIntents('add a new feature to the dashboard');
  // Should not detect any domain-specific intent
  assert.deepStrictEqual(intents, []);
});

// =========================================================================
// detectStack
// =========================================================================
console.log('\n--- detectStack ---');

test('detects Next.js stack from next.config.js', () => {
  const dir = makeFixture({ 'next.config.js': 'module.exports = {}' });
  const result = detectStack(dir);
  assert.strictEqual(result.stack, 'nextjs');
  assert.ok(result.signals.length > 0);
});

test('detects Next.js stack from next.config.ts', () => {
  const dir = makeFixture({ 'next.config.ts': 'export default {}' });
  const result = detectStack(dir);
  assert.strictEqual(result.stack, 'nextjs');
});

test('detects Rust stack from Cargo.toml', () => {
  const dir = makeFixture({ 'Cargo.toml': '[package]\nname = "myapp"' });
  const result = detectStack(dir);
  assert.strictEqual(result.stack, 'rust');
});

test('detects CosmWasm stack from Cargo.toml with cosmwasm', () => {
  const dir = makeFixture({ 'Cargo.toml': '[dependencies]\ncosmwasm-std = "1.0"' });
  const result = detectStack(dir);
  assert.strictEqual(result.stack, 'cosmwasm');
});

test('detects Solidity stack from foundry.toml', () => {
  const dir = makeFixture({ 'foundry.toml': '[profile.default]' });
  const result = detectStack(dir);
  assert.strictEqual(result.stack, 'solidity');
});

test('detects Python stack from pyproject.toml', () => {
  const dir = makeFixture({ 'pyproject.toml': '[build-system]' });
  const result = detectStack(dir);
  assert.strictEqual(result.stack, 'python');
});

test('returns unknown for empty directory', () => {
  const dir = makeFixture({});
  const result = detectStack(dir);
  assert.strictEqual(result.stack, 'unknown');
  assert.deepStrictEqual(result.signals, []);
});

test('signals are sorted', () => {
  const dir = makeFixture({
    'next.config.js': '',
    'package.json': '{"dependencies":{"react":"18"}}',
  });
  const result = detectStack(dir);
  const sorted = [...result.signals].sort();
  assert.deepStrictEqual(result.signals, sorted);
});

// =========================================================================
// selectCapabilities
// =========================================================================
console.log('\n--- selectCapabilities ---');

test('UX intent selects ux_audit capability', () => {
  const caps = selectCapabilities(['ux'], { stack: 'nextjs' });
  assert.deepStrictEqual(caps, ['ux_audit']);
});

test('security intent selects security_audit capability', () => {
  const caps = selectCapabilities(['security'], { stack: 'rust' });
  assert.deepStrictEqual(caps, ['security_audit']);
});

test('performance intent selects performance_audit capability', () => {
  const caps = selectCapabilities(['performance'], { stack: 'nextjs' });
  assert.deepStrictEqual(caps, ['performance_audit']);
});

test('multiple intents select multiple capabilities (sorted)', () => {
  const caps = selectCapabilities(['security', 'ux'], { stack: 'nextjs' });
  assert.deepStrictEqual(caps, ['security_audit', 'ux_audit']);
});

test('no intents + CosmWasm stack defaults to security_audit', () => {
  const caps = selectCapabilities([], { stack: 'cosmwasm' });
  assert.deepStrictEqual(caps, ['security_audit']);
});

test('no intents + Rust stack defaults to security_audit', () => {
  const caps = selectCapabilities([], { stack: 'rust' });
  assert.deepStrictEqual(caps, ['security_audit']);
});

test('no intents + Next.js stack returns empty (no default)', () => {
  const caps = selectCapabilities([], { stack: 'nextjs' });
  assert.deepStrictEqual(caps, []);
});

test('no intents + unknown stack returns empty', () => {
  const caps = selectCapabilities([], { stack: 'unknown' });
  assert.deepStrictEqual(caps, []);
});

test('capabilities are always sorted', () => {
  const caps = selectCapabilities(['ux', 'security', 'performance'], { stack: 'nextjs' });
  const sorted = [...caps].sort();
  assert.deepStrictEqual(caps, sorted);
});

// =========================================================================
// createMission (end-to-end)
// =========================================================================
console.log('\n--- createMission ---');

test('Next.js fixture with UX goal selects ux_audit', () => {
  const dir = makeFixture({
    'next.config.js': 'module.exports = {}',
    'package.json': '{"dependencies":{"react":"18"}}',
  });
  const mission = createMission(dir, 'improve the UX of the checkout flow');
  assert.ok(mission.id);
  assert.strictEqual(mission.stack.stack, 'nextjs');
  assert.ok(mission.intents.includes('ux'));
  assert.ok(mission.capabilities.includes('ux_audit'));
});

test('Rust/CosmWasm fixture with security goal selects security_audit', () => {
  const dir = makeFixture({
    'Cargo.toml': '[dependencies]\ncosmwasm-std = "1.0"',
  });
  const mission = createMission(dir, 'audit for security vulnerabilities');
  assert.strictEqual(mission.stack.stack, 'cosmwasm');
  assert.ok(mission.intents.includes('security'));
  assert.ok(mission.capabilities.includes('security_audit'));
});

test('throws for empty goal', () => {
  const dir = makeFixture({});
  assert.throws(() => createMission(dir, ''), /Goal text is required/);
  assert.throws(() => createMission(dir, '   '), /Goal text is required/);
});

test('mission has deterministic structure', () => {
  const dir = makeFixture({ 'next.config.js': '' });
  const m = createMission(dir, 'optimize performance');
  assert.ok(m.id);
  assert.strictEqual(m.goal, 'optimize performance');
  assert.ok(Array.isArray(m.intents));
  assert.ok(m.stack);
  assert.ok(Array.isArray(m.capabilities));
  assert.ok(m.created_at);
});

// =========================================================================
// Summary
// =========================================================================
console.log(`\n${'='.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

process.exit(failed > 0 ? 1 : 0);
