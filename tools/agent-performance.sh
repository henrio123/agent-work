#!/usr/bin/env bash
set -euo pipefail
# agent-performance.sh — Compute agent performance profiles and recommendation.
source "$(dirname "$0")/_workspace.sh"
exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/agent-performance.js" ${ARGS[@]+"${ARGS[@]}"}
