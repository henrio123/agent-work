#!/usr/bin/env bash
set -euo pipefail
# create-mission.sh — Create a mission from a goal, auto-selecting capabilities.
# Usage: ./tools/create-mission.sh --workspace /path --goal "improve UX of checkout flow"
source "$(dirname "$0")/_workspace.sh"

# Parse --goal from remaining ARGS
GOAL=""
PASS_ARGS=()
i=0
while [ $i -lt ${#ARGS[@]} ]; do
  case "${ARGS[$i]}" in
    --goal)
      i=$((i + 1))
      GOAL="${ARGS[$i]}"
      ;;
    *)
      PASS_ARGS+=("${ARGS[$i]}")
      ;;
  esac
  i=$((i + 1))
done

if [ -z "$GOAL" ]; then
  echo '{"ok":false,"error":"Usage: create-mission.sh --workspace <path> --goal \"<text>\""}' >&2
  exit 1
fi

exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/create-mission.js" --workspace "$WORKSPACE_ROOT" --goal "$GOAL" ${PASS_ARGS[@]+"${PASS_ARGS[@]}"}
