#!/usr/bin/env bash
set -euo pipefail
# project-index.sh — Shell wrapper for project-index.js
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INDEX="$SCRIPT_DIR/skills/dev-pipeline/scripts/project-index.js"
exec node "$INDEX" "$@"
