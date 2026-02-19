#!/usr/bin/env bash
set -euo pipefail
# ticket-list.sh — List all persisted tickets.
# Usage: ./tools/ticket-list.sh
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STORE="$SCRIPT_DIR/skills/dev-pipeline/scripts/ticket-store.js"
exec node "$STORE" list "$@"
