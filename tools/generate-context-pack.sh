#!/usr/bin/env bash
set -euo pipefail
# generate-context-pack.sh — Generate a context pack for a focus area.
# Usage: ./tools/generate-context-pack.sh --workspace /path/to/repo --focus <area>
source "$(dirname "$0")/_workspace.sh"
exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/generate-context-pack.js" ${ARGS[@]+"${ARGS[@]}"}
