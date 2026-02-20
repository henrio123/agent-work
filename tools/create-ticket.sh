#!/usr/bin/env bash
set -euo pipefail
# create-ticket.sh — Create a ticket + backlog item atomically.
# Usage: ./tools/create-ticket.sh --ticket_id T-01 --title "Fix login" ...
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/create-ticket-and-backlog.js" "$@"
