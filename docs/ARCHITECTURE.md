# Architecture

## 1. Vision and Problem Statement

This system is a deterministic, role-based orchestration pipeline for multi-agent software work. It exists because:

- Work must not get lost to terminal scrollback, conversation compaction, or agent context limits.
- Every piece of state must live on the filesystem as a file, not in memory.
- The system must be reproducible: given the same filesystem state, every tool must produce the same output.
- Roles must have hard boundaries. A PM cannot write code. A QA agent cannot change scope.

The pipeline takes a ticket, creates a run, drives it through a fixed sequence of role stages, validates every artifact against a JSON schema, and advances only when gates pass.

## 2. System Boundaries and Invariants

**Workspace root:** Set via `WORKSPACE_ROOT` environment variable (defaults to `~/dev/agent-work/`). All paths are resolved against this root via `safePath()`. Any path that resolves outside the workspace is rejected.

**Invariants:**

- Zero external npm dependencies. Only `node:fs`, `node:path`, `node:os`, `node:crypto`.
- All tool stdout is JSON (except `ticket-show.sh` which prints raw markdown). Errors go to stderr as JSON with `{ "ok": false, "error": "..." }`.
- Read-only tools never create, modify, or delete files. The index, pick, dashboard, watch, and list tools are read-only.
- Write tools only write to specific locations: run folders, backlog items, task packs, tickets.
- No tool runs a child process except `autonomous-runner.js` (which invokes the Claude CLI as an agent adapter) and `dashboard.js` (HTTP server).
- All schemas use `additionalProperties: false` on output schemas.
- `tools/test-all.sh` is the single gate. If it passes, the system is correct.

## 3. Core Concepts and Definitions

### 3.1 Project

A workspace initialized with `.claw/`. Contains a `project.json` metadata file, an optional `agents.json` role definition file, a `backlog/` directory of task items, and a `task-packs/` directory of generated task packs. All state lives under `<target-repo>/.claw/`.

### 3.2 Backlog Item

A unit of work within a project. Lives at `.claw/backlog/<task_id>.json`. Has a status (`todo`, `in_progress`, `blocked`, `done`), a priority (`P0`-`P3`), an owner role, and an optional link to a run folder. Backlog items are the input to the picker and driver tools.

### 3.3 Task Pack

A structured context document generated for a backlog item before a run begins. Lives at `.claw/task-packs/<task_id>.json`. Contains inferred inputs, open questions, expected artifacts, acceptance criteria, constraints, and references. Generated deterministically from the filesystem without LLM calls.

### 3.4 Run

A single execution of the pipeline for one ticket. Lives at `.claw/runs/<YYYYMMDD_HHMMSS>_<ticket_id>/`. Contains `status.json` (the canonical state), `00-intake.json` (initial context), role-specific task files, and pipeline artifacts. A run moves through the state machine from `intake` to `done`.

### 3.5 Tool

A shell wrapper in `tools/` that calls a Node.js script. Every tool is a thin `exec node` wrapper. Tools are the public API surface of the system.

### 3.6 Schema

A JSON Schema file that defines the shape of a data file. Two categories:

- **Reference schemas** in `skills/dev-pipeline/references/`: define pipeline artifacts (pm-brief, arch-design, dev-notes, qa-report, review-report, status, run-manifest).
- **Output/input schemas** in `skills/dev-pipeline/schemas/`: define tool outputs and data model files (backlog-item, project, agents, task-pack, and all `*.output.schema.json` files for tool outputs).

## 4. Filesystem as API

The filesystem is the only API. There is no database, no message queue, no HTTP API (except the optional dashboard server). Every tool reads files, computes, and writes files.

### 4.1 `.claw/project.json`

Schema: `skills/dev-pipeline/schemas/project.schema.json`

Required fields: `project_id`, `title`, `description`, `created_at`, `updated_at`.

Optional: `repo_path` (string or null).

### 4.2 `.claw/agents.json`

Schema: `skills/dev-pipeline/schemas/agents.schema.json`

Required: `agents` array. Each agent object requires: `role_name`, `goal`, `allowed_actions`, `required_outputs`, `handoff_contract`.

Optional file. If absent, the task pack generator records an open question.

### 4.3 `.claw/backlog/<task_id>.json`

Schema: `skills/dev-pipeline/schemas/backlog-item.schema.json`

Required fields: `id`, `project_id`, `type`, `title`, `description`, `created_at`, `updated_at`, `status`, `priority`, `owner_role`, `depends_on`, `run_folder`, `tags`, `artifacts_expected`.

Optional fields: `parent_id` (string or null) — references a parent epic. When set, the parent must exist, must have type `epic`, and must not be self-referencing or circular. Validated by `validate-backlog-graph.js`.

Enum constraints:
- `type`: `epic`, `task`, `research`, `design`, `dev`, `qa`, `docs`
- `status`: `todo`, `in_progress`, `blocked`, `done`
- `priority`: `P0`, `P1`, `P2`, `P3`
- `owner_role`: `PM`, `UX_ANALYST`, `DESIGNER`, `ARCHITECT`, `DEV`, `QA`

The `run_folder` field is null until a run is created, then set to the relative path (e.g. `.claw/runs/20260219_120000_TASK-01`).

### 4.4 `.claw/task-packs/<task_id>.json`

Schema: `skills/dev-pipeline/schemas/task-pack.schema.json`

Required fields: `task_id`, `project_id`, `title`, `description`, `owner_role`, `inputs_present`, `open_questions`, `artifacts_expected`, `acceptance_criteria`, `constraints`, `suggested_next_agents`, `references`, `created_at`, `updated_at`.

`additionalProperties: false`. Generated by `scripts/task-pack-generate.js`.

### 4.5 `.claw/runs/<run_id>/` folder

Each run folder contains:

- `status.json` — canonical run state (schema: `skills/dev-pipeline/references/status.schema.json`).
- `00-intake.json` — initial ticket context.
- `run-manifest.json` — ticket_id, created_at, tool_version, schema_version, git_head.
- `30-dev-claude-task.txt` — generated task pack for the base stage.
- `3N-<stage>-task.txt` — role-specific task files (31 analyze, 32 plan, 33 implement, 34 validate, 35 review).
- Pipeline artifacts: `10-pm-brief.json`, `20-arch-design.json`, `40-dev-patch.diff`, `41-dev-notes.json`, `50-qa-report.json`, `60-review-report.json`.
- Optional: `.stop` file (stop signal), `autonomous-audit.jsonl` (audit log).

`status.json` required fields: `ticket_id`, `title`, `project`, `created_at`, `updated_at`, `current_stage`, `blocked`, `blocked_reason`, `responsible_agent`, `required_user_input`, `stage_history`, `next_actions`.

The `responsible_agent` field (string or null) identifies which agent identity is currently driving the run. Set via `--agent_id` on `create_run`, `advance`, `record_artifact`, and `orchestrate_one`. Defaults to `null` when no agent is specified.

Each `stage_history` entry includes an `agent_id` field (string or null) recording which agent drove that stage transition. This provides a per-stage audit trail of agent participation.

Optional fields written by the autonomous runner: `last_autonomous_run_at`, `last_autonomous_summary`.

### 4.6 `tickets/<ticket_id>.md`

Markdown file with YAML frontmatter.

Required frontmatter: `ticket_id`, `title`.

Required headings (case-insensitive): `Goal`, `Steps`.

The `ticket-store.js` module provides `ensureTicket()` and `guardTicketId()` to validate format and existence. `guardTicketId()` is the anti-truncation guard: it fails fast if a ticket is referenced but no file exists.

Ticket lifecycle: a ticket file is created first, then `create_run_from_ticket` reads it to create a run.

### 4.7 `.claw/capabilities.json`

Activates capabilities for a workspace. Read by the capability registry at pipeline load time.

```json
{ "capabilities": ["ux_audit", "security_audit"] }
```

Each capability name maps to a directory at `skills/capabilities/<name>/` containing a `capability.json` manifest, `templates/`, and `references/`. The registry validates each manifest against `capability-manifest.schema.json`, injects stages into the pipeline chain by relinking `next` pointers, and merges artifact schemas.

If this file is absent, the pipeline uses `DEFAULT_STAGES` only (full backward compatibility).

### 4.8 `.claw/missions/<id>.json`

Records goal-driven capability activation decisions. Created by `create-mission.js`.

Required fields: `id` (uuid), `goal` (string), `intents` (string array), `stack` (string), `capabilities` (string array), `created_at` (ISO 8601).

The mission layer uses deterministic keyword matching (no LLM) to parse intents from goal text and `detectStack()` to identify the workspace's technology stack from file existence checks. The resulting capability list is written to both the mission file and `.claw/capabilities.json`.

Mission files accumulate — each new mission creates a new file. `.claw/capabilities.json` is overwritten to reflect the latest mission's capabilities.

## 5. Determinism Model

### 5.1 What Must Be Deterministic

- **Picker output.** Given the same filesystem state, `project-next-pick` and `run-next-pick` must return the same result. Ordering is by bucket priority, then status rank, then priority rank, then project_id ASC, then task_id/run_folder ASC.
- **Index output.** Given the same filesystem, `project-index`, `run-index`, and `project-dashboard` must return the same `projects` and `runs` arrays in the same order.
- **Task pack generation.** Given the same filesystem, `task-pack-generate` must produce the same JSON content (excluding timestamps).
- **State machine transitions.** Given a run at stage X with artifacts Y, `run_next_safe` must return the same action.
- **Schema validation.** Given data D and schema S, `validateAgainstSchema(D, S)` must return the same result.

### 5.2 What May Vary

- `generated_at`, `created_at`, `updated_at` timestamps. These use `new Date().toISOString()` and reflect wall clock time.
- `run-manifest.json` `git_head` field. Reflects the current git HEAD at run creation time.
- Audit log timestamps and step ordering within a single autonomous invocation (depends on wall clock).
- Stalled detection. Uses `Date.now() - auditFile.mtimeMs > threshold`, so depends on wall clock.

### 5.3 Time Handling Rules

All timestamps are ISO 8601 strings via `new Date().toISOString()`. The `generated_at` field on index/dashboard outputs represents the moment the scan completed and is informational only. It must not be used for ordering or comparison. Stall detection uses a configurable `stallThresholdMs` (default: 30 minutes) against the audit file's modification time.

## 6. State Machine

### 6.1 Backlog Item Status Transitions

```
todo  -->  in_progress  -->  done
  |            |
  v            v
blocked    blocked
```

- `todo` to `in_progress`: when a run is created and linked.
- `in_progress` to `done`: when the linked run reaches stage `done`.
- Any to `blocked`: manual or when the run is blocked.

### 6.2 Run `current_stage` Transitions

```
intake --> task-pack-generated --> analyze --> plan --> implement --> validate --> review --> done
                                                                                         |
                                                                                      blocked
```

Each role stage requires specific artifacts to pass gates:

| Stage | Role | Required Artifacts |
|-------|------|--------------------|
| `analyze` | Analyst | `10-pm-brief.json` |
| `plan` | Architect | `20-arch-design.json` |
| `implement` | Dev | `40-dev-patch.diff`, `41-dev-notes.json` |
| `validate` | QA | `50-qa-report.json` |
| `review` | Review | `60-review-report.json` |

Advancement: `run_next_safe` checks if all required artifacts exist and validate against their schemas. If gates pass, it closes the current stage in `stage_history`, sets `current_stage` to the next stage, and generates the next role's task file.

### 6.3 Buckets and Selection Rules

The picker classifies each eligible item into a priority bucket. Bucket order (highest first):

1. `ready_for_run_creation` — task has a task pack but no active run yet, or run is in intake/task-pack-generated with a task pack present.
2. `needs_task_pack` — task has no task pack and no active run, or run is in intake/task-pack-generated without a task pack.
3. `needs_artifacts` — linked run's last autonomous action was `needs_artifacts`.
4. `other` — eligible but does not fit the above buckets.

Within a bucket, sort by: status rank (`in_progress` 0, `todo` 1), priority rank (`P0` 0, `P1` 1, `P2` 2, `P3` 3), project_id ASC, task_id ASC.

Items are ineligible if: status is `done` or `blocked`, or `stop_signal` is true, or the linked run's stage is `done`.

### 6.4 Blocking and Stop Signals

**Blocking:** `./tools/dp.sh block <run_folder> <reason> [prompts...]` sets `blocked: true`, `current_stage: "blocked"`, and creates `required_user_input` entries. `./tools/dp.sh respond <run_folder> <input_id> <answer>` resolves inputs. When all inputs are answered, the run unblocks and restores the previous stage.

**Stop signals:** A `.stop` file in the run folder. The autonomous runner checks for this file at each step boundary and exits with `final_action: "stopped"`. Remove with `./tools/run-next-resume.sh <run_folder>`.

## 7. Workflow

### 7.1 How Work Enters the System

1. A workspace is initialized with `./tools/init-workspace.sh --workspace /path/to/repo`.
2. A ticket file is created in `.claw/tickets/<ticket_id>.md` with the required frontmatter and headings.
3. Backlog items are created in `.claw/backlog/` referencing the ticket with status, priority, and owner role.

Alternatively, `./tools/dp.sh create_run_from_ticket <ticket_id>` creates a run directly from a ticket without a project/backlog structure. This is the simpler path for standalone tickets.

### 7.2 How Task Packs Are Generated and Validated

`./tools/task-pack-generate.sh <project_id> <task_id>` scans:
- `project.json` for project context
- `agents.json` for role definitions (if present)
- The backlog item for requirements and dependencies
- The linked run folder for existing artifacts (if present)
- `skills/dev-pipeline/SKILL.md` for pattern references

If information is missing, `open_questions` is populated. If dependencies are not done, a question is added. The generated file is written to `.claw/task-packs/<task_id>.json`.

Validation: `./tools/task-pack-validate.sh <path>` checks against `task-pack.schema.json`.

### 7.3 How Runs Are Created and Linked

When `project-next-drive` picks a task without a `run_folder`:

1. Creates `.claw/runs/<YYYYMMDD_HHMMSS>_<task_id>/` with `00-intake.json` and `status.json`.
2. Links the run back to the backlog item by setting `run_folder` and updating status to `in_progress`.
3. If a task pack exists at `.claw/task-packs/<task_id>.json`, copies it into the run as `10-pm-brief.json` (only if that file does not already exist).

### 7.4 How the Autonomous Runner Is Driven

`./tools/run-next-autonomous.sh <run_folder>` runs a loop:

1. Calls `run_next_safe` to get the current action.
2. If `needs_artifacts`: invokes the correct role agent (Claude CLI, scaffold adapter, or draft-file adapter) to produce `.draft` files, validates them, writes final artifacts.
3. If `advanced_and_generated`: continues to the next step.
4. Stops on: `none` (done), `blocked`, `needs_artifacts` after agent invocation, `stopped` (.stop file), stall detection, or max steps/agent calls reached.

Safety: never creates directories, never overwrites existing artifacts, snapshots `.claw/runs/` before/after and fails if changed.

### 7.5 How the Dashboard Is Used

`./tools/project-dashboard.sh` produces a JSON payload with all projects, their backlog items, and computed fields (priority bucket, run stage, blocked, stopped, stalled, needs_task_pack, needs_artifacts). This is read-only and suitable for consumption by a UI layer or automation.

`./tools/dashboard-start.sh` starts an HTTP dashboard on `localhost:18790` that auto-refreshes and shows runs with stage badges and expandable details.

## 8. Quality Gates

### 8.1 JSON-Only Outputs for Tools

Every tool writes JSON to stdout. The only exception is `ticket-show.sh` which prints raw markdown. Errors go to stderr as `{ "ok": false, "error": "..." }`.

### 8.2 Schema Validation with `additionalProperties: false`

All output schemas in `skills/dev-pipeline/schemas/` use `additionalProperties: false`. This means any extra field in a tool's output will cause schema validation to fail.

All artifact schemas in `skills/dev-pipeline/references/` define the shape of pipeline artifacts. Artifacts are validated before a stage can advance.

### 8.3 Tests Required for Each New Tool and Schema

Every new tool must have a corresponding test file in `skills/dev-pipeline/tests/`. Tests cover: programmatic API, CLI output, shell wrapper output, schema validation of output, error cases, read-only safety, and deterministic ordering.

### 8.4 `tools/test-all.sh` as the Final Gate

The `SUITES` array in `tools/test-all.sh` lists every test file. A ticket is not done until this script reports 0 failures. The script runs all suites sequentially and reports totals.

## 9. Failure Modes and Recovery

### 9.1 Corrupted JSON

Tools that read JSON files use `try/catch` around `JSON.parse`. Corrupted files are skipped by index and pick tools. A corrupted `status.json` causes `run_next_safe` to return `action: "error"`.

### 9.2 Missing Files

- Missing `status.json`: run is listed with `has_status: false`, not picked.
- Missing `project.json`: project directory is skipped.
- Missing backlog item: skipped by index.
- Missing ticket file: `guardTicketId()` fails with a clear error and suggested fix.

### 9.3 Stalled Runs

A run is considered stalled when `last_autonomous_summary.final_action === "needs_artifacts"` and the `autonomous-audit.jsonl` file has not been modified in over 30 minutes (configurable via `stallThresholdMs`). Stalled runs appear in the dashboard and index with `stalled: true`.

### 9.4 Partial Execution and Reruns

The autonomous runner is designed for safe reruns:
- Existing artifacts are never overwritten (skipped with a log entry).
- The runner picks up from the current state, not from the beginning.
- Audit logs are append-only and survive restarts.
- Stage history records start/finish times for each stage visit.

## 10. Roadmap and Extension Points

### 10.1 UI Layer Consumption of Dashboard

`project-dashboard.sh` produces stable JSON with computed fields. A web frontend or TUI can consume this output directly via polling or watch mode.

### 10.2 Capability System (Implemented)

The primary extension mechanism. New audit/analysis stages are added as capabilities without modifying the core engine.

**Adding a new capability:**
1. Create `skills/capabilities/<name>/capability.json` with manifest (name, version, stages, artifactSchemas).
2. Add template in `skills/capabilities/<name>/templates/`.
3. Add artifact schema in `skills/capabilities/<name>/references/`.
4. Activate in workspace via `.claw/capabilities.json`.

The engine ships with built-in capabilities: `ux_audit`, `security_audit`, `performance_audit`, and `research`. The audit capabilities inject after `analyze` and before `plan`. The `research` capability injects between `analyze` and `plan` for research-type workflows. New capabilities can be added by creating a directory under `skills/capabilities/` with a `capability.json` manifest.

**Adding goal-selector support:** Update `parseIntents()` in `goal-selector.js` with keyword patterns, and `selectCapabilities()` with the intent→capability mapping.

### 10.3 More Roles and Agent Ownership

`agents.json` defines roles per project. New roles can be added via capabilities (preferred) or by extending `DEFAULT_STAGES` in `dev-pipeline.js`.

### 10.4 More Artifact Types and Buckets

The bucket classification in `project-next-pick.js` and the stage config in `dev-pipeline.js` are the extension points. New buckets can be added to `BUCKET_PRIORITY`. New artifact types require a new schema and a stage config entry. Capability-provided artifacts are registered via the `artifactSchemas` field in the capability manifest.

# Evolution Roadmap — AI Organisation OS

This section defines the multi-phase evolution plan for the system. It is the authoritative reference for all future tickets. No ticket may introduce scope that falls outside the currently active phase.

## Current System State

The system currently provides:

- A deterministic run engine that moves tickets through a fixed sequence of role stages (`intake` through `done`).
- A multi-stage pipeline with five role stages (Analyst, Architect, Dev, QA, Review), each gated by schema-validated artifacts.
- A pluggable capability system (`capability-registry.js`) that injects additional stages (UX audit, security audit, performance audit) into the pipeline via manifest-driven configuration. No core engine changes required to add new capabilities.
- A goal-driven mission layer (`goal-selector.js`, `create-mission.js`) that translates natural-language goals into deterministic capability activation using keyword matching and stack detection.
- An external workspace model where all state lives in `<target-repo>/.claw/` (project.json, agents.json, capabilities.json, missions/, backlog/, runs/, tickets/, etc.).
- A deterministic project scheduler (`project-next-pick`) that classifies tasks into priority buckets and selects the next eligible task using stable sort rules.
- A one-shot project driver (`project-next-drive`) that creates runs, links backlog items, and invokes the autonomous runner.
- JSON schema enforcement on all tool outputs (`additionalProperties: false`) and all pipeline artifacts.
- A project dashboard (`project-dashboard.sh`) that produces a read-only JSON payload with computed fields for each backlog item.
- A deterministic task pack generator (`task-pack-generate.sh`) that produces structured context documents without LLM calls.
- Ticket persistence (`.claw/tickets/<ticket_id>.md`) with anti-truncation guards.
- An append-only audit log (`autonomous-audit.jsonl`) per run.
- Read-only safety guarantees on all index, pick, dashboard, watch, and list tools.
- A web dashboard (`dashboard.js`) on `localhost:18790` for run-level monitoring.
- Comprehensive test coverage (`bash tools/test-all.sh`) with zero external npm dependencies.

## Target State

The system evolves into a deterministic, role-aware, knowledge-compounding AI Organisation OS. The target state includes:

- Enforced agent identities with persistent state, workload tracking, and runtime role-to-stage enforcement.
- A structured work graph that replaces the flat backlog with validated epic-child hierarchies, dependency graphs with cycle detection, and graph-aware scheduling.
- A knowledge and artifact layer that classifies artifacts semantically, indexes them across projects and runs, supports research-type workflows with structured outputs, and accumulates agent memory across runs.

The evolution is divided into three phases. Each phase has explicit deliverables and stop conditions. Phases execute sequentially.

## Phase 1 — Agent Identity and Control Layer

### Purpose

Make roles enforceable at runtime. Currently, `agents.json` defines roles declaratively but nothing prevents a role from executing a stage it does not own.

### Deliverables

- `agents/<agent_id>/state.json` contract defining persistent agent state (assigned role, current task, workload counters, last active timestamp).
- Role-to-stage enforcement rules in the run engine. A role must match the stage's declared role in `STAGE_CONFIG` before it can produce artifacts for that stage.
- `responsible_agent` field recorded in `status.json` for each run, identifying which agent identity is driving the current stage.
- Agent workload visible in the project dashboard output (runs per agent, stages completed per agent).
- `assigned_role` required on every backlog item. The picker must reject items without an assigned role.

### Stop Condition

All of the following must be true before Phase 1 is complete:

1. **A role cannot execute a stage it does not own.** The run engine rejects artifact submissions from the wrong role. Implemented in `checkRoleForStage()` (`dev-pipeline.js`). Tested by `test-role-enforcement.js` (21 tests) and `test-role-leakage.js` (15 tests).
2. **The project dashboard output includes workload counts per role.** `workload_by_agent` per project and `workload_summary` in top-level summary. Implemented in `project-dashboard.js`. Tested by `test-dashboard-workload.js` (13 tests). Schema enforced by `project-dashboard.output.schema.json`.
3. **Every run's `status.json` contains a `responsible_agent` field.** Top-level field set via `--agent_id`, `null` by default. `normalizeStatus()` adds it to old files. Tested by `test-responsible-agent.js` (13 tests). Schema enforced by `status.schema.json`.
4. **Every backlog item has an `assigned_role` field. The picker skips items without one.** `owner_role` check is the first filter in `classifyTask()` (`project-next-pick.js`). Warnings emitted to stderr. Tested by `test-picker-owner-role.js` (8 tests).
5. **No cross-role leakage is possible.** End-to-end scenario tests prove DEV/QA/PM agents cannot produce artifacts for wrong stages, agents with empty/null roles are rejected, and `responsible_agent` is always populated after transitions. Tested by `test-role-leakage.js` (15 tests).

Phase 1 does not modify the dependency graph, backlog hierarchy, or artifact classification. No dependency graph changes in Phase 1.

## Phase 2 — Structured Work Graph

### Purpose

Upgrade the backlog from a flat list to a validated project graph with parent-child relationships and dependency constraints.

### Deliverables

- Epic-to-child hierarchy via a `parent_id` field on backlog items. Epics contain children. Children reference their parent.
- Dependency graph validation tool that reads backlog items and validates the `depends_on` graph is a DAG.
- Cycle detection. The validator rejects any backlog state that contains a dependency cycle.
- Blocked reason enforcement. A task with unfinished dependencies must have `blocked_reason` set to identify the blocking dependency.
- Picker respects graph constraints. A task is ineligible if any of its `depends_on` items are not `done`. A child is ineligible if its parent epic is `blocked`.
- Dashboard visualizes the dependency chain. The project dashboard output includes parent-child relationships and dependency status for each item.
- Epic completion rule. An epic cannot transition to `done` if any of its children are not `done`.

### Stop Condition

All of the following must be true before Phase 2 is complete:

1. **Dependency cycles are detected and rejected by the validation tool.** Implemented in `validate-backlog-graph.js` via Kahn's algorithm (topological sort). Tested by `test-validate-backlog-graph.js` (16 tests). Schema enforced by `validate-backlog-graph.output.schema.json`.
2. **A child task cannot start execution if its parent epic is `blocked`.** Implemented in `classifyTask()` (`project-next-pick.js`): checks `parent_id` against siblings, skips if parent is blocked. Warning emitted: `skipped_parent_blocked`. Tested by `test-picker-graph.js` (17 tests).
3. **An epic cannot complete if any of its children are incomplete.** Implemented in `validateBacklogGraph()`: `epic_completion_errors` array reports done epics with non-done children. Standalone `checkEpicCompletion()` function exported. Tested by `test-epic-completion.js` (13 tests).
4. **The picker never selects a task whose dependencies are not satisfied.** Implemented in `classifyTask()` (`project-next-pick.js`): checks `depends_on` against siblings, skips if any dep is not done. Warning: `skipped_unsatisfied_deps` with `blocking_deps` array. Tested by `test-picker-graph.js` and `test-blocked-reason.js` (8 tests).
5. **The project dashboard output includes the dependency chain for each item.** Implemented in `project-dashboard.js` `enrichDependencyChain()`: adds `children`, `depends_on_status`, `blocked_by_deps`, `is_blocked_by_parent`. Schema enforced by `project-dashboard.output.schema.json`. Tested by `test-dashboard-deps.js` (12 tests).

Phase 2 does not introduce artifact semantic classification, artifact indexing, or cross-run knowledge retention. No artifact semantic layer in Phase 2.

## Phase 3 — Knowledge and Artifact Layer

### Purpose

Turn the execution engine into a knowledge-compounding system where artifacts, research outputs, and agent observations persist and accumulate across runs and projects.

### Deliverables

- Artifact classification schema that tags each artifact with a semantic type (decision, design, implementation, test-result, research-finding, observation).
- Global artifact index tool that scans all runs across all projects and produces a searchable index of artifacts by type, project, run, and stage.
- Research backlog type with a dedicated workflow. Research tasks produce structured findings instead of pipeline artifacts. The research output schema defines required fields for hypotheses, methods, findings, and confidence levels.
- Agent memory persistence layer. Each agent identity can write observations to `agents/<agent_id>/memory/` and read them in subsequent runs. Memory is append-only and schema-validated.
- Cross-run knowledge retention. The task pack generator can reference artifacts and findings from previous runs in the same project when building context for a new task.

### Stop Condition

All of the following must be true before Phase 3 is complete:

1. The artifact index tool produces valid JSON output covering all artifacts across all projects and runs.
2. Research tasks have a dedicated workflow with a validated output schema.
3. Agent memory persists across runs. An agent can write an observation in run N and read it in run N+1.
4. The project dashboard output includes knowledge state (artifact counts by type, research findings count, memory entry count).

## Phase 4 — Self-Improving AI Organization

### Purpose

Make the system learn from its own execution history, identify inefficiencies, fill gaps autonomously, and recommend optimal agent allocation.

### Deliverables

- **Run Analytics Engine** (`run-analytics.js`): Read-only analytics that scans completed runs for a project and computes per-run metrics (stage durations, QA/review outcomes, artifact counts, autonomous steps) plus project-level aggregates (pass rates, avg durations, severity distributions).
- **Self-Evaluation** (`self-evaluate.js`): Compares a run's QA/review outcomes against project baselines. Produces a quality score (0.0–1.0), deviation list, and actionable suggestions. Writes evaluation to agent memory via `selfEvaluateAndRecord()`.
- **Workflow Suggestions** (`workflow-suggest.js`): Detects workflow inefficiencies from run analytics: recurring QA failures, bottleneck stages, high rejection rates, and declining quality trends. Each suggestion includes evidence and confidence level.
- **Gap Scanner** (`gap-scanner.js`): Identifies unresolved issues from completed runs (unaddressed QA issues, review changes, open research questions, unresolved task pack questions). Auto-create mode calls `createTicketAndBacklog()` per gap (idempotent).
- **Agent Performance** (`agent-performance.js`): Computes per-agent performance scores (`0.4 * qa_pass_rate + 0.3 * review_approval_rate + 0.3 * speed_factor`). Recommends optimal agent for a given role. Integrated into `project-next-pick.js` as `recommended_agent` field.
- **Dashboard Integration**: `project-dashboard.js` summary includes `performance_summary`, `workflow_suggestions_count`, and `pending_gaps_count`.

### Stop Condition

1. **SC-1**: A completed run produces a structured self-evaluation comparing QA/review outcomes against project historical baselines. Assessment is written to agent memory. Implemented in `self-evaluate.js`. Tested by `test-self-evaluate.js` (12 tests).
2. **SC-2**: The workflow suggestion tool produces actionable suggestions with evidence when given a project with varying stage durations and QA failure rates. Implemented in `workflow-suggest.js`. Tested by `test-workflow-suggest.js` (11 tests).
3. **SC-3**: The gap scanner identifies unresolved issues from completed runs and can auto-create backlog items via `createTicketAndBacklog`. Implemented in `gap-scanner.js`. Tested by `test-gap-scanner.js` (12 tests).
4. **SC-4**: Agent performance profiles are computed from stage_history and QA/review data. The picker output includes a `recommended_agent` field. Implemented in `agent-performance.js` + `project-next-pick.js`. Tested by `test-agent-performance.js` (13 tests).

## Phase 5 — Closed-Loop Adaptive Execution

### Purpose

Close the observation-to-action loops opened in Phase 4. Where Phase 4 built measurement infrastructure, Phase 5 makes the system act on what it observes: auto-triggering evaluations, injecting insights into agent prompts, actuating agent assignment recommendations, and replacing the static bash loop with an adaptive JS loop.

### Deliverables

- **Post-Run Lifecycle Hooks** (`post-run-hooks.js`): After `runAutonomous()` completes inside `projectDriveOnce()`, automatically runs self-evaluation and gap scanning. Both hooks are non-fatal. Only fires for terminal run stages.
- **Adaptive Agent Prompt** (`prompt-context.js`): Assembles agent memory entries (evaluations, lessons, warnings) and workflow suggestions into a structured text block injected into the Claude Code prompt. Agents now learn from prior run insights.
- **Agent Assignment Actuation**: `recommended_agent` from the picker flows through drive → runner → prompt. Agent-specific memory is retrieved via `buildPromptContext()`. Agent identity is included in the prompt.
- **Adaptive Drive Loop** (`project-drive-loop.js`): JS replacement for the bash drive loop. Adaptive sleep (1s after work, exponential backoff to 30s on idle, 60s on errors). Post-run hooks. Project filtering via `--project <id>`. Stop conditions: .stop file, max iterations, max consecutive idle, SIGTERM/SIGINT.
- **Dashboard Phase 5 Fields**: `last_self_evaluation` (quality score from most recent evaluation), `post_run_hooks_enabled`, `adaptive_loop_status`.

### Stop Condition

1. **SC-1**: After a run completes, self-evaluation and gap scanning are automatically triggered. The evaluation is written to agent memory and gaps are auto-created as backlog items. Implemented in `post-run-hooks.js` + `project-next-drive.js`. Tested by `test-post-run-hooks.js` (12 tests).
2. **SC-2**: The autonomous runner's prompt includes relevant agent memory (prior evaluations, lessons) and workflow suggestions for the current project. Implemented in `prompt-context.js` + `autonomous-runner.js`. Tested by `test-prompt-context.js` (11 tests).
3. **SC-3**: `recommended_agent` from the picker is passed through to the autonomous runner and used to select the agent adapter. Implemented in `project-next-drive.js` + `autonomous-runner.js`. Tested by `test-agent-actuation.js` (6 tests).
4. **SC-4**: The drive loop is a JS module with adaptive sleep, post-run hooks, and project filtering. Implemented in `project-drive-loop.js`. Tested by `test-drive-loop-js.js` (12 tests).

### Closed-Loop Diagram

```
  project-drive-loop.js (adaptive sleep, hooks)
    │
    ├─→ project-next-pick.js (projectId filter)
    │     └─→ recommended_agent from agent-performance.js
    │
    ├─→ project-next-drive.js
    │     ├─→ runAutonomous(agentId from recommended_agent)
    │     │     └─→ claudeCodeAdapter + buildPromptContext(memory + suggestions)
    │     └─→ runPostRunHooks (self-eval + gap scan)
    │           ├─→ selfEvaluateAndRecord → agent memory
    │           └─→ scanGaps(autoCreate) → backlog items
    │
    └─→ adaptive sleep: 1s after work, backoff on idle, 60s on error
```

## Phase 6 — Template-Enriched Agent Execution

### Purpose

Close the gap between the rich stage-specific templates already generated by the pipeline and the minimal prompts actually given to agents. Phase 5 agents received thin instructions ("produce artifact X with these fields"). Phase 6 agents receive the full GOAL/STEPS/OUTPUT instructions from rendered templates, prior artifact content, and validation retry feedback.

### Deliverables

- **Template-Enriched Adapter Prompt** (`adapter-prompt-builder.js`): `buildAdapterPrompt()` reads the stage task file from the run folder and uses its content as primary instructions. Falls back to minimal prompt if task file is missing. Includes agent identity, Phase 5 adaptive context, and schema requirements as supplements.
- **Prior Artifact Context Injection**: `buildArtifactContext()` reads prior artifacts (JSON and diff) listed in `STAGE_ARTIFACT_DEPS` and injects their content into the prompt. Per-artifact truncation (4000 chars) and total budget (8000 chars) prevent prompt bloat.
- **Validation Retry Loop**: When `validateDraft()` returns errors, `buildRetryPrompt()` constructs error feedback and the adapter retries up to `maxRetries` times (default 2). Retries are tracked in the audit trail and `retries_attempted` in the result.
- **Post-Implement Patch Application**: After the implement stage writes `40-dev-patch.diff`, `applyDevPatch()` is invoked (dry-run first, then real). Failure is non-fatal. Status recorded in `patch_application` result field.
- **Dashboard Phase 6 Fields**: `template_enrichment_enabled`, `artifact_context_enabled`, `retry_loop_enabled`, `auto_patch_enabled` — all boolean feature flags computed from module availability.

### Stop Condition

1. **SC-1**: `claudeCodeAdapter` reads the stage task file from the run folder and includes its full content in the prompt. Template-based instructions replace the minimal prompt. Phase 5 adaptive context preserved. Implemented in `adapter-prompt-builder.js` + `autonomous-runner.js`. Tested by `test-adapter-prompt-builder.js` (22 tests).
2. **SC-2**: Prior artifact content (JSON and diff) is injected into the prompt for each stage. `buildArtifactContext()` reads artifacts listed in `STAGE_ARTIFACT_DEPS`, truncates to budget. Tested by `test-adapter-prompt-builder.js`.
3. **SC-3**: When `validateDraft()` returns errors, the adapter retries up to `maxRetries` times with error feedback. Retries tracked in audit trail. Tested by `test-validation-retry.js` (7 tests).
4. **SC-4**: After implement stage writes `40-dev-patch.diff`, `applyDevPatch` is invoked (dry-run first, then real). Failure is non-fatal. Status recorded in result. Tested by `test-auto-patch.js` (7 tests).

### Closed-Loop Diagram (Phase 6 Enhancement)

```
  project-drive-loop.js (adaptive sleep, hooks)
    │
    ├─→ project-next-pick.js (projectId filter)
    │     └─→ recommended_agent from agent-performance.js
    │
    ├─→ project-next-drive.js
    │     ├─→ runAutonomous(agentId from recommended_agent)
    │     │     └─→ claudeCodeAdapter
    │     │           ├─→ buildAdapterPrompt()  ← Phase 6: reads task file
    │     │           │     ├─→ Stage Instructions (31-analyze-task.txt etc.)
    │     │           │     ├─→ buildArtifactContext() (prior artifacts)
    │     │           │     ├─→ buildPromptContext() (memory + suggestions)
    │     │           │     └─→ Schema requirements
    │     │           └─→ Retry loop (buildRetryPrompt on validation failure)
    │     │
    │     ├─→ Post-implement: applyDevPatch(dry-run → apply)
    │     └─→ runPostRunHooks (self-eval + gap scan)
    │
    └─→ adaptive sleep: 1s after work, backoff on idle, 60s on error
```

## Phase 7 — Last-Mile Delivery

### Purpose

Close the loop from "patch applied" to "backlog item done." Phase 6 stopped at applying a patch to the working tree. Phase 7 validates patches against tests, optionally commits, auto-completes backlog items, and wires agent recommendation as a fallback for the picker.

### Deliverables

- **`artifactList` Scope Fix**: Hoisted `artifactList` in `claudeCodeAdapter` from inside the `catch` block to function scope. The enriched prompt path (when `buildAdapterPrompt` succeeds) previously left `artifactList` undefined for the post-invocation draft-checking loop. Regression tested in `test-claude-adapter.js`.
- **Post-Patch Test Execution** (`post-patch-verify.js`): `discoverTestCommand()` discovers the project's test infrastructure (package.json, Makefile, test-all.sh, Cargo.toml). `runPostPatchTests()` runs the discovered command, captures exit code, stdout/stderr tail, and duration. Results recorded in `test_execution` field. Non-fatal.
- **Auto-Commit** (`auto-commit.js`): `autoCommit()` creates a structured git commit after successful patch + tests. Opt-in via `autoCommit: true`. Never pushes. Pre-conditions: patch applied, tests not failed. SHA and message recorded in `auto_commit` field.
- **Backlog Auto-Completion**: When `final_action === 'none'` (run reached `done`), `project-next-drive.js` auto-transitions the linked backlog item to `done` via `updateBacklogStatus`. Epic completion guard respected.
- **`recommendAgent` Fallback**: When the picker has no `recommended_agent`, `recommendAgent()` from `agent-performance.js` is called as a fallback for agent selection based on stage role.
- **Claude Adapter Test Coverage** (`test-claude-adapter.js`): Mock-based tests for `claudeCodeAdapter` covering availability check, prompt paths, CLI invocation, draft checking, and scaffold fallback.
- **Dashboard Phase 7 Fields**: `post_patch_tests_enabled`, `auto_commit_enabled`, `backlog_auto_completion_enabled`, `agent_recommendation_enabled` — boolean feature flags computed from module availability.

### Stop Conditions

1. **SC-1**: `artifactList` scope bug fixed. Variable hoisted to function scope, accessible in both enriched-prompt path and draft-checking loop. Regression tested.
2. **SC-2**: After successful `git apply`, a configurable test command is discovered and executed. Results recorded in `test_execution`.
3. **SC-3**: When `autoCommit: true`, patch applied, and tests pass (or no tests found), a structured git commit is created. SHA and message recorded in `auto_commit`. Default: off.
4. **SC-4**: When a run reaches `done`, the linked backlog item is auto-transitioned to `done` via `updateBacklogStatus`. Epic completion guard respected.
5. **SC-5**: When the picker has no `recommended_agent`, `recommendAgent()` is called as a fallback.
6. **SC-6**: `claudeCodeAdapter` has mock-based test coverage for all paths.

### Closed-Loop Diagram (Phase 7 Enhancement)

```
  project-drive-loop.js (adaptive sleep, hooks)
    │
    ├─→ project-next-pick.js (projectId filter)
    │     └─→ recommended_agent from agent-performance.js
    │           └─→ Phase 7: recommendAgent fallback if picker has none
    │
    ├─→ project-next-drive.js
    │     ├─→ runAutonomous(agentId, autoCommit)
    │     │     └─→ claudeCodeAdapter
    │     │           ├─→ buildAdapterPrompt()  ← Phase 6: reads task file
    │     │           │     ├─→ Stage Instructions (31-analyze-task.txt etc.)
    │     │           │     ├─→ buildArtifactContext() (prior artifacts)
    │     │           │     ├─→ buildPromptContext() (memory + suggestions)
    │     │           │     └─→ Schema requirements
    │     │           └─→ Retry loop (buildRetryPrompt on validation failure)
    │     │
    │     ├─→ Post-implement: applyDevPatch(dry-run → apply)
    │     ├─→ Phase 7: runPostPatchTests()  ← discover + run tests
    │     ├─→ Phase 7: autoCommit()  ← opt-in structured commit
    │     ├─→ runPostRunHooks (self-eval + gap scan)
    │     └─→ Phase 7: backlog auto-completion  ← done → updateBacklogStatus
    │
    └─→ adaptive sleep: 1s after work, backoff on idle, 60s on error
```

## Evolution Governance Rules

1. Only one phase may be active at a time. Work on Phase N+1 must not begin until Phase N meets all its stop conditions.
2. A phase is complete when every stop condition listed in its section evaluates to true. Partial completion does not count.
3. Every ticket must explicitly reference the phase it belongs to (e.g. "Phase 1" in the ticket title or body). Tickets that do not reference a phase are out of scope.
4. No features outside the declared phase scope. If a ticket introduces functionality that belongs to a later phase, it must be rejected and rewritten.
5. This section of `docs/ARCHITECTURE.md` is the single source of truth for phase scope and stop conditions. Conflicts between tickets and this document are resolved in favor of this document.

## Evolution Roadmap Version

Version: 1.1
Date: 2026-02-22
