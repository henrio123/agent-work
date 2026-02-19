#!/usr/bin/env bash
set -euo pipefail
# task-pack-generate.sh — Generate a task pack for a backlog item.
# Usage: ./tools/task-pack-generate.sh <project_id> <task_id>
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STORE="$SCRIPT_DIR/skills/dev-pipeline/scripts/task-pack-generate.js"
exec node "$STORE" "$@"
