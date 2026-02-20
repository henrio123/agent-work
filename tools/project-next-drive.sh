#!/usr/bin/env bash
set -euo pipefail
# project-next-drive.sh — Shell wrapper for project-next-drive.js
source "$(dirname "$0")/_workspace.sh"
exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/project-next-drive.js" ${ARGS[@]+"${ARGS[@]}"}
