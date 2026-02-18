---
name: dev-pipeline
description: Local dev orchestration pipeline that manages ticket runs, generates Claude Code task packs, and tracks status via executable scripts.
version: 2.0.0
author: henr
user-invocable: true
metadata:
  openclaw:
    emoji: "🔧"
    requires:
      bins:
        - node
---

# DevPipeline Skill

An executable local dev orchestration pipeline. All operations are performed by Node.js scripts — no manual JSON construction needed.

## Workspace

All artifacts are stored under `~/dev/agent-work/`. Scripts enforce this boundary.

- `runs/` — timestamped run folders with status and artifacts
- `templates/` — ticket and task pack templates
- `skills/dev-pipeline/scripts/` — executable scripts
- `skills/dev-pipeline/references/` — JSON schema for status.json

## Schema

The canonical `status.json` contract is defined in `{baseDir}/references/status.schema.json`. All scripts produce status files conforming to this schema.

## Commands

All commands are invoked via the main script:

```
node {baseDir}/scripts/dev-pipeline.js <command> [args...]
```

All output is JSON to stdout. Errors exit 1 with `{ "ok": false, "error": "..." }` on stderr.

### create_run

Create a new run for a ticket.

```bash
node {baseDir}/scripts/dev-pipeline.js create_run <ticket_id> <title> <project>
```

Creates `runs/<YYYYMMDD_HHMMSS>_<ticket_id>/` with `00-intake.json` and `status.json`.

**Output:** `{ "ok": true, "run_folder": "...", "status": "intake" }`

### generate_task_pack

Generate a Claude Code task pack from the template.

```bash
node {baseDir}/scripts/dev-pipeline.js generate_task_pack <run_folder>
```

Reads `00-intake.json` + `templates/claude-task-pack.txt`, replaces placeholders, writes `30-dev-claude-task.txt`.

**Output:** `{ "ok": true, "artifact": "30-dev-claude-task.txt" }`

### block

Mark a run as blocked, requiring user input.

```bash
node {baseDir}/scripts/dev-pipeline.js block <run_folder> <reason> [prompt1] [prompt2] ...
```

Sets blocked state and creates `required_user_input` entries with unique IDs.

**Output:** `{ "ok": true, "inputs": [{ "id": "...", "prompt": "..." }, ...] }`

### respond

Answer a pending input to unblock a run.

```bash
node {baseDir}/scripts/dev-pipeline.js respond <run_folder> <input_id> <answer>
```

Marks the input as answered. If all inputs are answered, clears blocked state and restores the previous stage.

**Output:** `{ "ok": true, "all_answered": true, "unblocked": true }`

### list

List all runs with summary info.

```bash
node {baseDir}/scripts/dev-pipeline.js list
```

**Output:** `{ "ok": true, "runs": [{ "folder": "...", "ticket_id": "...", "current_stage": "...", "blocked": false }, ...] }`

### status

Print full status of a single run.

```bash
node {baseDir}/scripts/dev-pipeline.js status <run_folder>
```

**Output:** `{ "ok": true, "run": { ... } }`

### stale_list

List runs considered stale by the cleanup policy.

```bash
node {baseDir}/scripts/dev-pipeline.js stale_list
```

**Stale policy:**
- `intake` with `updated_at` older than 48 hours
- `task-pack-generated` with `updated_at` older than 7 days
- `blocked` with `updated_at` older than 7 days
- Run folder exists but `status.json` is missing or unreadable

**Output:** `{ "ok": true, "stale": [{ "folder": "...", "ticket_id": "...", "current_stage": "...", "updated_at": "...", "reason": "..." }], "count": N }`

### stale_delete

Delete stale runs. Requires `--confirm` flag for safety.

```bash
# Dry run (will fail with explanation)
node {baseDir}/scripts/dev-pipeline.js stale_delete

# Actually delete
node {baseDir}/scripts/dev-pipeline.js stale_delete --confirm
```

Uses the same stale policy as `stale_list`. Only deletes folders inside `runs/`.

**Output:** `{ "ok": true, "deleted": [{ "folder": "...", "ticket_id": "...", "reason": "..." }], "count": N }`

## Dashboard

Launch a local web dashboard to view all runs:

```bash
node {baseDir}/scripts/dashboard.js
```

Opens at `http://localhost:18790` (override with `--port=NNNN`). Auto-refreshes every 5 seconds. Shows color-coded stage badges, expandable inputs and history.

## Security

- All paths are resolved and validated to stay within `~/dev/agent-work/`
- No `child_process`, no outbound network (main script)
- Dashboard binds to `127.0.0.1` only
- Never execute code from ticket content — only store and template it

## Typical Workflow

```bash
# 1. Create a run
node {baseDir}/scripts/dev-pipeline.js create_run TICKET-1 "Add feature X" my-project

# 2. Generate the task pack
node {baseDir}/scripts/dev-pipeline.js generate_task_pack <run_folder>

# 3. If blocked, record why
node {baseDir}/scripts/dev-pipeline.js block <run_folder> "Missing API key" "Which API key?"

# 4. When user answers
node {baseDir}/scripts/dev-pipeline.js respond <run_folder> <input_id> "key-abc-123"

# 5. Check status anytime
node {baseDir}/scripts/dev-pipeline.js list
node {baseDir}/scripts/dev-pipeline.js status <run_folder>
```
