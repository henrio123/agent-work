#!/usr/bin/env bash
set -euo pipefail
# project-next-pick.sh — Shell wrapper for project-next-pick.js
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PICK="$SCRIPT_DIR/skills/dev-pipeline/scripts/project-next-pick.js"
exec node "$PICK" "$@"
