#!/usr/bin/env bash
set -euo pipefail
# workflow-suggest.sh — Generate workflow improvement suggestions for a project.
source "$(dirname "$0")/_workspace.sh"
exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/workflow-suggest.js" ${ARGS[@]+"${ARGS[@]}"}
