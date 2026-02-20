#!/usr/bin/env bash
set -euo pipefail

# run-next-autonomous.sh — Autonomous multi-agent runner.
# Drives a run forward by invoking role agents to produce draft artifacts,
# validating them, and recording them. Never creates runs or directories.

source "$(dirname "$0")/_workspace.sh"
DP="$SCRIPT_DIR/skills/dev-pipeline/scripts/dev-pipeline.js"

if [ ${#ARGS[@]} -eq 0 ]; then
  echo "Usage: ./tools/run-next-autonomous.sh <run_folder> [--max_steps N] [--max_agent_calls N] [--dry_run] [--audit_log]"
  echo ""
  echo "Autonomous multi-agent runner with draft-safe writes."
  echo "Default max_steps: 50, max_agent_calls: 20."
  echo "Use --audit_log or DP_AUDIT_LOG=1 to write <run_folder>/autonomous-audit.jsonl."
  exit 1
fi

RUN_FOLDER="${ARGS[0]}"
REMAINING=(${ARGS[@]:1+"${ARGS[@]:1}"})

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  run-next-autonomous: $RUN_FOLDER"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

node "$DP" run_next_autonomous "$RUN_FOLDER" ${REMAINING[@]+"${REMAINING[@]}"}

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
