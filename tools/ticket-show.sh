#!/usr/bin/env bash
set -euo pipefail
# ticket-show.sh — Print raw ticket content from the persisted file.
# Usage: ./tools/ticket-show.sh <ticket_id>
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STORE="$SCRIPT_DIR/skills/dev-pipeline/scripts/ticket-store.js"
exec node "$STORE" show "$@"
