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
