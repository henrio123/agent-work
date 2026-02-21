#!/usr/bin/env bash
set -euo pipefail
# self-evaluate.sh — Self-evaluate a completed run against project baselines.
source "$(dirname "$0")/_workspace.sh"
exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/self-evaluate.js" ${ARGS[@]+"${ARGS[@]}"}
