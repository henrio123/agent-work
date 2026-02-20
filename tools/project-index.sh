#!/usr/bin/env bash
set -euo pipefail
# project-index.sh — Shell wrapper for project-index.js
source "$(dirname "$0")/_workspace.sh"
exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/project-index.js" ${ARGS[@]+"${ARGS[@]}"}
