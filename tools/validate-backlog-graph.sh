#!/usr/bin/env bash
set -euo pipefail
# validate-backlog-graph.sh — Shell wrapper for validate-backlog-graph.js
source "$(dirname "$0")/_workspace.sh"
exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/validate-backlog-graph.js" ${ARGS[@]+"${ARGS[@]}"}
