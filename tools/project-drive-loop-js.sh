#!/usr/bin/env bash
set -euo pipefail

# project-drive-loop-js.sh — Shell wrapper for the JS adaptive drive loop.
#
# Usage:
#   bash tools/project-drive-loop-js.sh [--max N] [--sleep N] [--project <id>] [--max_idle N]
#
# See skills/dev-pipeline/scripts/project-drive-loop.js for full documentation.

source "$(dirname "$0")/_workspace.sh"
LOOP_SCRIPT="$SCRIPT_DIR/skills/dev-pipeline/scripts/project-drive-loop.js"

exec node "$LOOP_SCRIPT" ${ARGS[@]+"${ARGS[@]}"}
