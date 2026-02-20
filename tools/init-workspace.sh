#!/usr/bin/env bash
set -euo pipefail
# init-workspace.sh — Initialize .claw/ directory structure in a target repo.
# Usage: ./tools/init-workspace.sh --workspace /path/to/target-repo --project_id my-project --title "My Project"
source "$(dirname "$0")/_workspace.sh"
exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/init-workspace.js" ${ARGS[@]+"${ARGS[@]}"}
