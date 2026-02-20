#!/usr/bin/env bash
set -euo pipefail
# ticket-show.sh — Print raw ticket content from the persisted file.
# Usage: ./tools/ticket-show.sh <ticket_id>
source "$(dirname "$0")/_workspace.sh"
exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/ticket-store.js" show ${ARGS[@]+"${ARGS[@]}"}
