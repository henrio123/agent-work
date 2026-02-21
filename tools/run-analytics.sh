#!/usr/bin/env bash
set -euo pipefail
# run-analytics.sh — Compute run analytics for a project.
source "$(dirname "$0")/_workspace.sh"
exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/run-analytics.js" ${ARGS[@]+"${ARGS[@]}"}
