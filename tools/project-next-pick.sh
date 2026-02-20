#!/usr/bin/env bash
set -euo pipefail
# project-next-pick.sh — Shell wrapper for project-next-pick.js
source "$(dirname "$0")/_workspace.sh"
exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/project-next-pick.js" ${ARGS[@]+"${ARGS[@]}"}
