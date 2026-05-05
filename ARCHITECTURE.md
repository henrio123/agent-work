# Architecture overview

Concise overview of the dev-pipeline orchestrator. For the full design — including
filesystem contracts, the determinism model, failure modes, and the phase roadmap —
see [`docs/ARCHITECTURE_DETAILED.md`](./docs/ARCHITECTURE_DETAILED.md).

## What it is

A deterministic, role-based orchestration pipeline for multi-agent software work.
Tickets enter the system. A scheduler picks the next eligible task. A fixed sequence
of role stages executes the work, each producing schema-validated artifacts. Gates
prevent advancement until quality checks pass. Every piece of state lives on the
filesystem.

## The pipeline

```
intake → task-pack-generated → analyze → plan → implement → validate → review → done
```

| Stage     | Owner role | Required artifact(s)                       | Schema                       |
|-----------|------------|--------------------------------------------|------------------------------|
| analyze   | Analyst    | `10-pm-brief.json`                         | `pm-brief.schema.json`       |
| plan      | Architect  | `20-arch-design.json`                      | `arch-design.schema.json`    |
| implement | Dev        | `40-dev-patch.diff`, `41-dev-notes.json`   | `dev-notes.schema.json`      |
| validate  | QA         | `50-qa-report.json`                        | `qa-report.schema.json`      |
| review    | Review     | `60-review-report.json`                    | `review-report.schema.json`  |

A stage advances only when all required artifacts exist and pass schema validation.
Roles are enforced at runtime: a Dev agent cannot produce an Analyst brief.

## Core building blocks

- **Project** — workspace initialized with `.claw/` containing `project.json`,
  optional `agents.json`, a backlog, and generated task packs.
- **Backlog item** — `.claw/backlog/<id>.json`. Status, priority, owner role,
  dependencies, optional parent epic.
- **Task pack** — deterministic context document built from the filesystem before a
  run begins. No LLM calls during generation.
- **Run** — single pipeline execution at `.claw/runs/<timestamp>_<ticket>/`. Owns
  `status.json` (the canonical state) and per-stage artifacts.
- **Picker** — deterministic scheduler. Stable sort: priority bucket > status >
  priority > id. Skips items with unsatisfied dependencies.
- **Driver** — one-shot executor that creates a run for the picked task, invokes
  the autonomous runner, and writes results.

## Invariants

- Filesystem is the only API. No database, no message queue. Every tool reads
  files, computes, writes files.
- Zero external npm dependencies. Only Node built-ins (`node:fs`, `node:path`,
  `node:os`, `node:crypto`).
- All schemas use `additionalProperties: false` on outputs.
- Read-only tools never create or modify files. Write tools only write to specific,
  declared locations.
- `WORKSPACE_ROOT` resolves all paths via `safePath()`; anything that escapes the
  workspace is rejected.
- `bash tools/test-all.sh` is the single gate. If it passes, the system is correct.

## Schema-validated artifacts and retry-with-feedback

Every stage emits JSON conforming to a schema with `additionalProperties: false`.
Validation happens at write-time. On failure, the runner re-invokes the same agent
with the validation error attached as feedback. Retry counts are bounded.

## Cross-run agent memory

Agents maintain append-only memory at `.claw/agents/<id>/memory/`. The task-pack
generator references artifacts from prior runs when building context, so
lessons learned propagate forward without unbounded prompt growth.

## Run grading and audit

Run analytics produce per-run scores from QA, review, and duration signals,
deviating against project baselines. An optional append-only JSONL audit log
(`autonomous-audit.jsonl`, enabled with `--audit_log` or `DP_AUDIT_LOG=1`) captures
every stage transition with timestamps.

## Workspace agent contracts

The repo also contains a separate, smaller layer at the workspace root —
`AGENTS.md`, `BOOTSTRAP.md`, `HEARTBEAT.md`, `IDENTITY.md`, `SOUL.md`, `USER.md`,
`TOOLS.md`. These are operating instructions for an agent (e.g. Claude Code) that
*visits* this workspace as a personal assistant. They are independent of the
dev-pipeline orchestrator described above; the orchestrator's roles are defined
by `agents.json`, JSON schemas, and the scripts under `tools/` and
`skills/dev-pipeline/`.

## What this is not

- Not a vector-database or semantic RAG system. Context retrieval is filename-
  and graph-based, not embedding-based.
- Not LangChain, LangGraph, or MCP. The orchestrator drives an agent adapter
  (Claude CLI) directly via subprocess.
- Not LLM-decided tool dispatch. The orchestrator deterministically picks the next
  stage; the LLM authors artifacts but does not pick tools.
- Not a hosted service. Local execution against a workspace on disk.

For full design rationale, the state machine, failure modes, and phase roadmap,
see [`docs/ARCHITECTURE_DETAILED.md`](./docs/ARCHITECTURE_DETAILED.md).
