# AI Organisation OS

A deterministic, role-based orchestration system that turns unstructured AI work into reproducible, auditable, multi-agent pipelines. Every piece of state lives on the filesystem. Every output is schema-validated. Every decision is traceable.

---

## What It Does

**Problem.** AI agents lose work. Conversations get compacted. Context windows overflow. Terminal scrollback disappears. There is no persistent record of what was decided, who did it, or why.

**Solution.** This system replaces ad-hoc AI usage with a structured execution pipeline. Tickets enter the system. A deterministic scheduler picks the next task. A fixed sequence of role stages (PM, Architect, Dev, QA, Review) executes the work. Each stage produces schema-validated artifacts. Gates prevent advancement until quality checks pass. Everything is written to disk.

**Typical outcomes:**
- Every ticket has a complete audit trail from intake through review.
- Role boundaries are enforced: a QA agent cannot write code, a PM cannot modify architecture.
- Schema validation catches structural errors before they propagate.
- Work survives agent restarts, context compaction, and session loss.
- The entire system runs on Node.js built-ins with zero npm dependencies.

**Who it is for.** Teams and individuals building multi-agent AI systems who need determinism, auditability, and reproducibility. Useful for anyone who has lost work to a crashed agent session or an overflowed context window.

---

## How It Works

### Key Concepts

| Concept | Description |
|---------|-------------|
| **Project** | A workspace initialized with `.claw/` containing metadata, agent roles, and a backlog of tasks. |
| **Backlog Item** | A unit of work (`.claw/backlog/<id>.json`) with status, priority, owner role, dependencies, and an optional parent epic. |
| **Run** | A single pipeline execution (`.claw/runs/<timestamp>_<ticket>/`) with a state machine from `intake` to `done`. |
| **Stage** | A step in the pipeline owned by one role. Each stage requires specific artifacts validated against JSON schemas. |
| **Picker** | A deterministic scheduler that selects the next eligible task using stable sort rules (priority bucket > status > priority > ID). |
| **Driver** | A one-shot executor that creates a run for the picked task, invokes the autonomous runner, and writes results. |

### Pipeline Flow

```
Ticket  -->  Backlog Item  -->  Task Pack  -->  Run Creation  -->  Pipeline Stages  -->  Done
                                                                     |
                                                    intake -> task-pack-generated
                                                    analyze -> plan
                                                    implement -> validate
                                                    review -> done
```

### Role Stages

| Stage | Role | Required Artifact | Schema |
|-------|------|-------------------|--------|
| analyze | Analyst | `10-pm-brief.json` | `pm-brief.schema.json` |
| plan | Architect | `20-arch-design.json` | `arch-design.schema.json` |
| implement | Dev | `40-dev-patch.diff`, `41-dev-notes.json` | `dev-notes.schema.json` |
| validate | QA | `50-qa-report.json` | `qa-report.schema.json` |
| review | Review | `60-review-report.json` | `review-report.schema.json` |

A stage advances only when all required artifacts exist and pass schema validation. Roles are enforced at runtime: a Dev agent cannot produce a PM brief.

---

## Maturity Model and Roadmap

### Where We Are

| Level | Name | Status |
|-------|------|--------|
| **Level 1** | Manual AI usage | Past |
| **Level 2** | Structured multi-agent execution | Done |
| **Level 3** | Autonomous org with memory | Done |
| **Level 4** | Self-improving AI organization | **Current** |

### Level 2 (Current) — What's Done

The system provides deterministic multi-agent pipeline execution with full schema enforcement, role boundaries, and a structured work graph.

**Phase 1 (Agent Identity & Control) — Complete.**
- Persistent agent state (`.claw/agents/<id>/state.json`) with role, workload counters, and last-active tracking.
- Runtime role-to-stage enforcement. A role must match the stage before it can produce artifacts.
- `responsible_agent` tracked per run and per stage transition.
- Agent workload visible in the project dashboard.
- Picker rejects backlog items without an assigned `owner_role`.
- Cross-role leakage prevention tested end-to-end.

**Phase 2 (Structured Work Graph) — Complete.**
- Epic-to-child hierarchy via `parent_id` on backlog items.
- DAG validation with cycle detection (Kahn's algorithm).
- Graph-aware picker: skips tasks with unsatisfied dependencies and children of blocked epics.
- Epic completion rule: epics cannot be marked done while children are incomplete.
- Write-time epic completion guard (`backlog-update-status.js`).
- Preflight graph validation in the project driver.
- Dashboard dependency chain visualization.

**Hardening & Ops — Complete.**
- `additionalProperties: false` enforced on all 20+ schemas (output, input, reference).
- GitHub Actions CI gate running 980+ tests on every push and PR.
- Preflight graph validation before creating or driving runs.
- Cron-friendly drive loop wrapper with safe stop.

### Level 3 — What's Done

**Phase 3 (Knowledge & Artifact Layer) — Complete.**

| Milestone | Description | Status |
|-----------|-------------|--------|
| Artifact classification | Tag each artifact with a semantic type (decision, design, implementation, test-result, research-finding) | DONE |
| Global artifact index | Searchable index of all artifacts across projects and runs | DONE |
| Research workflow | Dedicated workflow for research tasks with structured findings schema | DONE |
| Agent memory | Append-only memory layer at `.claw/agents/<id>/memory/`, schema-validated | DONE |
| Cross-run knowledge | Task pack generator references artifacts from prior runs when building context | DONE |

### Level 4 — What's Done

**Phase 4 (Self-Improving AI Organization) — Complete.**

| Milestone | Description | Status |
|-----------|-------------|--------|
| Run analytics engine | Per-run metrics and project-level aggregates from completed runs | DONE |
| Self-evaluation loops | Agents assess the quality of their own outputs against historical baselines | DONE |
| Workflow optimization | System proposes pipeline improvements based on execution patterns | DONE |
| Autonomous ticket creation | System identifies gaps and creates tickets without human intervention | DONE |
| Adaptive role allocation | Agent assignment optimized based on workload and historical performance | DONE |

---

## Features

### Implemented

- Deterministic pipeline with 8-stage state machine (intake through done)
- 5 role stages (PM, Architect, Dev, QA, Review) with enforced boundaries
- Schema-validated artifacts with `additionalProperties: false` on all schemas
- Deterministic project scheduler with priority buckets and stable sort
- One-shot and loop project drivers with preflight graph validation
- Epic-child hierarchy with DAG validation and cycle detection
- Write-time epic completion guard
- Task pack generation (deterministic, no LLM calls)
- Autonomous multi-agent runner with scaffold, Claude CLI, and draft-file adapters
- Append-only audit logging per run
- Agent identity with persistent state and workload tracking
- Runtime role enforcement (cross-role leakage prevention)
- Project dashboard with dependency chains and agent workload
- Ticket persistence with anti-truncation guards
- Stop/resume mechanism for autonomous runs
- Stall detection (30-minute threshold on audit log)
- HTTP dashboard on localhost:18790
- External workspace model (pure engine, `.claw/` in target repos)
- Workspace bootstrap and patch application tools
- Pluggable capability system (capability registry, manifest-driven stage injection)
- Goal-driven mission layer (deterministic intent + stack detection, capability activation)
- 3 capabilities: UX audit, security audit, performance audit
- Artifact classification with semantic types and global artifact index
- Research workflow with structured findings schema
- Agent memory (append-only, schema-validated, cross-run)
- Cross-run knowledge retention in task pack generation
- Run analytics engine (per-run metrics + project-level aggregates)
- Self-evaluation with quality score, deviation analysis, and memory persistence
- Workflow suggestion engine (4 detection rules with evidence and confidence)
- Gap scanner with auto-create backlog items (idempotent)
- Agent performance profiling with recommended_agent in picker
- Dashboard Phase 4 summary (performance, suggestions, gaps)
- GitHub Actions CI (980+ tests, 53 suites)
- Zero external npm dependencies

---

## Repo Map

```
.
├── docs/
│   ├── ARCHITECTURE.md          # System design, state machine, determinism model, evolution roadmap
│   ├── GOVERNANCE.md            # Golden rules: schema enforcement, testing, no external deps
│   └── ux-spec-autonomous-runner.md  # CLI contract for autonomous runner
├── skills/
│   ├── dev-pipeline/
│   │   ├── SKILL.md                 # Comprehensive operational reference
│   │   ├── scripts/                 # 30+ Node.js implementation files
│   │   │   ├── dev-pipeline.js      # Core pipeline engine (state machine, schema validation, stage gates)
│   │   │   ├── capability-registry.js # Capability loader, stage injection, template/schema resolution
│   │   │   ├── goal-selector.js     # Deterministic intent + stack → capability mapping
│   │   │   ├── create-mission.js    # CLI: goal → mission + capabilities.json
│   │   │   ├── autonomous-runner.js # Multi-agent autonomous execution loop
│   │   │   ├── project-next-pick.js # Deterministic task picker
│   │   │   ├── project-next-drive.js # One-shot project driver with preflight validation
│   │   │   ├── validate-backlog-graph.js  # DAG validator (cycles, parents, epic completion)
│   │   │   └── ...                  # Index, dashboard, task-pack, ticket-store, agent-state
│   │   ├── schemas/                 # 22 JSON Schema files (input + output schemas)
│   │   ├── references/              # 7 artifact schemas (pm-brief, arch-design, dev-notes, etc.)
│   │   └── tests/                   # 53 test suites, ~980 tests
│   └── capabilities/               # Pluggable capability extensions
│       ├── ux_audit/                # UX audit stage (after analyze)
│       ├── security_audit/          # Security audit stage (after analyze)
│       └── performance_audit/       # Performance audit stage (after analyze)
├── tools/                       # shell wrappers (the public CLI surface)
│   ├── dp.sh                    # Main CLI entry point
│   ├── create-mission.sh        # Goal → capability activation
│   ├── test-all.sh              # Master test gate
│   ├── project-next-drive.sh    # One-shot project driver
│   ├── project-drive-loop.sh    # Cron-friendly loop wrapper
│   ├── backlog-update-status.sh # Status transition with guards
│   ├── init-workspace.sh          # Bootstrap .claw/ in a target repo
│   ├── apply-dev-patch.sh         # Apply dev patch to workspace
│   ├── _workspace.sh              # Shared --workspace flag parser
│   └── ...                      # run-next-*, project-*, dashboard-*, ticket-*
├── openclaw/                    # OpenClaw integration docs and example config
├── templates/                   # Core role-specific task pack templates
├── .github/workflows/test.yml   # CI: runs test-all.sh on push and PR
├── SOUL.md                      # Agent personality and principles
├── SECURITY.md                  # Security boundaries and access controls
└── AGENTS.md                    # Workspace orientation for agents
```

---

## Quickstart

### Requirements

- **Node.js 20+** (LTS). No other runtime dependencies.
- **No npm install.** The system uses only Node.js built-in modules (`node:fs`, `node:path`, `node:os`, `node:crypto`).
- **Bash** for shell wrappers.

### Run Tests

```bash
bash tools/test-all.sh
```

Expected output: `TOTAL: N passed, 0 failed (53 suites)` (N ~980)

### Initialize a Target Repo

```bash
./tools/init-workspace.sh --workspace /path/to/my-project \
  --project_id my-project --title "My Project"
```

Creates `.claw/` directory structure with project.json, agents.json, and all required subdirectories.

### Run the Project Dashboard

```bash
./tools/project-dashboard.sh --workspace /path/to/my-project | jq
```

### Pick the Next Eligible Task

```bash
./tools/project-next-pick.sh --workspace /path/to/my-project | jq
```

### Drive One Task (One-Shot)

```bash
./tools/project-next-drive.sh --workspace /path/to/my-project --dry_run | jq
```

Remove `--dry_run` to execute for real.

### Apply a Dev Patch

```bash
./tools/apply-dev-patch.sh --workspace /path/to/my-project \
  --run_folder .claw/runs/20260220_T-01 --dry_run
```

### Drive in a Loop (Cron-Friendly)

```bash
./tools/project-drive-loop.sh --workspace /path/to/my-project --sleep 5 --max 10
```

Stops on `.stop` file, max iterations, or no eligible work. Prints JSON summary on exit.

### Create a Mission (Goal-Driven Capability Activation)

```bash
./tools/create-mission.sh --workspace /path/to/my-project --goal "improve UX of checkout"
```

Detects intents (`ux`) and stack (`nextjs`), activates the `ux_audit` capability, and writes `.claw/capabilities.json` + `.claw/missions/<id>.json`.

### Validate a Project's Backlog Graph

```bash
./tools/validate-backlog-graph.sh --workspace /path/to/my-project my-project | jq
```

### Update Backlog Item Status (With Guards)

```bash
./tools/backlog-update-status.sh --workspace /path/to/my-project my-project TASK-01 done
```

Rejects epic-to-done transitions when children are incomplete.

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKSPACE_ROOT` | `~/dev/agent-work` | Root of the target project repo. All `.claw/` paths resolved relative to this. Can also be set via `--workspace` flag. |
| `DP_AUDIT_LOG` | `0` | Set to `1` to enable append-only audit logging. |
| `LOOP_SLEEP_SECONDS` | `5` | Seconds between drive loop iterations. |
| `LOOP_MAX_ITERATIONS` | `100` | Max iterations for drive loop (0 = unlimited). |

All configuration is via environment variables. No config files to manage.

---

## Safety, Determinism, and Quality Controls

### Guardrails

- **Path confinement.** Every file operation goes through `safePath()` which rejects any path resolving outside `WORKSPACE_ROOT`.
- **Schema enforcement.** Every JSON output is validated against a schema with `additionalProperties: false`. Undeclared fields are rejected.
- **Role enforcement.** Agents can only produce artifacts for stages matching their assigned role.
- **Read-only tools.** Index, pick, dashboard, watch, and list tools never create, modify, or delete files.
- **Write guards.** The autonomous runner never overwrites existing artifacts. The backlog updater rejects invalid epic transitions.
- **Graph validation.** Dependency cycles and invalid parent references are detected before runs start.

### Determinism

Given the same filesystem state:
- The picker always returns the same task.
- The index always returns the same project/run arrays in the same order.
- Task packs are generated identically (excluding timestamps).
- Schema validation produces the same result.

Timestamps and git HEAD are the only sources of non-determinism.

### Testing Strategy

- **53 test suites** with **~980 individual tests** covering:
  - State machine transitions and gate enforcement
  - Schema validation round-trips for all artifact types
  - Picker determinism and graph-aware constraint enforcement
  - Autonomous runner safety (no directory creation, no artifact overwrite)
  - Role enforcement and cross-role leakage prevention
  - Dashboard computed fields and dependency chain enrichment
  - Epic completion guards (validation-time and write-time)
  - Real data validation against live schemas
  - Capability registry, goal-selector, and mission layer
  - End-to-end capability injection (UX, security, performance audits)
- **`tools/test-all.sh`** is the single gate. Zero failures required.
- **GitHub Actions CI** runs on every push and PR.

### Failure Modes

| Failure | Behavior |
|---------|----------|
| Corrupted JSON | Skipped by index/pick tools. `run_next_safe` returns `action: "error"`. |
| Missing status.json | Run listed with `has_status: false`, not picked. |
| Stalled run | Detected when audit log untouched for 30+ minutes. Flagged in dashboard. |
| Schema violation | Artifact rejected. Stage cannot advance. |
| Dependency cycle | Detected by validator. Driver skips project with JSON warning. |
| Agent role mismatch | Artifact submission rejected with clear error. |

---

## Governance

### Where Decisions Live

| Document | Purpose |
|----------|---------|
| `docs/ARCHITECTURE.md` | System design, state machine, determinism model, and evolution roadmap. Single source of truth for phase scope and stop conditions. |
| `docs/GOVERNANCE.md` | Golden rules: every change tied to a ticket, every JSON has a schema, every schema has tests, no external dependencies. |
| `skills/dev-pipeline/SKILL.md` | Operational reference for all tools, commands, schemas, and behaviors. |
| `.claw/tickets/<ticket_id>.md` | Individual ticket definitions with goals, steps, and acceptance criteria. |

### How Changes Are Proposed

1. Create a ticket file in `.claw/tickets/` with frontmatter and required sections.
2. Create a backlog item in `.claw/backlog/`.
3. Reference the active phase. Changes outside the current phase are rejected.
4. Implement. Run `bash tools/test-all.sh`. Zero failures required.
5. Update `SKILL.md` if new tools or behaviors were added.
6. Commit with a descriptive message.

### Evolution Governance

- Only one phase may be active at a time.
- A phase is complete when every stop condition evaluates to true.
- Every ticket must reference its phase.
- `docs/ARCHITECTURE.md` is the single source of truth for phase scope. Conflicts between tickets and the architecture doc are resolved in favor of the architecture doc.

---

## Contributing

### Branch and PR Rules

1. Create a ticket file before starting work.
2. Run `bash tools/test-all.sh` and confirm zero failures before committing.
3. Keep commits focused: one logical change per commit.
4. Use conventional commit prefixes: `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `ci:`.
5. Do not introduce external npm dependencies.
6. Do not add `additionalProperties` to schemas without the `: false` constraint.
7. Do not modify the state machine or role boundaries without a ticket referencing a specific phase.

### Verification Checklist

```bash
# 1. Run the full test suite
bash tools/test-all.sh

# 2. Initialize a workspace and validate its graph
./tools/init-workspace.sh --workspace /tmp/test --project_id test --title "Test"
./tools/validate-backlog-graph.sh --workspace /tmp/test test | jq '.valid'

# 3. Confirm dashboard produces valid output
./tools/project-dashboard.sh --workspace /tmp/test | jq '.ok'

# 4. Confirm git status is clean
git status
```

---

## Risks and Constraints

| Risk | Mitigation |
|------|------------|
| **Determinism boundary.** Timestamps and git HEAD introduce non-determinism. | Timestamps are informational only, never used for ordering decisions. |
| **Agent hallucination.** LLM-generated artifacts may contain incorrect content. | Schema validation catches structural errors. QA and Review stages provide content checks. |
| **Cost and latency.** Autonomous runner invokes Claude CLI per stage. | `--dry_run` mode for testing. Scaffold adapter for development without API calls. Max step/agent call limits. |
| **Data privacy.** All data stays on the local filesystem. | No outbound network calls from pipeline scripts. Dashboard binds to `127.0.0.1` only. Workspace permissions set to `700`. |
| **Single-machine limitation.** No distributed execution. | By design for the current maturity level. Filesystem-as-API is the intentional constraint. |
| **No rollback mechanism.** Status transitions are one-way writes. | Append-only audit log provides full history. Artifacts are never overwritten. Safe reruns from current state. |

---

## Done

- [x] Deterministic 8-stage pipeline with role boundaries
- [x] Schema validation on all artifacts, tool outputs, input data, and reference schemas
- [x] Persistent agent identity with workload tracking and role enforcement
- [x] Structured work graph: epic hierarchy, DAG validation, cycle detection
- [x] Graph-aware scheduler: dependency satisfaction, parent blocking, epic completion
- [x] Write-time epic completion guard
- [x] Preflight graph validation in project driver
- [x] Task pack generation (deterministic, no LLM)
- [x] Autonomous multi-agent runner with stop/resume and audit logging
- [x] Project dashboard with dependency chains and agent workload
- [x] Ticket persistence with anti-truncation guards
- [x] External workspace model (pure engine, `.claw/` state in target repos)
- [x] Workspace bootstrap (`init-workspace`) and patch application (`apply-dev-patch`)
- [x] Pluggable capability system with manifest-driven stage injection
- [x] Goal-driven mission layer (deterministic intent + stack detection)
- [x] 3 capabilities: UX audit, security audit, performance audit
- [x] GitHub Actions CI (980+ tests, 53 suites, 0 failures)
- [x] `additionalProperties: false` on all schemas (governance rule enforced)
- [x] Cron-friendly drive loop with safe stop
- [x] Zero external dependencies
- [x] Phase 3: Artifact classification with semantic types
- [x] Phase 3: Global artifact index across projects and runs
- [x] Phase 3: Research workflow with structured findings
- [x] Phase 3: Agent memory persistence across runs
- [x] Phase 3: Cross-run knowledge retention in task packs
- [x] Phase 4: Run analytics engine (per-run metrics + project aggregates)
- [x] Phase 4: Self-evaluation (quality score, deviations, suggestions, memory write)
- [x] Phase 4: Workflow suggestions (recurring QA failures, bottlenecks, rejection rates, quality trends)
- [x] Phase 4: Gap scanner with auto-create backlog items
- [x] Phase 4: Agent performance profiles with recommended_agent in picker
