#!/usr/bin/env bash
set -euo pipefail
# init-workspace.sh — Initialize .claw/ directory structure in a target repo.
# Usage: ./tools/init-workspace.sh --workspace /path/to/target-repo --project_id my-project --title "My Project"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/init-workspace.js" "$@"
