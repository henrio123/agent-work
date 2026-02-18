#!/usr/bin/env bash
set -euo pipefail

# run-next-loop.sh — Loop autopilot: repeat run_next_safe until stop.
# Never creates runs, never overwrites artifacts, never advances implicitly.

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DP="$SCRIPT_DIR/skills/dev-pipeline/scripts/dev-pipeline.js"

if [ -z "${1:-}" ]; then
  echo "Usage: ./tools/run-next-loop.sh <run_folder> [--max_steps N]"
  echo ""
  echo "Repeats safe autopilot steps until a stop condition is reached."
  echo "Default max_steps: 10."
  exit 1
fi

RUN_FOLDER="$1"
shift

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  run-next-loop: $RUN_FOLDER"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

node "$DP" run_next_loop "$RUN_FOLDER" "$@"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
