#!/usr/bin/env bash
set -euo pipefail

# doc-stats.sh — Print current repo statistics for documentation.
#
# Usage:
#   bash tools/doc-stats.sh
#
# Output: key=value pairs to stdout. Machine-readable, shell-sourceable.

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

scripts_count=$(ls "$SCRIPT_DIR/skills/dev-pipeline/scripts/"*.js 2>/dev/null | wc -l | tr -d ' ')
test_suites=$(grep -c '"$TESTS_DIR/' "$SCRIPT_DIR/tools/test-all.sh" | tr -d ' ')
schemas_count=$(ls "$SCRIPT_DIR/skills/dev-pipeline/schemas/"*.json "$SCRIPT_DIR/skills/dev-pipeline/references/"*.json 2>/dev/null | wc -l | tr -d ' ')
templates_count=$(ls "$SCRIPT_DIR/templates/"*.txt 2>/dev/null | wc -l | tr -d ' ')
capabilities_count=$(ls -d "$SCRIPT_DIR/skills/capabilities/"*/ 2>/dev/null | wc -l | tr -d ' ')
tools_count=$(ls "$SCRIPT_DIR/tools/"*.sh 2>/dev/null | wc -l | tr -d ' ')

echo "scripts=$scripts_count"
echo "test_suites=$test_suites"
echo "schemas=$schemas_count"
echo "templates=$templates_count"
echo "capabilities=$capabilities_count"
echo "tools=$tools_count"
