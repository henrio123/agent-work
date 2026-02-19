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

For full architecture details, filesystem contracts, and governance rules see `docs/ARCHITECTURE.md` and `docs/GOVERNANCE.md`.

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

## Ticket Persistence

Every ticket must be stored as a file in `tickets/<ticket_id>.md` before it can be referenced. This prevents ticket content from being lost to terminal scrollback or conversation compaction.

### Ticket Format

```markdown
---
ticket_id: OC-22
title: Persisted Tickets and Anti Truncation Guard
project: agent-work
---

## Goal
What this ticket achieves.

## Steps
1. First step
2. Second step
```

Required frontmatter: `ticket_id`, `title`. Required headings: `GOAL`, `STEPS` (case-insensitive).

### Ticket Tools

```bash
./tools/ticket-show.sh <ticket_id>      # print raw ticket content from file
./tools/ticket-ensure.sh <ticket_id>    # validate existence and format (exit 0/1)
./tools/ticket-guard.sh <ticket_id>     # anti-truncation guard (exit 0/1)
./tools/ticket-list.sh                  # list all persisted tickets (JSON)
```

### Anti-Truncation Guard

Before referencing a ticket ID, the system must verify the ticket file exists:

```bash
./tools/ticket-guard.sh OC-22 && echo "Safe to reference"
```

If the guard fails, it prints a JSON error to stderr with a hint to create the ticket file. This ensures no ticket exists only as terminal output.

## Commands

All commands via:

```
./tools/dp.sh <command> [args...]
```

All output is JSON to stdout. Errors exit 1 with `{ "ok": false, "error": "..." }` on stderr.

#### help / version

```bash
./tools/dp.sh help       # list all commands
./tools/dp.sh version    # show version (0.1.0)
```

### Run Lifecycle

#### create_run / create_run_from_ticket

```bash
./tools/dp.sh create_run <ticket_id> <title> <project> [--agent_id <id>]
./tools/dp.sh create_run_from_ticket <ticket_id> [--agent_id <id>]   # preferred
```

Both commands also generate `run-manifest.json` with ticket_id, created_at, tool_version, schema_version, and git_head (if git is available).

When `--agent_id` is provided, the run's `responsible_agent` field is set to that agent and the initial `stage_history` entry records the `agent_id`. Without `--agent_id`, both default to `null`.

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
./tools/dp.sh record_artifact <run_folder> <artifact_path> [--agent_id <id>]
```

When `--agent_id` is provided, the agent's role (from `agents/<id>/state.json`) must match the stage's declared role in `STAGE_CONFIG`. Role mismatch exits 1 with a clear error. Without `--agent_id`, no role enforcement occurs (backward compatible).

#### advance

Advance to next stage if all gates pass. Requires `--confirm`.

```bash
./tools/dp.sh advance <run_folder> --confirm [--agent_id <id>]
```

When `--agent_id` is provided, role enforcement applies to the current stage before advancing.

#### orchestrate_one

Idempotent single-step orchestrator. Determines and executes the next safe action.

```bash
./tools/dp.sh orchestrate_one <run_folder> [--agent_id <id>]
# or
./tools/orchestrate-next.sh <run_folder>
```

#### run_next_safe

Safe autopilot: reads current state, performs one idempotent step, and returns a machine-readable decision trace. Never creates runs, never overwrites artifacts, never advances without gates passing.

```bash
./tools/dp.sh run_next_safe <run_folder>
# or
./tools/run-next-safe.sh <run_folder>
```

**Possible actions returned:**

| action | Meaning |
|--------|---------|
| `none` | Stage is `done` — nothing to do |
| `blocked` | Run is blocked, lists pending `required_inputs` |
| `needs_task_pack` | Stage is `intake`, call `generate_task_pack` first |
| `generated_role_pack` | Task file was missing, generated it (no advance) |
| `needs_artifacts` | Artifacts missing or invalid, lists `missing_artifacts` / `invalid_artifacts` |
| `advanced_and_generated` | Gates passed, advanced to next stage and generated role pack |

**Stable contract fields** (always present in every response):

| Field | Type | Description |
|-------|------|-------------|
| `ok` | boolean | Always `true` for run_next_safe responses |
| `action` | string | One of the action values above, or `error` |
| `trace` | string[] | Decision steps taken (for audit/debugging) |

Additional fields vary by action (e.g. `required_inputs` for blocked, `missing_artifacts` for needs_artifacts). The `trace` array contents are informational and may change — do not parse trace strings programmatically.

**Example: blocked response**

```json
{
  "ok": true,
  "action": "blocked",
  "current_stage": "blocked",
  "blocked_reason": "Need API credentials",
  "required_inputs": [
    { "id": "inp-abc", "prompt": "Which API key to use?" }
  ],
  "trace": ["blocked: Need API credentials", "pending inputs: 1"]
}
```

**Example: needs_artifacts response**

```json
{
  "ok": true,
  "action": "needs_artifacts",
  "current_stage": "dev-ready",
  "role": "Dev",
  "missing_artifacts": ["40-dev-patch.diff", "41-dev-notes.json"],
  "invalid_artifacts": [],
  "required_artifacts": ["40-dev-patch.diff", "41-dev-notes.json"],
  "trace": ["stage: dev-ready, role: Dev", "task file exists: 33-dev-claude-task.txt", "gates fail: 2 missing, 0 invalid"]
}
```

#### run_next_loop

Loop autopilot: repeatedly calls `run_next_safe` until a stop condition is reached. Same safety guarantees — never creates runs, never overwrites artifacts, never creates directories.

```bash
./tools/dp.sh run_next_loop <run_folder> [--max_steps N]
# or
./tools/run-next-loop.sh <run_folder> [--max_steps N]
```

Default `--max_steps` is 10. The loop stops when:
- A **stop action** is reached: `none`, `blocked`, `needs_artifacts`, `needs_task_pack`, `error`, `completed`
- **Stall detected**: fingerprint (stage + blocked + artifact count + history length) is identical between consecutive non-stop iterations
- **max_steps** exhausted

**Stable contract fields:**

| Field | Type | Description |
|-------|------|-------------|
| `ok` | boolean | Always `true` |
| `action` | string | Always `loop_complete` |
| `final_action` | string | The action that stopped the loop |
| `steps_run` | int | Number of steps executed |
| `max_steps` | int | Configured limit |
| `steps` | array | Each step's full result (action, current_stage, trace, etc.) |
| `trace` | string[] | Loop-level decision log |

**Example: needs_artifacts after multi-step progression**

```json
{
  "ok": true,
  "action": "loop_complete",
  "final_action": "needs_artifacts",
  "steps_run": 2,
  "max_steps": 10,
  "steps": [
    { "action": "advanced_and_generated", "advanced_to": "pm-ready", "role": "PM", "..." : "..." },
    { "action": "needs_artifacts", "current_stage": "pm-ready", "missing_artifacts": ["10-pm-brief.json"], "..." : "..." }
  ],
  "trace": [
    "step 1: action=advanced_and_generated, stage=pm-ready",
    "step 2: action=needs_artifacts, stage=pm-ready",
    "stopping: needs_artifacts"
  ]
}
```

#### run_next_autonomous

Autonomous multi-agent runner. Drives a run forward by repeatedly: getting the next action, invoking the correct role agent to produce draft artifacts, validating drafts against schemas, writing final artifacts (only if target does not exist), and recording them.

```bash
./tools/dp.sh run_next_autonomous <run_folder> [--max_steps N] [--max_agent_calls N] [--dry_run] [--audit_log] [--agent_id <id>]
# or
./tools/run-next-autonomous.sh <run_folder> [--max_steps N] [--max_agent_calls N] [--dry_run] [--audit_log] [--agent_id <id>]
```

Defaults: `--max_steps 50`, `--max_agent_calls 20`. Use `--dry_run` to preview without invoking agents. Use `--audit_log` (or `DP_AUDIT_LOG=1`) to write an append-only audit log.

**Safety model:**
- Agents write `.draft` files only — runner validates before writing final artifacts
- Never overwrites existing artifacts (refuses and skips)
- Never creates directories (`mkdirSync`/`mkdir` guarded)
- Snapshots `runs/` before/after and fails if changed
- All filesystem access through `safePath`

**Agent adapters** (in priority order):
1. **Claude Code** — invokes `claude` CLI with a strict prompt; falls back if unavailable
2. **Scaffold** — generates minimal schema-valid content (fallback)
3. **Draft-file** — reads pre-existing `.draft` files from the run folder

**Stable contract fields:**

| Field | Type | Description |
|-------|------|-------------|
| `ok` | boolean | Always `true` |
| `action` | string | Always `autonomous_complete` |
| `final_action` | string | `none`, `blocked`, `needs_artifacts`, `error`, `stalled`, `stopped` |
| `steps_run` | int | Total orchestration steps |
| `agent_calls` | int | Number of agent invocations |
| `artifacts_written` | string[] | Artifacts successfully written |
| `artifacts_skipped` | string[] | Artifacts skipped (already exist) |
| `trace` | string[] | Decision log |

**Example: autonomous run with artifact generation**

```json
{
  "ok": true,
  "action": "autonomous_complete",
  "final_action": "needs_artifacts",
  "steps_run": 4,
  "agent_calls": 1,
  "artifacts_written": ["10-pm-brief.json"],
  "artifacts_skipped": [],
  "trace": [
    "step 1: action=needs_task_pack, stage=intake",
    "generating task pack",
    "task pack generated",
    "step 2: action=advanced_and_generated, stage=pm-ready",
    "progress: advanced_and_generated",
    "step 3: action=needs_artifacts, stage=pm-ready",
    "invoking PM agent for: 10-pm-brief.json",
    "wrote artifact: 10-pm-brief.json",
    "recorded artifact: 10-pm-brief.json",
    "step 4: action=needs_artifacts, stage=arch-ready",
    "dry_run: would invoke Architect agent for 20-arch-design.json"
  ]
}
```

**Audit log:** When `--audit_log` is passed (or `DP_AUDIT_LOG=1`), the runner appends to `<run_folder>/autonomous-audit.jsonl`. Append-only, never truncates, one JSON object per line.

| Field | Type | Description |
|-------|------|-------------|
| `ts` | string | ISO 8601 timestamp |
| `step` | int | Step number within this invocation |
| `action` | string | The `run_next_safe` action for this step |
| `stage` | string | `current_stage` at this step |
| `event` | string | `step`, `agent_invoke`, `artifact_write`, `artifact_skip`, `draft_invalid`, `stop` |
| `detail` | string | Human-readable detail |

**Terminal output:** Progress lines go to stderr (one per step). JSON summary goes to stdout. Parse stdout for machine use.

```
stderr: autonomous: runs/20260218_150000_TICKET-1
stderr:   [1] needs_task_pack | intake | agents:0 | artifacts:0
stderr:   [2] advanced_and_generated | pm-ready | agents:0 | artifacts:0
stderr:   [3] needs_artifacts | pm-ready | agents:0 | artifacts:0
stdout: { "ok": true, "action": "autonomous_complete", ... }
```

**Stop and resume:**

```bash
# Stop: create .stop file — runner exits at next step boundary
./tools/run-next-stop.sh <run_folder>

# Resume: remove .stop file — runner continues on next invocation
./tools/run-next-resume.sh <run_folder>
```

When the runner detects `.stop` it exits with `final_action: "stopped"` and exit code 0. Rerun the autonomous command after removing `.stop` to continue.

**Example: stop and resume session**

Use two terminals — one for the runner, one for stop/resume.

```bash
# Terminal 1: start a run
$ ./tools/run-next-autonomous.sh runs/20260218_150000_TICKET-1 --audit_log

# Terminal 2: signal stop (runner exits at next step boundary)
$ ./tools/run-next-stop.sh runs/20260218_150000_TICKET-1

# Terminal 2: clear stop signal
$ ./tools/run-next-resume.sh runs/20260218_150000_TICKET-1

# Terminal 1: restart — continues from current state, skips existing artifacts
$ ./tools/run-next-autonomous.sh runs/20260218_150000_TICKET-1 --audit_log
```

**Dashboard integration:** After each invocation, `status.json` is updated with:
- `last_autonomous_run_at` — ISO 8601 timestamp of this invocation
- `last_autonomous_summary` — `{ final_action, steps_run, agent_calls, artifacts_written }`

These fields are written once at the end of invocation, never during steps.

#### watch

Read-only watcher for a run folder. Polls `status.json` for changes, optionally tails `autonomous-audit.jsonl`. Emits JSONL events to stdout. Never mutates the filesystem.

```bash
./tools/run-next-watch.sh runs/<run_folder> [--follow_audit] [--poll_ms N] [--max_events N]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--follow_audit` | off | Also tail `autonomous-audit.jsonl` |
| `--poll_ms` | 500 | Poll interval in milliseconds |
| `--max_events` | 0 (unlimited) | Stop after N events (for scripting/tests) |

**Events emitted:**

| Event | When |
|-------|------|
| `status_snapshot` | Initial status on start |
| `status_changed` | `status.json` mtime or content changed |
| `audit_line` | New line in `autonomous-audit.jsonl` |
| `audit_missing` | Audit file not present (emitted once) |
| `stop_signal_present` | `.stop` file detected |

**Example: watch alongside a running autonomous session**

```bash
# Terminal 1: run
./tools/run-next-autonomous.sh runs/20260218_150000_TICKET-1 --audit_log

# Terminal 2: watch
./tools/run-next-watch.sh runs/20260218_150000_TICKET-1 --follow_audit
```

Output (one JSON object per line):

```jsonl
{"ts":"...","event":"status_snapshot","run_folder":"runs/...","status":{...}}
{"ts":"...","event":"audit_line","line":{"step":1,"action":"needs_task_pack",...}}
{"ts":"...","event":"status_changed","run_folder":"runs/...","status":{...}}
```

Use for dashboards, CI integration, or piping into `jq` for filtering.

#### Global Operator Index

Read-only global index of all runs. Scans `runs/`, reads each `status.json`, detects stop signals, audit logs, stalled runs, and computes summary counts. Deterministic ordering (sorted by `run_folder` ASC). Never mutates the filesystem.

```bash
./tools/run-index.sh
./tools/run-index.sh | jq
```

**Output structure:**

```json
{
  "ok": true,
  "generated_at": "2026-02-18T15:00:00.000Z",
  "runs": [
    {
      "run_folder": "runs/20260218_140202_OC-07",
      "has_status": true,
      "current_stage": "dev-ready",
      "blocked": false,
      "blocked_reason": null,
      "stop_signal": false,
      "has_audit_log": true,
      "last_autonomous_run_at": "2026-02-18T14:30:00.000Z",
      "last_autonomous_summary": { "final_action": "needs_artifacts", "steps_run": 5, "agent_calls": 2, "artifacts_written": [...] },
      "stalled": false
    }
  ],
  "summary": { "total": 2, "blocked": 0, "needs_artifacts": 1, "done": 0, "stopped": 0 }
}
```

**Stalled detection:** A run is stalled when `last_autonomous_summary.final_action === "needs_artifacts"` and the audit log file has not been modified in 30+ minutes.

Used by dashboards and as foundation for the scheduler.

**Output Schemas:** The JSON output of `run-index`, `run-next-pick`, and `run-next-drive` is validated against schemas in `{baseDir}/schemas/`. Validated in CI via `test-all.sh`. Use the validator manually:

```bash
node skills/dev-pipeline/scripts/validate-json-schema.js \
  --schema skills/dev-pipeline/schemas/run-index.output.schema.json \
  --json /tmp/run-index.json
```

#### Scheduler (pick and drive)

Deterministic scheduler that selects the next run to work on and drives exactly one autonomous invocation. One-shot, no background processes, safe for CI.

**Pick next run:**

```bash
./tools/run-next-pick.sh
./tools/run-next-pick.sh | jq
```

Output: `{ "ok": true, "action": "picked_run", "run_folder": "runs/...", "reason": "priority: needs_artifacts", "priority_bucket": "needs_artifacts" }`

If nothing eligible: `{ "ok": true, "action": "no_eligible_runs", "reason": "all blocked or stopped or done" }`

**Priority buckets** (highest first):
1. `needs_task_pack` — intake/task-pack-generated stages
2. `needs_artifacts` — last autonomous action was `needs_artifacts`
3. `other` — any non-done, non-blocked, non-stopped stage

Skips: stopped (`.stop`), blocked, done runs. Within a bucket, earliest `run_folder` ASC wins.

**One-shot drive (JSON-only by default):**

```bash
./tools/run-next-drive.sh [--max_steps N] [--max_agent_calls N] [--dry_run] [--audit_log] [--verbose]
./tools/run-next-drive.sh --audit_log | jq
```

Stdout is JSON-only by default — no progress lines, safe for `| jq`. Use `--verbose` to restore human-readable progress on stderr for manual debugging.

Output: `{ "ok": true, "action": "drive_complete", "picked": {...}, "autonomous": {...} }`

If no eligible: `{ "ok": true, "action": "drive_skipped", "picked": { "action": "no_eligible_runs", ... } }`

Both exit 0 on expected outcomes, exit 1 on errors.

#### scaffold_artifacts

Create minimal schema-valid JSON files for the current stage's required artifacts. Handles `$ref`, `oneOf`/`anyOf`/`allOf`, `format` (date-time, uuid, uri), `minLength`, `minItems`, `default`, and union types. Skips `.diff` files and never overwrites existing artifacts.

```bash
./tools/dp.sh scaffold_artifacts <run_folder>
```

**Output:** `{ "ok": true, "stage": "dev-ready", "role": "Dev", "scaffolded": ["41-dev-notes.json"], "skipped_diff": ["40-dev-patch.diff"] }`

**Warning:** Scaffolded files are a starting point with minimal placeholder values. You must edit them with real content before running `record_artifact` in production work.

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

## Project Brain Layer

A project-oriented layer on top of the run engine. Provides persistent project identity, structured backlog, and agent role ownership.

### Architecture

```
Layer 0: Execution Core (runs/, status.json, autonomous runner)
Layer 1: Project Registry (projects/<id>/project.json, agents.json)
Layer 2: Backlog & Task Graph (projects/<id>/backlog/*.json)
Layer 3: Project Operator Tools (project-index, project-next-pick, project-next-drive)
```

### Data Model

```
projects/
  <project_id>/
    project.json        # project metadata
    agents.json         # agent role definitions
    backlog/
      TASK-0001.json    # backlog items
      TASK-0002.json
```

### Backlog Item Fields

| Field | Type | Description |
|-------|------|-------------|
| id | string | Unique ID (e.g. TASK-0001) |
| project_id | string | Parent project |
| type | enum | epic, task, research, design, dev, qa, docs |
| status | enum | todo, in_progress, blocked, done |
| priority | enum | P0, P1, P2, P3 |
| owner_role | enum | PM, UX_ANALYST, DESIGNER, ARCHITECT, DEV, QA |
| depends_on | string[] | IDs of blocking tasks |
| parent_id | string\|null | Parent epic ID (null if top-level) |
| run_folder | string\|null | Linked run folder (set when execution begins) |
| tags | string[] | Free-form tags |
| artifacts_expected | string[] | Expected output files |
| last_summary | object\|null | Last autonomous run summary |

### Project Operator Tools

#### project-index

Read-only global view across all projects and backlog items.

```bash
./tools/project-index.sh
```

**Output:** `{ ok, generated_at, projects: [{ project_id, totals, backlog }], summary }`

Enriches backlog items with run-level data: stop signals, blocked status, stalled detection.

#### project-next-pick

Deterministic picker for the next eligible backlog item across all projects.

```bash
./tools/project-next-pick.sh
```

**Selection rules (deterministic):**
1. Priority buckets: `ready_for_run_creation` > `needs_task_pack` > `needs_artifacts` > `other`
2. Status rank: `in_progress` > `todo`
3. Priority rank: `P0` > `P1` > `P2` > `P3`
4. Project ID ASC, then task ID ASC

Tasks with an existing task pack in `projects/<project_id>/task-packs/<task_id>.json` are classified as `ready_for_run_creation` instead of `needs_task_pack`.

**Owner role required:** Backlog items without a valid `owner_role` (missing, empty, or whitespace-only) are skipped by the picker. A JSON warning is emitted to stderr for each skipped item: `{"warning":"skipped_no_owner_role","task_id":"...","project_id":"..."}`.

**Graph-aware constraints (Phase 2):**
- Tasks whose `depends_on` items are not all `done` are skipped. Warning: `{"warning":"skipped_unsatisfied_deps","task_id":"...","blocking_deps":["DEP-1"]}`.
- Children whose parent epic is `blocked` are skipped. Warning: `{"warning":"skipped_parent_blocked","task_id":"...","parent_id":"EPIC-1"}`.
- Dangling dependencies (referencing non-existent items) do NOT block — only existing non-done dependencies block.

**Output:** `{ ok, action: "picked_task"|"no_eligible_tasks", project_id, task_id, run_folder, priority_bucket }`

#### project-next-drive

One-shot driver that picks a backlog task, ensures a run exists, and drives it once.

```bash
./tools/project-next-drive.sh [--max_steps N] [--max_agent_calls N] [--dry_run] [--audit_log] [--verbose]
```

If the picked task has no `run_folder`, creates one (intake + status.json) and links it back to the backlog item. If a task pack exists in `projects/<project_id>/task-packs/<task_id>.json`, it is copied into the new run as `10-pm-brief.json` (only if the file doesn't already exist). Then calls the existing autonomous runner once.

**Output:** `{ ok, action: "drive_complete"|"drive_created_run"|"drive_skipped", picked, run_folder, autonomous }`

### Graph Validation

Read-only DAG validator for backlog dependency and parent graphs. Detects cycles via Kahn's algorithm, validates parent_id references, enforces the epic completion rule, and warns about dependency satisfaction issues.

```bash
./tools/validate-backlog-graph.sh <project_id> [--projects_dir <path>]
```

**Checks performed:**
- `depends_on` cycle detection (Kahn's topological sort)
- `parent_id` validation: must reference an existing epic, no self-references, no circular chains
- Epic completion rule: a `done` epic with non-done children is an error
- Dependency satisfaction: warnings for todo/in_progress tasks with unfinished dependencies
- Dangling `depends_on` references produce warnings (not errors)

**Output:** `{ ok, project_id, valid, nodes, edges, cycles, parent_errors, epic_completion_errors, warnings }`

**Standalone epic completion check:**

```javascript
const { checkEpicCompletion } = require('./scripts/validate-backlog-graph.js');
const result = checkEpicCompletion('project-id', 'EPIC-1', { projectsDir });
// { ok, epic_id, project_id, can_complete, incomplete_children }
```

### Project Schemas

All project schemas are in `{baseDir}/schemas/`:
- `project.schema.json` — project metadata
- `agents.schema.json` — agent role definitions
- `backlog-item.schema.json` — backlog item structure

Output schemas:
- `project-index.output.schema.json`
- `project-next-pick.output.schema.json`
- `project-next-drive.output.schema.json`
- `project-dashboard.output.schema.json`
- `validate-backlog-graph.output.schema.json`

### Project Dashboard

Read-only aggregated JSON view of all projects, backlog items, and their computed state. Suitable for dashboards, automation, or feeding into other tools.

```bash
./tools/project-dashboard.sh
./tools/project-dashboard.sh | jq
```

**Output includes per-item computed fields:**

| Field | Type | Description |
|-------|------|-------------|
| priority_bucket | string\|null | `ready_for_run_creation`, `needs_task_pack`, `needs_artifacts`, `other`, or null for done |
| run_stage | string\|null | Current stage from linked run's status.json |
| run_blocked | boolean | Whether the linked run is blocked |
| run_stop | boolean | Whether a .stop file exists in the linked run |
| needs_task_pack | boolean | True if task has no task pack yet |
| needs_artifacts | boolean | True if linked run needs artifacts |
| stalled | boolean | True if linked run is stalled |
| children | string[] | IDs of child items (whose parent_id is this item) |
| depends_on_status | array | `[{ id, status }]` for each dependency |
| blocked_by_deps | string[] | Dependency IDs that are not done |
| is_blocked_by_parent | boolean | True if parent epic is blocked |

Summary includes: `needs_task_pack` and `needs_artifacts` counts in addition to standard totals.

#### Agent Workload

Each project includes a `workload_by_agent` array with one entry per agent seen in that project's linked runs:

| Field | Type | Description |
|-------|------|-------------|
| agent_id | string | Agent identity |
| role | string | Resolved from `agents/<id>/state.json`; `"unknown"` if not found |
| runs_responsible | number | Runs where `responsible_agent === agent_id` |
| stages_driven | number | `stage_history` entries where `agent_id` matches |
| active_runs | number | Runs where responsible AND `current_stage !== "done"` |

Sorted by `agent_id` ascending for determinism. Null agent IDs are excluded.

The top-level `summary.workload_summary` aggregates across all projects:
- `runs_per_role`: count of runs per role (e.g. `{ "PM": 3, "Dev": 2 }`)
- `stages_per_role`: count of stage_history entries per role

### Task Packs

Deterministic task pack generator. Produces a structured JSON file for a backlog item by scanning available project files, agents, linked runs, and patterns. No LLM calls.

```bash
# Generate a task pack
./tools/task-pack-generate.sh <project_id> <task_id>

# Validate an existing task pack
./tools/task-pack-validate.sh <task_pack_path>

# List all task packs
./tools/task-pack-list.sh [project_id]
```

**Task pack location:** `projects/<project_id>/task-packs/<task_id>.json`

**Task pack fields:**

| Field | Type | Description |
|-------|------|-------------|
| task_id | string | Backlog item ID |
| project_id | string | Parent project |
| title | string | From backlog item |
| description | string | From backlog item |
| owner_role | string | From backlog item |
| inputs_present | string[] | Files found during scan |
| open_questions | string[] | Gaps detected during inference |
| artifacts_expected | string[] | Expected pipeline outputs |
| acceptance_criteria | string[] | Inferred from description |
| constraints | string[] | Standard pipeline constraints |
| suggested_next_agents | string[] | Inferred from owner_role |
| references | string[] | File paths referenced |
| created_at | string | ISO 8601 |
| updated_at | string | ISO 8601 |

**Integration with picker:** Tasks with a task pack are classified as `ready_for_run_creation` (highest priority bucket). Tasks without one remain `needs_task_pack`.

**Integration with driver:** When `project-next-drive` creates a run for a task with an existing task pack, the pack is copied into the run as `10-pm-brief.json`.

**Schema:** `task-pack.schema.json` (additionalProperties: false)

## Agent State

Persistent agent identity contract. Each agent gets `agents/<agent_id>/state.json` at `WORKSPACE_ROOT/agents/`.

### Data Model

```
agents/
  <agent_id>/
    state.json    # persistent agent state
```

| Field | Type | Description |
|-------|------|-------------|
| agent_id | string | Unique agent identifier |
| role | string | Assigned role (e.g. PM, Architect, Dev, QA, Review) |
| current_task | string\|null | Currently assigned task ID |
| workload.runs_started | integer | Count of runs started |
| workload.stages_completed | integer | Count of stages completed |
| created_at | string | ISO 8601 creation timestamp |
| updated_at | string | ISO 8601 last update timestamp |
| last_active_at | string | ISO 8601 last activity timestamp |

### Agent State Tools

```bash
./tools/agent-state.sh init <agent_id> <role>                          # create new agent
./tools/agent-state.sh read <agent_id>                                 # read agent state
./tools/agent-state.sh assign <agent_id> <task_id>                     # assign task
./tools/agent-state.sh clear <agent_id>                                # clear current task
./tools/agent-state.sh increment <agent_id> <runs_started|stages_completed> [amount]  # increment workload
./tools/agent-state.sh list                                            # list all agents
```

All output is JSON. Errors exit 1 with `{ "ok": false, "error": "..." }` on stderr.

**Schema:** `agent-state.schema.json` (additionalProperties: false)

## Responsible Agent Tracking

Every run's `status.json` includes a `responsible_agent` field (top-level, string or null) that identifies which agent is currently driving the run. Each `stage_history` entry includes an `agent_id` field (string or null) recording which agent drove that particular stage.

- **Set on creation:** `create_run` and `create_run_from_ticket` populate `responsible_agent` and `stage_history[0].agent_id` from `--agent_id` if provided, otherwise `null`.
- **Updated on transitions:** `advance`, `orchestrate_one`, and `record_artifact` update `responsible_agent` when `--agent_id` is provided; leave it unchanged otherwise. New `stage_history` entries always include `agent_id`.
- **Backward compatibility:** `normalizeStatus()` sets `responsible_agent: null` when reading old `status.json` files that lack the field. No crash, no data loss.

## Schemas

All artifact schemas are in `{baseDir}/references/`:
- `pm-brief.schema.json`
- `arch-design.schema.json`
- `dev-notes.schema.json`
- `qa-report.schema.json`
- `review-report.schema.json`
- `run-manifest.schema.json`
- `status.schema.json`

All output schemas are in `{baseDir}/schemas/`:
- `run-index.output.schema.json`
- `run-next-pick.output.schema.json`
- `run-next-drive.output.schema.json`
- `project-index.output.schema.json`
- `project-next-pick.output.schema.json`
- `project-next-drive.output.schema.json`
- `project-dashboard.output.schema.json`
- `task-pack.schema.json`
- `agent-state.schema.json`

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

## QA Checklist

QA verification should use **only read-only commands** that do not create runs or modify state:

```bash
./tools/dp.sh list                                          # list all runs
./tools/dp.sh status <run_folder>                           # full status
./tools/dp.sh next_stage <run_folder>                       # gate check
./tools/dp.sh record_artifact <run_folder> <artifact_path>  # validate existing artifact
```

**Do NOT use** `create_run`, `create_run_from_ticket`, or `advance` during QA. The QA role verifies — it does not create or advance.

## Testing

Run all suites at once:

```bash
./tools/test-all.sh
```

Or individually:

```bash
node skills/dev-pipeline/tests/test-scaffold.js            # scaffold + schema tests (35 tests)
node skills/dev-pipeline/tests/test-state-machine.js       # state machine regression (28 tests)
node skills/dev-pipeline/tests/test-run-next-safe.js       # run_next_safe + safety contract (13 tests)
node skills/dev-pipeline/tests/test-run-next-loop.js       # run_next_loop autopilot tests (11 tests)
node skills/dev-pipeline/tests/test-run-next-autonomous.js # autonomous runner tests (33 tests)
node skills/dev-pipeline/tests/test-run-next-watch.js      # watch mode tests (17 tests)
node skills/dev-pipeline/tests/test-run-index.js           # global run index tests (22 tests)
node skills/dev-pipeline/tests/test-run-next-pick.js       # scheduler pick tests (21 tests)
node skills/dev-pipeline/tests/test-run-next-drive.js      # scheduler drive tests (16 tests)
node skills/dev-pipeline/tests/test-project-index.js       # project index tests (18 tests)
node skills/dev-pipeline/tests/test-project-next-pick.js   # project picker tests (22 tests)
node skills/dev-pipeline/tests/test-project-next-drive.js  # project driver tests (11 tests)
node skills/dev-pipeline/tests/test-ticket-store.js        # ticket persistence tests (41 tests)
node skills/dev-pipeline/tests/test-project-dashboard.js   # project dashboard tests (20 tests)
node skills/dev-pipeline/tests/test-task-pack.js           # task pack tests (28 tests)
node skills/dev-pipeline/tests/test-agent-state.js         # agent state tests (29 tests)
node skills/dev-pipeline/tests/test-role-enforcement.js    # role enforcement tests (21 tests)
node skills/dev-pipeline/tests/test-responsible-agent.js   # responsible agent field tests (13 tests)
node skills/dev-pipeline/tests/test-dashboard-workload.js  # dashboard workload stats tests (13 tests)
node skills/dev-pipeline/tests/test-picker-owner-role.js   # picker owner_role enforcement tests (8 tests)
node skills/dev-pipeline/tests/test-role-leakage.js        # role leakage prevention tests (15 tests)
node skills/dev-pipeline/tests/test-parent-id.js           # parent_id field passthrough tests (9 tests)
node skills/dev-pipeline/tests/test-validate-backlog-graph.js # DAG validation and cycle detection (16 tests)
node skills/dev-pipeline/tests/test-picker-graph.js        # graph-aware picker tests (17 tests)
node skills/dev-pipeline/tests/test-epic-completion.js     # epic completion rule tests (13 tests)
node skills/dev-pipeline/tests/test-blocked-reason.js      # blocked reason enforcement tests (8 tests)
node skills/dev-pipeline/tests/test-dashboard-deps.js      # dashboard dependency chain tests (12 tests)
```

## Security

- All paths validated to stay within `~/dev/agent-work/`
- No `child_process`, no outbound network (main script)
- Dashboard binds to `127.0.0.1` only, uses pidfile for lifecycle
- Artifacts validated against schemas before stage transitions
