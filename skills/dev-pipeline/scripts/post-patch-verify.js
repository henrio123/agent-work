#!/usr/bin/env node
'use strict';

/**
 * post-patch-verify.js — Discover and run test commands after patch application.
 *
 * Phase 7 module. After a dev patch is applied to the working tree, this module
 * discovers the project's test command and runs it to validate the patch.
 *
 * Exports:
 *   discoverTestCommand(workspaceRoot) → { found, command, source }
 *   runPostPatchTests(options)         → { ok, test_command, exit_code, stdout_tail, stderr_tail, duration_ms, tests_discovered }
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Discover the project's test command
// ---------------------------------------------------------------------------
function discoverTestCommand(workspaceRoot) {
  // 1. package.json scripts.test
  const packageJsonPath = path.join(workspaceRoot, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (pkg.scripts && pkg.scripts.test) {
        const testCmd = pkg.scripts.test;
        // Skip npm init default: echo "Error: no test specified" && exit 1
        if (!testCmd.includes('echo "Error') && !testCmd.includes("echo 'Error")) {
          return { found: true, command: 'npm test', source: 'package.json' };
        }
      }
    } catch {
      // Invalid package.json — skip
    }
  }

  // 2. Makefile with test target
  const makefilePath = path.join(workspaceRoot, 'Makefile');
  if (fs.existsSync(makefilePath)) {
    try {
      const content = fs.readFileSync(makefilePath, 'utf8');
      if (/^test\s*:/m.test(content)) {
        return { found: true, command: 'make test', source: 'Makefile' };
      }
    } catch {
      // Unreadable Makefile — skip
    }
  }

  // 3. test-all.sh
  const testAllPath = path.join(workspaceRoot, 'test-all.sh');
  if (fs.existsSync(testAllPath)) {
    return { found: true, command: 'bash test-all.sh', source: 'test-all.sh' };
  }
  const toolsTestAllPath = path.join(workspaceRoot, 'tools', 'test-all.sh');
  if (fs.existsSync(toolsTestAllPath)) {
    return { found: true, command: 'bash tools/test-all.sh', source: 'tools/test-all.sh' };
  }

  // 4. Cargo.toml
  const cargoPath = path.join(workspaceRoot, 'Cargo.toml');
  if (fs.existsSync(cargoPath)) {
    return { found: true, command: 'cargo test', source: 'Cargo.toml' };
  }

  return { found: false, command: null, source: null };
}

// ---------------------------------------------------------------------------
// Run post-patch tests
// ---------------------------------------------------------------------------
function runPostPatchTests(options = {}) {
  const workspaceRoot = options.workspaceRoot;
  if (!workspaceRoot) {
    return { ok: false, test_command: null, exit_code: null, stdout_tail: '', stderr_tail: '', duration_ms: 0, tests_discovered: false, error: 'workspaceRoot is required' };
  }

  const timeoutMs = options.timeout || 120000;
  const tailChars = options.tailChars || 2000;

  // Discover test command
  const discovery = options.testCommand
    ? { found: true, command: options.testCommand, source: 'explicit' }
    : discoverTestCommand(workspaceRoot);

  if (!discovery.found) {
    return { ok: true, test_command: null, exit_code: null, stdout_tail: '', stderr_tail: '', duration_ms: 0, tests_discovered: false };
  }

  // Run the test command
  const start = Date.now();
  const parts = discovery.command.split(' ');
  const cmd = parts[0];
  const args = parts.slice(1);

  let stdout = '';
  let stderr = '';
  let exitCode = 0;

  try {
    stdout = execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      cwd: workspaceRoot,
      env: { ...process.env },
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (e) {
    exitCode = e.status || 1;
    stdout = e.stdout || '';
    stderr = e.stderr || '';
  }

  const durationMs = Date.now() - start;

  return {
    ok: exitCode === 0,
    test_command: discovery.command,
    exit_code: exitCode,
    stdout_tail: stdout.slice(-tailChars),
    stderr_tail: stderr.slice(-tailChars),
    duration_ms: durationMs,
    tests_discovered: true,
    source: discovery.source,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  const workspaceRoot = args[0] || process.cwd();

  if (args.includes('--discover')) {
    const result = discoverTestCommand(workspaceRoot);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    const result = runPostPatchTests({ workspaceRoot });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.ok ? 0 : 1);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = { discoverTestCommand, runPostPatchTests };
