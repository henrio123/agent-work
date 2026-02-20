#!/usr/bin/env bash
set -euo pipefail
# ticket-guard.sh — Anti-truncation guard: verify ticket file exists before referencing.
# Usage: ./tools/ticket-guard.sh <ticket_id>
source "$(dirname "$0")/_workspace.sh"
exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/ticket-store.js" guard ${ARGS[@]+"${ARGS[@]}"}
