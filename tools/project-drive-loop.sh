#!/usr/bin/env bash
set -euo pipefail

# project-drive-loop.sh — Cron-friendly loop wrapper for project-next-drive.
#
# Runs project-next-drive.js repeatedly until:
#   - No eligible work remains (action = drive_skipped)
#   - Max iterations reached
#   - A .stop file is found at the workspace root
#
# Environment variables / arguments:
#   LOOP_SLEEP_SECONDS  — seconds between iterations (default: 5)
#   LOOP_MAX_ITERATIONS — max iterations, 0 = unlimited (default: 100)
#   LOOP_PROJECT_ID     — optional: restrict to one project (not yet wired into driver)
#   --sleep <N>         — override LOOP_SLEEP_SECONDS
#   --max <N>           — override LOOP_MAX_ITERATIONS
#   --project <id>      — override LOOP_PROJECT_ID
#
# Respects $WORKSPACE_ROOT/.stop — exits cleanly if present.
# Prints a JSON summary on exit.

source "$(dirname "$0")/_workspace.sh"
DRIVE_SCRIPT="$SCRIPT_DIR/skills/dev-pipeline/scripts/project-next-drive.js"

SLEEP_SECONDS="${LOOP_SLEEP_SECONDS:-5}"
MAX_ITERATIONS="${LOOP_MAX_ITERATIONS:-100}"
PROJECT_ID="${LOOP_PROJECT_ID:-}"

# Parse CLI args from ARGS (--workspace already consumed)
set -- ${ARGS[@]+"${ARGS[@]}"}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sleep)    SLEEP_SECONDS="$2"; shift 2 ;;
    --max)      MAX_ITERATIONS="$2"; shift 2 ;;
    --project)  PROJECT_ID="$2"; shift 2 ;;
    *)          shift ;;
  esac
done

STOP_FILE="$WORKSPACE_ROOT/.stop"
iterations=0
runs_created=0
drives_attempted=0
stop_reason="unknown"

cleanup() {
  local summary
  summary=$(cat <<EOJSON
{"ok":true,"iterations":${iterations},"runs_created":${runs_created},"drives_attempted":${drives_attempted},"stop_reason":"${stop_reason}"}
EOJSON
  )
  echo "$summary"
}

trap cleanup EXIT

while true; do
  # Check .stop file
  if [[ -f "$STOP_FILE" ]]; then
    stop_reason="stop_file"
    exit 0
  fi

  # Check max iterations
  if [[ "$MAX_ITERATIONS" -gt 0 && "$iterations" -ge "$MAX_ITERATIONS" ]]; then
    stop_reason="max_iterations"
    exit 0
  fi

  iterations=$((iterations + 1))
  drives_attempted=$((drives_attempted + 1))

  # Run the driver
  drive_output=""
  drive_exit=0
  drive_output=$(node "$DRIVE_SCRIPT" 2>/dev/null) || drive_exit=$?

  if [[ $drive_exit -ne 0 ]]; then
    stop_reason="drive_error"
    exit 0
  fi

  # Parse action from JSON output
  action=$(echo "$drive_output" | node -e "
    let d='';
    process.stdin.on('data', c => d += c);
    process.stdin.on('end', () => {
      try { console.log(JSON.parse(d).action || 'unknown'); }
      catch { console.log('unknown'); }
    });
  " 2>/dev/null || echo "unknown")

  case "$action" in
    drive_created_run)
      runs_created=$((runs_created + 1))
      ;;
    drive_skipped)
      stop_reason="no_eligible_work"
      exit 0
      ;;
    drive_complete)
      # Continue to next iteration
      ;;
    *)
      stop_reason="unexpected_action"
      exit 0
      ;;
  esac

  # Sleep between iterations
  if [[ "$SLEEP_SECONDS" -gt 0 ]]; then
    sleep "$SLEEP_SECONDS"
  fi
done
