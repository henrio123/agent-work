#!/usr/bin/env bash
set -euo pipefail
# project-dashboard.sh — Aggregated project dashboard JSON.
# Usage: ./tools/project-dashboard.sh
source "$(dirname "$0")/_workspace.sh"
exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/project-dashboard.js" ${ARGS[@]+"${ARGS[@]}"}
