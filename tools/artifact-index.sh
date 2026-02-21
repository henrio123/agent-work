#!/usr/bin/env bash
set -euo pipefail
# artifact-index.sh — Shell wrapper for artifact-index.js
source "$(dirname "$0")/_workspace.sh"
exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/artifact-index.js" ${ARGS[@]+"${ARGS[@]}"}
