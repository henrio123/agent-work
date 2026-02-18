#!/usr/bin/env bash
set -euo pipefail

# run-next-autonomous.sh — Autonomous multi-agent runner.
# Drives a run forward by invoking role agents to produce draft artifacts,
# validating them, and recording them. Never creates runs or directories.

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DP="$SCRIPT_DIR/skills/dev-pipeline/scripts/dev-pipeline.js"

if [ -z "${1:-}" ]; then
  echo "Usage: ./tools/run-next-autonomous.sh <run_folder> [--max_steps N] [--max_agent_calls N] [--dry_run]"
  echo ""
  echo "Autonomous multi-agent runner with draft-safe writes."
  echo "Default max_steps: 50, max_agent_calls: 20."
  exit 1
fi

RUN_FOLDER="$1"
shift

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  run-next-autonomous: $RUN_FOLDER"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

node "$DP" run_next_autonomous "$RUN_FOLDER" "$@"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
