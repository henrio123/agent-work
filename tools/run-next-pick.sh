#!/usr/bin/env bash
set -euo pipefail

# run-next-pick.sh — Deterministic picker for next eligible run.
# Outputs JSON to stdout. Never mutates the filesystem.

source "$(dirname "$0")/_workspace.sh"
exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/run-next-pick.js" ${ARGS[@]+"${ARGS[@]}"}
