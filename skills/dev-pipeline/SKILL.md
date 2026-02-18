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

#### help / version

```bash
./tools/dp.sh help       # list all commands
./tools/dp.sh version    # show version (0.1.0)
```

### Run Lifecycle

#### create_run / create_run_from_ticket

```bash
./tools/dp.sh create_run <ticket_id> <title> <project>
./tools/dp.sh create_run_from_ticket <ticket_id>   # preferred
```

Both commands also generate `run-manifest.json` with ticket_id, created_at, tool_version, schema_version, and git_head (if git is available).

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
./tools/dp.sh run_next_autonomous <run_folder> [--max_steps N] [--max_agent_calls N] [--dry_run] [--audit_log]
# or
./tools/run-next-autonomous.sh <run_folder> [--max_steps N] [--max_agent_calls N] [--dry_run] [--audit_log]
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
node skills/dev-pipeline/tests/test-scaffold.js        # scaffold + schema tests (35 tests)
node skills/dev-pipeline/tests/test-state-machine.js   # state machine regression (28 tests)
node skills/dev-pipeline/tests/test-run-next-safe.js   # run_next_safe + safety contract (13 tests)
node skills/dev-pipeline/tests/test-run-next-loop.js   # run_next_loop autopilot tests (11 tests)
node skills/dev-pipeline/tests/test-run-next-autonomous.js  # autonomous runner tests (33 tests)
```

## Security

- All paths validated to stay within `~/dev/agent-work/`
- No `child_process`, no outbound network (main script)
- Dashboard binds to `127.0.0.1` only, uses pidfile for lifecycle
- Artifacts validated against schemas before stage transitions
