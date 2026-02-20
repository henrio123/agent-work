#!/usr/bin/env bash
set -euo pipefail

# run-next-drive.sh — One-shot deterministic driver.
# Picks next eligible run, runs autonomous runner once, outputs JSON.
# Never backgrounds, never loops forever, never creates run folders.

source "$(dirname "$0")/_workspace.sh"
exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/run-next-drive.js" ${ARGS[@]+"${ARGS[@]}"}
