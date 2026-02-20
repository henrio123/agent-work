#!/usr/bin/env bash
set -euo pipefail

# run-index.sh — Read-only global index of all runs.
# Outputs JSON to stdout. Never mutates the filesystem.

source "$(dirname "$0")/_workspace.sh"
exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/run-index.js" ${ARGS[@]+"${ARGS[@]}"}
