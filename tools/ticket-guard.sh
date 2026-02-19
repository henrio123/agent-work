#!/usr/bin/env bash
set -euo pipefail
# ticket-guard.sh — Anti-truncation guard: verify ticket file exists before referencing.
# Usage: ./tools/ticket-guard.sh <ticket_id>
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STORE="$SCRIPT_DIR/skills/dev-pipeline/scripts/ticket-store.js"
exec node "$STORE" guard "$@"
