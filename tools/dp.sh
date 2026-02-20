#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/_workspace.sh"
exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/dev-pipeline.js" ${ARGS[@]+"${ARGS[@]}"}
