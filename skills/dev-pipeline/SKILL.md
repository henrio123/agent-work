---
name: dev-pipeline
description: Role-based deterministic orchestration pipeline with schema-validated artifacts and reproducible execution per run.
version: 3.0.0
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

A role-based deterministic orchestration system. Each ticket moves through a fixed state machine. Each stage is owned by one role. Artifacts are schema-validated before advancing.

## Stage Machine

```
intake → task-pack-generated → pm-ready → arch-ready → dev-ready → qa-ready → review → done
                                                                              ↕
                                                                           blocked
```

| Stage | Role | Produces | Schema |
|-------|------|----------|--------|
| pm-ready | PM | 10-pm-brief.json | pm-brief.schema.json |
| arch-ready | Architect | 20-arch-design.json | arch-design.schema.json |
| dev-ready | Dev | 40-dev-patch.diff, 41-dev-notes.json | dev-notes.schema.json |
| qa-ready | QA | 50-qa-report.json | qa-report.schema.json |
| review | Review | 60-review-report.json | review-report.schema.json |

## Role Boundaries

- **PM** cannot propose code changes
- **Architect** cannot write implementation code
- **Dev** cannot change scope or acceptance criteria
- **QA** cannot change product decisions
- **Review** checks policy compliance, stage gating, and diffs

## Commands

All commands via:

```
./tools/dp.sh <command> [args...]
```

All output is JSON to stdout. Errors exit 1 with `{ "ok": false, "error": "..." }` on stderr.

### Run Lifecycle

#### create_run / create_run_from_ticket

```bash
./tools/dp.sh create_run <ticket_id> <title> <project>
./tools/dp.sh create_run_from_ticket <ticket_id>   # preferred
```

#### generate_task_pack

Generate the base Claude Code task pack (intake → task-pack-generated).

```bash
./tools/dp.sh generate_task_pack <run_folder>
```

### Orchestration

#### next_stage

Determine the next stage, role, and required artifacts.

```bash
./tools/dp.sh next_stage <run_folder>
```

**Output:** `{ "ok": true, "next_stage": "pm-ready", "role": "PM", "required_artifacts": [...], "gates_pass": bool }`

#### generate_role_pack

Generate a role-specific task pack for the **current** stage. Does NOT advance stages.

```bash
./tools/dp.sh generate_role_pack <run_folder>
```

Creates the role's task file (e.g. `31-pm-claude-task.txt`) for the current stage only. To advance, use `advance --confirm` or `orchestrate_one`.

#### record_artifact

Validate an artifact against its schema. Blocks with a specific error if validation fails.

```bash
./tools/dp.sh record_artifact <run_folder> <artifact_path>
```

#### advance

Advance to next stage if all gates pass. Requires `--confirm`.

```bash
./tools/dp.sh advance <run_folder> --confirm
```

#### orchestrate_one

Idempotent single-step orchestrator. Determines and executes the next safe action.

```bash
./tools/dp.sh orchestrate_one <run_folder>
# or
./tools/orchestrate-next.sh <run_folder>
```

### Status & Cleanup

#### list / status

```bash
./tools/dp.sh list
./tools/dp.sh status <run_folder>
```

#### block / respond

```bash
./tools/dp.sh block <run_folder> <reason> [prompt1] [prompt2] ...
./tools/dp.sh respond <run_folder> <input_id> <answer>
```

#### stale_list / stale_delete

```bash
./tools/dp.sh stale_list
./tools/dp.sh stale_delete --confirm
```

## Dashboard

```bash
./tools/dashboard-start.sh   # start (http://localhost:18790)
./tools/dashboard-stop.sh    # stop
```

Shows role, stage, artifacts, next actions with copy-to-clipboard commands, and expandable history.

## Schemas

All artifact schemas are in `{baseDir}/references/`:
- `pm-brief.schema.json`
- `arch-design.schema.json`
- `dev-notes.schema.json`
- `qa-report.schema.json`
- `review-report.schema.json`
- `run-manifest.schema.json`
- `status.schema.json`

## Typical Multi-Role Workflow

```bash
# 1. Create run from ticket
./tools/dp.sh create_run_from_ticket TICKET-1
./tools/dp.sh generate_task_pack <run_folder>

# 2. Orchestrate through roles
./tools/orchestrate-next.sh <run_folder>   # → pm-ready, generates PM task

# 3. PM creates 10-pm-brief.json, then:
./tools/dp.sh record_artifact <run_folder> <run_folder>/10-pm-brief.json

# 4. Orchestrate next
./tools/orchestrate-next.sh <run_folder>   # → arch-ready, generates Architect task

# 5. Architect creates 20-arch-design.json, then:
./tools/dp.sh record_artifact <run_folder> <run_folder>/20-arch-design.json

# 6. Continue through Dev → QA → Review → done
./tools/orchestrate-next.sh <run_folder>   # repeat for each role
```

## Security

- All paths validated to stay within `~/dev/agent-work/`
- No `child_process`, no outbound network (main script)
- Dashboard binds to `127.0.0.1` only
- Artifacts validated against schemas before stage transitions
