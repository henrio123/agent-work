#!/usr/bin/env bash
set -euo pipefail
# gap-scanner.sh — Scan for unresolved gaps in completed runs.
source "$(dirname "$0")/_workspace.sh"
exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/gap-scanner.js" ${ARGS[@]+"${ARGS[@]}"}
