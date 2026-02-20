#!/usr/bin/env bash
set -euo pipefail
# task-pack-generate.sh — Generate a task pack for a backlog item.
# Usage: ./tools/task-pack-generate.sh <project_id> <task_id>
source "$(dirname "$0")/_workspace.sh"
exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/task-pack-generate.js" ${ARGS[@]+"${ARGS[@]}"}
