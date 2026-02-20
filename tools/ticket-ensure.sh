#!/usr/bin/env bash
set -euo pipefail
# ticket-ensure.sh — Validate that a ticket file exists and has valid format.
# Usage: ./tools/ticket-ensure.sh <ticket_id>
source "$(dirname "$0")/_workspace.sh"
exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/ticket-store.js" ensure ${ARGS[@]+"${ARGS[@]}"}
