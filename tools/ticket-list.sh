#!/usr/bin/env bash
set -euo pipefail
# ticket-list.sh — List all persisted tickets.
# Usage: ./tools/ticket-list.sh
source "$(dirname "$0")/_workspace.sh"
exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/ticket-store.js" list ${ARGS[@]+"${ARGS[@]}"}
