#!/usr/bin/env bash
set -euo pipefail

# test-all.sh — Run all dev-pipeline test suites.

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TESTS_DIR="$SCRIPT_DIR/skills/dev-pipeline/tests"

SUITES=(
  "$TESTS_DIR/test-scaffold.js"
  "$TESTS_DIR/test-state-machine.js"
  "$TESTS_DIR/test-run-next-safe.js"
  "$TESTS_DIR/test-run-next-loop.js"
  "$TESTS_DIR/test-run-next-autonomous.js"
  "$TESTS_DIR/test-run-next-watch.js"
  "$TESTS_DIR/test-run-index.js"
  "$TESTS_DIR/test-run-next-pick.js"
  "$TESTS_DIR/test-run-next-drive.js"
  "$TESTS_DIR/test-project-index.js"
  "$TESTS_DIR/test-project-next-pick.js"
  "$TESTS_DIR/test-project-next-drive.js"
  "$TESTS_DIR/test-ticket-store.js"
  "$TESTS_DIR/test-project-dashboard.js"
  "$TESTS_DIR/test-task-pack.js"
  "$TESTS_DIR/test-agent-state.js"
  "$TESTS_DIR/test-role-enforcement.js"
  "$TESTS_DIR/test-responsible-agent.js"
  "$TESTS_DIR/test-dashboard-workload.js"
  "$TESTS_DIR/test-picker-owner-role.js"
  "$TESTS_DIR/test-role-leakage.js"
  "$TESTS_DIR/test-parent-id.js"
  "$TESTS_DIR/test-validate-backlog-graph.js"
  "$TESTS_DIR/test-picker-graph.js"
  "$TESTS_DIR/test-epic-completion.js"
  "$TESTS_DIR/test-blocked-reason.js"
  "$TESTS_DIR/test-dashboard-deps.js"
  "$TESTS_DIR/test-schema-strictness.js"
  "$TESTS_DIR/test-drive-preflight.js"
  "$TESTS_DIR/test-backlog-update-status.js"
  "$TESTS_DIR/test-drive-loop.js"
  "$TESTS_DIR/test-create-ticket-and-backlog.js"
  "$TESTS_DIR/test-init-workspace.js"
  "$TESTS_DIR/test-apply-dev-patch.js"
  "$TESTS_DIR/test-generate-context-pack.js"
  "$TESTS_DIR/test-capability-registry.js"
  "$TESTS_DIR/test-goal-selector.js"
  "$TESTS_DIR/test-create-mission.js"
  "$TESTS_DIR/test-ux-audit-e2e.js"
  "$TESTS_DIR/test-security-audit-e2e.js"
  "$TESTS_DIR/test-performance-audit-e2e.js"
  "$TESTS_DIR/test-artifact-classify.js"
  "$TESTS_DIR/test-artifact-index.js"
  "$TESTS_DIR/test-research-e2e.js"
  "$TESTS_DIR/test-agent-memory.js"
  "$TESTS_DIR/test-cross-run-knowledge.js"
  "$TESTS_DIR/test-dashboard-knowledge.js"
  "$TESTS_DIR/test-run-analytics.js"
  "$TESTS_DIR/test-self-evaluate.js"
  "$TESTS_DIR/test-workflow-suggest.js"
  "$TESTS_DIR/test-gap-scanner.js"
  "$TESTS_DIR/test-agent-performance.js"
  "$TESTS_DIR/test-dashboard-phase4.js"
  "$TESTS_DIR/test-post-run-hooks.js"
  "$TESTS_DIR/test-prompt-context.js"
  "$TESTS_DIR/test-agent-actuation.js"
  "$TESTS_DIR/test-drive-loop-js.js"
  "$TESTS_DIR/test-dashboard-phase5.js"
  "$TESTS_DIR/test-dashboard-phase6.js"
  "$TESTS_DIR/test-adapter-prompt-builder.js"
  "$TESTS_DIR/test-validation-retry.js"
  "$TESTS_DIR/test-auto-patch.js"
  "$TESTS_DIR/test-post-patch-verify.js"
  "$TESTS_DIR/test-auto-commit.js"
  "$TESTS_DIR/test-claude-adapter.js"
  "$TESTS_DIR/test-dashboard-phase7.js"
)

total_passed=0
total_failed=0
suite_failures=()

for suite in "${SUITES[@]}"; do
  name="$(basename "$suite" .js)"
  echo ""
  echo "━━━ $name ━━━"
  if output=$(node "$suite" 2>&1); then
    echo "$output"
    # Parse summary line: "  N passed, M failed"
    p=$(echo "$output" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' || echo 0)
    f=$(echo "$output" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+' || echo 0)
    total_passed=$((total_passed + p))
    total_failed=$((total_failed + f))
  else
    echo "$output"
    suite_failures+=("$name")
    p=$(echo "$output" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' || echo 0)
    f=$(echo "$output" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+' || echo 0)
    total_passed=$((total_passed + p))
    total_failed=$((total_failed + f))
  fi
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  TOTAL: $total_passed passed, $total_failed failed (${#SUITES[@]} suites)"
if [ ${#suite_failures[@]} -gt 0 ]; then
  echo "  FAILED SUITES: ${suite_failures[*]}"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

[ "$total_failed" -eq 0 ] && [ ${#suite_failures[@]} -eq 0 ]
