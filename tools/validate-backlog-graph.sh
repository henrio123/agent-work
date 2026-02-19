#!/usr/bin/env bash
set -euo pipefail
# validate-backlog-graph.sh — Shell wrapper for validate-backlog-graph.js
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/validate-backlog-graph.js" "$@"
