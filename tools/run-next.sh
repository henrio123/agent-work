#!/usr/bin/env bash
set -euo pipefail

# run-next.sh — Single entry command for advancing a pipeline run.
# Wraps orchestrate_one and prints human-readable instructions.

source "$(dirname "$0")/_workspace.sh"
DP="$SCRIPT_DIR/skills/dev-pipeline/scripts/dev-pipeline.js"

if [ ${#ARGS[@]} -eq 0 ]; then
  echo "Usage: ./tools/run-next.sh <run_folder>"
  echo ""
  echo "Runs orchestrate_one and prints the next action."
  echo ""
  echo "Examples:"
  echo "  ./tools/run-next.sh runs/20260218_140943_OC-08"
  echo "  ./tools/run-next.sh \$(ls -d runs/*_OC-08)"
  exit 1
fi

RUN_FOLDER="${ARGS[0]}"
OUTPUT=$(node "$DP" orchestrate_one "$RUN_FOLDER")

# Parse key fields from JSON output
ACTION=$(echo "$OUTPUT" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(d.action||'')")
STAGE=$(echo "$OUTPUT" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(d.advanced_to||d.current_stage||'')")
ROLE=$(echo "$OUTPUT" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(d.role||'')")
TASK_FILE=$(echo "$OUTPUT" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(d.task_file||'')")

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Run: $RUN_FOLDER"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

case "$ACTION" in
  advanced_and_generated)
    echo "  Stage:  $STAGE"
    echo "  Role:   $ROLE"
    echo "  Task:   $RUN_FOLDER/$TASK_FILE"
    echo ""
    ARTIFACTS=$(echo "$OUTPUT" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); (d.required_artifacts||[]).forEach(a=>console.log('    - '+a))")
    if [ -n "$ARTIFACTS" ]; then
      echo "  Required artifacts:"
      echo "$ARTIFACTS"
      echo ""
      echo "  After creating artifacts, record each one:"
      echo "$OUTPUT" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); (d.required_artifacts||[]).forEach(a=>console.log('    ./tools/dp.sh record_artifact $RUN_FOLDER $RUN_FOLDER/'+a))" | RUN_FOLDER="$RUN_FOLDER" envsubst
    fi
    ;;
  waiting_for_artifacts)
    echo "  Stage:  $STAGE (waiting)"
    echo "  Role:   $ROLE"
    MISSING=$(echo "$OUTPUT" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); (d.missing_artifacts||[]).forEach(a=>console.log('    - '+a))")
    if [ -n "$MISSING" ]; then
      echo ""
      echo "  Missing artifacts:"
      echo "$MISSING"
    fi
    ;;
  blocked)
    echo "  BLOCKED"
    echo "$OUTPUT" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); (d.required_user_input||[]).forEach(i=>console.log('    ? '+i.prompt+' (id: '+i.id+')'))"
    echo ""
    echo "  Respond with:"
    echo "    ./tools/dp.sh respond $RUN_FOLDER <input_id> <answer>"
    ;;
  needs_task_pack)
    echo "  Stage: intake"
    echo ""
    echo "  Next:  ./tools/dp.sh generate_task_pack $RUN_FOLDER"
    ;;
  done)
    echo "  DONE"
    ;;
  completed)
    echo "  COMPLETED — run finished"
    ;;
  *)
    echo "$OUTPUT"
    ;;
esac

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
