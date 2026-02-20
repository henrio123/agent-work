#!/usr/bin/env bash
set -euo pipefail
# task-pack-list.sh — List task packs and their status.
# Usage: ./tools/task-pack-list.sh [project_id]
source "$(dirname "$0")/_workspace.sh"
exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/task-pack-generate.js" list ${ARGS[@]+"${ARGS[@]}"}
