#!/usr/bin/env bash
set -euo pipefail
# project-dashboard.sh — Aggregated project dashboard JSON.
# Usage: ./tools/project-dashboard.sh
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STORE="$SCRIPT_DIR/skills/dev-pipeline/scripts/project-dashboard.js"
exec node "$STORE" "$@"
