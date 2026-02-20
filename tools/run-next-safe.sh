#!/usr/bin/env bash
set -euo pipefail

# run-next-safe.sh — Safe autopilot: one step with decision trace.
# Never creates runs, never overwrites artifacts, never advances implicitly.

source "$(dirname "$0")/_workspace.sh"
DP="$SCRIPT_DIR/skills/dev-pipeline/scripts/dev-pipeline.js"

if [ ${#ARGS[@]} -eq 0 ]; then
  echo "Usage: ./tools/run-next-safe.sh <run_folder>"
  echo ""
  echo "Performs one safe orchestration step and prints a decision trace."
  echo "Safe to call repeatedly — idempotent when state has not changed."
  exit 1
fi

RUN_FOLDER="${ARGS[0]}"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  run-next-safe: $RUN_FOLDER"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

node "$DP" run_next_safe "$RUN_FOLDER"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
