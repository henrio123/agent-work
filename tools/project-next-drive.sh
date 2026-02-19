#!/usr/bin/env bash
set -euo pipefail
# project-next-drive.sh — Shell wrapper for project-next-drive.js
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DRIVE="$SCRIPT_DIR/skills/dev-pipeline/scripts/project-next-drive.js"
exec node "$DRIVE" "$@"
