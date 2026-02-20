#!/usr/bin/env bash
set -euo pipefail
# task-pack-validate.sh — Validate a task pack against its schema.
# Usage: ./tools/task-pack-validate.sh <task_pack_path>
source "$(dirname "$0")/_workspace.sh"
exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/task-pack-generate.js" validate ${ARGS[@]+"${ARGS[@]}"}
