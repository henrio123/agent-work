#!/usr/bin/env bash
set -euo pipefail
# task-pack-list.sh — List task packs and their status.
# Usage: ./tools/task-pack-list.sh [project_id]
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STORE="$SCRIPT_DIR/skills/dev-pipeline/scripts/task-pack-generate.js"
exec node "$STORE" list "$@"
