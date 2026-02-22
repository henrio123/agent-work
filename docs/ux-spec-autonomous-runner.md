## Autonomous Runner — UX & Observability Contract

### CLI Usage

```bash
./tools/run-next-autonomous.sh <run_folder> [--max_steps N] [--max_agent_calls N] [--dry_run]
# or
./tools/dp.sh run_next_autonomous <run_folder> [--max_steps N] [--max_agent_calls N] [--dry_run]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--max_steps` | 50 | Maximum orchestration steps before stopping |
| `--max_agent_calls` | 20 | Maximum agent invocations (artifact generation) |
| `--dry_run` | off | Preview mode: report what would happen without invoking agents |

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Completed successfully. `final_action` is `none`, `blocked`, `needs_artifacts`, or `stalled`. |
| 1 | Error. `final_action` is `error`. Stderr contains `{ "ok": false, "error": "..." }`. |

The exit code reflects whether the runner itself succeeded — not whether the run reached `done`. A run that stops at `needs_artifacts` exits 0 because the runner operated correctly; it just needs external work. A run that stops at `error` exits 1 because something unexpected happened.

### Terminal Output Contract

The runner produces exactly three sections to stdout, in order:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  run-next-autonomous: <run_folder>        ← header (from wrapper)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{                                          ← JSON summary (from node)
  "ok": true,
  "action": "autonomous_complete",
  ...
}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ← footer (from wrapper)
```

**Parsing rule:** The JSON blob is the single machine-readable artifact. Strip the `━━━` header/footer lines. Everything between them is valid JSON. No interleaved progress lines, no ANSI codes, no partial output.

**Human-readable summary** is derived by the caller from the JSON fields:

| Field | What to display |
|-------|-----------------|
| `final_action` | Terminal state: `none` (done), `blocked`, `needs_artifacts`, `error`, `stalled` |
| `steps_run` / `max_steps` | Progress fraction |
| `agent_calls` / `max_agent_calls` | Agent budget used |
| `artifacts_written` | Files created this run |
| `artifacts_skipped` | Files already present (idempotent skip) |
| `trace` | Decision log, one entry per action taken |

### Stable JSON Contract

Every response has `action: "autonomous_complete"` and these fields:

| Field | Type | Guaranteed |
|-------|------|------------|
| `ok` | boolean | Always `true` for success, absent on exit 1 |
| `action` | `"autonomous_complete"` | Always this literal |
| `final_action` | string | `none`, `blocked`, `needs_artifacts`, `error`, `stalled` |
| `steps_run` | int | Number of orchestration steps executed |
| `max_steps` | int | Configured limit |
| `agent_calls` | int | Number of agent invocations |
| `max_agent_calls` | int | Configured limit |
| `artifacts_written` | string[] | Artifact filenames written this invocation |
| `artifacts_skipped` | string[] | Artifact filenames skipped (already existed) |
| `trace` | string[] | Ordered decision log |

The `trace` entries are informational strings. Do not parse them programmatically — structure may change. Use `final_action`, `artifacts_written`, and `artifacts_skipped` for decisions.

### Dashboard Expectations

The dashboard at `http://localhost:18790` reads `status.json` from each run folder. During an autonomous run, these fields change:

| Field | When it changes |
|-------|-----------------|
| `current_stage` | After each `advance` (e.g. `analyze` → `plan`) |
| `updated_at` | After every status write (artifact record, advance, block) |
| `stage_history` | New entry appended per stage transition; `finished_at` set on old stage |
| `stage_history[].artifact_paths` | Updated when `record_artifact` succeeds |
| `next_actions` | Recomputed on every status write |
| `blocked` / `blocked_reason` | Set if runner hits a block |

**What to watch:**
- `current_stage` advancing through the pipeline is normal progress
- `updated_at` not changing means the runner is stalled or between agent calls
- `artifacts_written` growing means the agent is producing work
- `blocked: true` means the runner stopped and needs human input

The dashboard auto-refreshes every 5 seconds. No manual reload required during a run.

### Audit Log

When `--audit_log` is passed (or the environment variable `DP_AUDIT_LOG=1` is set), the runner appends to a log file inside the run folder:

```
<run_folder>/autonomous-audit.jsonl
```

**Rules:**
- Append-only. Never truncate, never overwrite, never delete.
- Never create directories. If the run folder does not exist, skip logging silently.
- One JSON object per line (JSONL format).

**Log line schema:**

| Field | Type | Description |
|-------|------|-------------|
| `ts` | string | ISO 8601 timestamp |
| `step` | int | Step number within this invocation |
| `action` | string | The `run_next_safe` action for this step |
| `stage` | string | `current_stage` at this step |
| `event` | string | `step`, `agent_invoke`, `artifact_write`, `artifact_skip`, `draft_invalid`, `stop` |
| `detail` | string | Human-readable detail (artifact name, error message, etc.) |

**Example lines:**

```jsonl
{"ts":"2026-02-18T15:00:01.000Z","step":1,"action":"needs_task_pack","stage":"intake","event":"step","detail":"generating task pack"}
{"ts":"2026-02-18T15:00:01.500Z","step":2,"action":"advanced_and_generated","stage":"analyze","event":"step","detail":"advanced to analyze"}
{"ts":"2026-02-18T15:00:02.000Z","step":3,"action":"needs_artifacts","stage":"analyze","event":"agent_invoke","detail":"Analyst: 10-pm-brief.json"}
{"ts":"2026-02-18T15:00:03.000Z","step":3,"action":"needs_artifacts","stage":"analyze","event":"artifact_write","detail":"10-pm-brief.json"}
{"ts":"2026-02-18T15:00:05.000Z","step":5,"action":"none","stage":"done","event":"stop","detail":"final_action=none"}
```

**Correlation:** Each invocation of `run_next_autonomous` appends to the same file. Step numbers reset per invocation. Use `ts` to distinguish invocations.

### Resume Semantics

The autonomous runner is fully idempotent. Rerunning the same command on the same run folder continues safely from the current state.

**Guarantees:**
- If an artifact already exists, it is skipped (logged in `artifacts_skipped`), never overwritten
- If a stage was already advanced, `run_next_safe` returns the current state and the runner proceeds to the next action
- If the run was blocked, the runner stops at `blocked` — resolve with `respond`, then rerun
- If the run was `done`, the runner stops at `none` in one step
- Draft files from a prior interrupted run are not reused unless the `draft-file` adapter is explicitly selected

**Interruption:** Ctrl-C during execution may leave `.draft` files in the run folder. These are harmless — the runner ignores them on next invocation (scaffold adapter generates fresh drafts). To clean up: `rm <run_folder>/*.draft`

**Rerun after partial progress:**

```bash
# First run: writes analysis brief, stops at plan needs_artifacts
./tools/run-next-autonomous.sh runs/20260218_150000_TICKET-1

# Second run: skips Analyst brief (exists), writes arch design, continues
./tools/run-next-autonomous.sh runs/20260218_150000_TICKET-1
```

### Example Sessions

#### Session 1: needs_task_pack path

Fresh run at `intake` stage. No task pack generated yet.

```bash
$ ./tools/run-next-autonomous.sh runs/20260218_150000_TICKET-1
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  run-next-autonomous: runs/20260218_150000_TICKET-1
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{
  "ok": true,
  "action": "autonomous_complete",
  "final_action": "needs_artifacts",
  "steps_run": 4,
  "max_steps": 50,
  "agent_calls": 1,
  "max_agent_calls": 20,
  "artifacts_written": [
    "10-pm-brief.json"
  ],
  "artifacts_skipped": [],
  "trace": [
    "step 1: action=needs_task_pack, stage=intake",
    "generating task pack",
    "task pack generated",
    "step 2: action=advanced_and_generated, stage=analyze",
    "progress: advanced_and_generated",
    "step 3: action=needs_artifacts, stage=analyze",
    "invoking Analyst agent for: 10-pm-brief.json",
    "wrote artifact: 10-pm-brief.json",
    "recorded artifact: 10-pm-brief.json",
    "step 4: action=needs_artifacts, stage=plan",
    "invoking Architect agent for: 20-arch-design.json"
  ]
}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Exit code:** 0
**What happened:** Runner detected `intake`, generated task pack, advanced to `analyze`, invoked Analyst agent, wrote brief, advanced to `plan`, invoked Architect agent, wrote design, continued until `max_agent_calls` or next stop.

#### Session 2: needs_artifacts path

Run is at `implement`. Task file exists. Dev artifacts are missing.

```bash
$ ./tools/run-next-autonomous.sh runs/20260218_150000_TICKET-1
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  run-next-autonomous: runs/20260218_150000_TICKET-1
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{
  "ok": true,
  "action": "autonomous_complete",
  "final_action": "needs_artifacts",
  "steps_run": 2,
  "max_steps": 50,
  "agent_calls": 1,
  "max_agent_calls": 20,
  "artifacts_written": [
    "41-dev-notes.json"
  ],
  "artifacts_skipped": [],
  "trace": [
    "step 1: action=needs_artifacts, stage=implement",
    "invoking Dev agent for: 40-dev-patch.diff, 41-dev-notes.json",
    "wrote artifact: 40-dev-patch.diff",
    "recorded artifact: 40-dev-patch.diff",
    "wrote artifact: 41-dev-notes.json",
    "recorded artifact: 41-dev-notes.json",
    "step 2: action=advanced_and_generated, stage=validate",
    "progress: advanced_and_generated"
  ]
}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Exit code:** 0
**What happened:** Runner found `implement` with missing artifacts, invoked Dev agent, wrote both diff and notes, recorded them, gates passed, advanced to `validate`.

#### Session 3: blocked path

Run was blocked by a prior `block` command. User input is pending.

```bash
$ ./tools/run-next-autonomous.sh runs/20260218_150000_TICKET-1
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  run-next-autonomous: runs/20260218_150000_TICKET-1
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{
  "ok": true,
  "action": "autonomous_complete",
  "final_action": "blocked",
  "steps_run": 1,
  "max_steps": 50,
  "agent_calls": 0,
  "max_agent_calls": 20,
  "artifacts_written": [],
  "artifacts_skipped": [],
  "trace": [
    "step 1: action=blocked, stage=blocked",
    "blocked: Need API credentials"
  ]
}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Exit code:** 0
**What happened:** Runner detected blocked state in one step, reported the reason, stopped. No agents invoked, no artifacts touched.

**To resolve:**
```bash
# Check what inputs are pending
./tools/dp.sh status runs/20260218_150000_TICKET-1

# Answer the pending input
./tools/dp.sh respond runs/20260218_150000_TICKET-1 <input_id> "my-api-key"

# Resume
./tools/run-next-autonomous.sh runs/20260218_150000_TICKET-1
```
