#!/usr/bin/env bash
set -euo pipefail
# create-ticket.sh — Create a ticket + backlog item atomically.
# Usage: ./tools/create-ticket.sh --ticket_id T-01 --title "Fix login" ...
source "$(dirname "$0")/_workspace.sh"
exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/create-ticket-and-backlog.js" ${ARGS[@]+"${ARGS[@]}"}
