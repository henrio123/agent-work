#!/usr/bin/env bash
set -euo pipefail
# ticket-ensure.sh — Validate that a ticket file exists and has valid format.
# Usage: ./tools/ticket-ensure.sh <ticket_id>
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STORE="$SCRIPT_DIR/skills/dev-pipeline/scripts/ticket-store.js"
exec node "$STORE" ensure "$@"
