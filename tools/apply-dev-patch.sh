#!/usr/bin/env bash
set -euo pipefail
# apply-dev-patch.sh — Apply 40-dev-patch.diff from a run folder to the workspace.
# Usage: ./tools/apply-dev-patch.sh --workspace /path/to/repo --run_folder .claw/runs/<folder> [--dry_run]
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/apply-dev-patch.js" "$@"
