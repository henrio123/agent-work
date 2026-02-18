#!/usr/bin/env bash
set -euo pipefail

# run-next-pick.sh — Deterministic picker for next eligible run.
# Outputs JSON to stdout. Never mutates the filesystem.

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PICK="$SCRIPT_DIR/skills/dev-pipeline/scripts/run-next-pick.js"

exec node "$PICK" "$@"
