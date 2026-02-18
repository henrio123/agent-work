#!/usr/bin/env bash
set -euo pipefail

# run-next-drive.sh — One-shot deterministic driver.
# Picks next eligible run, runs autonomous runner once, outputs JSON.
# Never backgrounds, never loops forever, never creates run folders.

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DRIVE="$SCRIPT_DIR/skills/dev-pipeline/scripts/run-next-drive.js"

exec node "$DRIVE" "$@"
