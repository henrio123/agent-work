#!/usr/bin/env bash
set -euo pipefail
# task-pack-validate.sh — Validate a task pack against its schema.
# Usage: ./tools/task-pack-validate.sh <task_pack_path>
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STORE="$SCRIPT_DIR/skills/dev-pipeline/scripts/task-pack-generate.js"
exec node "$STORE" validate "$@"
