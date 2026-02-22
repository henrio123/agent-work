# CLAW — AI Organisation OS

## System Overview

```
                            ┌─────────────────────────────────────────────┐
                            │              MISSION LAYER                  │
                            │                                             │
                            │   "improve UX of checkout"                  │
                            │          ↓                                  │
                            │   Goal Selector (intent + stack detect)     │
                            │          ↓                                  │
                            │   .claw/capabilities.json                   │
                            │   .claw/missions/<id>.json                  │
                            └────────────────────┬────────────────────────┘
                                                 │
                                                 ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│                              CAPABILITY REGISTRY                                  │
│                                                                                   │
│   Pluggable stage injection — no core engine changes required                     │
│                                                                                   │
│   ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────────┐            │
│   │    ux_audit      │   │ security_audit   │   │ performance_audit   │            │
│   │                  │   │                  │   │                     │            │
│   │ capability.json  │   │ capability.json  │   │ capability.json     │            │
│   │ templates/       │   │ templates/       │   │ templates/          │            │
│   │ references/      │   │ references/      │   │ references/         │            │
│   └─────────────────┘   └─────────────────┘   └─────────────────────┘            │
│              ↓                     ↓                     ↓                         │
│         Injects after         Injects after         Injects after                 │
│         "analyze"             "analyze"             "analyze"                      │
└───────────────────────────────────┬───────────────────────────────────────────────┘
                                    │
                                    ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│                              PIPELINE ENGINE                                      │
│                                                                                   │
│   Deterministic state machine — filesystem is the only API                        │
│                                                                                   │
│   Default chain:                                                                  │
│                                                                                   │
│   intake → task-pack → analyze → plan → implement → validate → review → done      │
│                          │                                                        │
│   With capability:       │                                                        │
│                          ├→ ux-audit ──→ plan → ...                               │
│                          ├→ security-audit ──→ plan → ...                         │
│                          └→ performance-audit ──→ plan → ...                      │
│                                                                                   │
│   Each stage:                                                                     │
│   ┌──────────────┐  gates   ┌──────────────┐  validate  ┌──────────────┐         │
│   │  Task File   │ ──────→  │  Artifact(s)  │ ────────→  │  Advance     │         │
│   │  (template)  │  pass?   │  (JSON/diff)  │  schema?   │  next stage  │         │
│   └──────────────┘          └──────────────┘             └──────────────┘         │
│                                                                                   │
│   Role enforcement: only the assigned role can produce artifacts for its stage     │
└───────────────────────────────────┬───────────────────────────────────────────────┘
                                    │
               ┌────────────────────┼────────────────────┐
               ▼                    ▼                    ▼
┌──────────────────────┐ ┌────────────────────┐ ┌────────────────────────┐
│   PROJECT SCHEDULER  │ │  AUTONOMOUS RUNNER │ │   DASHBOARD & INDEX    │
│                      │ │                    │ │                        │
│  Deterministic pick  │ │  Loop:             │ │  Read-only JSON output │
│  Priority buckets:   │ │   1. run_next_safe │ │                        │
│   1. ready_for_run   │ │   2. invoke agent  │ │  project-index         │
│   2. needs_task_pack │ │   3. validate      │ │  project-dashboard     │
│   3. needs_artifacts │ │   4. advance       │ │  run-index             │
│   4. other           │ │                    │ │  HTTP UI :18790        │
│                      │ │  Safety:           │ │                        │
│  Stable sort:        │ │   .stop file       │ │  Per-agent workload    │
│   status → priority  │ │   stall detect     │ │  Dependency chains     │
│   → project → task   │ │   audit log        │ │  Blocked/stalled flags │
└──────────────────────┘ └────────────────────┘ └────────────────────────┘
               │                    │                    │
               └────────────────────┼────────────────────┘
                                    ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│                         WORKSPACE (.claw/)                                         │
│                                                                                   │
│   All state lives on the filesystem — no database, no message queue               │
│                                                                                   │
│   .claw/                                                                          │
│   ├── project.json              # project metadata                                │
│   ├── agents.json               # role definitions                                │
│   ├── capabilities.json         # active capabilities                             │
│   ├── missions/                 # goal → capability mapping history                │
│   │   └── <id>.json                                                               │
│   ├── backlog/                  # work graph (epics, tasks, deps)                 │
│   │   └── <task_id>.json                                                          │
│   ├── task-packs/               # structured context docs                         │
│   │   └── <task_id>.json                                                          │
│   ├── tickets/                  # markdown ticket files                            │
│   │   └── <ticket_id>.md                                                          │
│   └── runs/                     # pipeline execution state                        │
│       └── <timestamp>_<ticket>/                                                   │
│           ├── status.json           # canonical state                             │
│           ├── 00-intake.json        # initial context                             │
│           ├── 10-pm-brief.json      # Analyst artifact                            │
│           ├── 15-ux-audit.json      # UX Analyst artifact (capability)            │
│           ├── 20-arch-design.json   # Architect artifact                          │
│           ├── 40-dev-patch.diff     # Dev artifact                                │
│           ├── 41-dev-notes.json     # Dev artifact                                │
│           ├── 50-qa-report.json     # QA artifact                                 │
│           └── 60-review-report.json # Review artifact                             │
└───────────────────────────────────────────────────────────────────────────────────┘
```

## Pipeline Stages — Role Flow

```
  ┌─────────┐     ┌──────────┐     ┌───────────────────────┐     ┌───────────┐     ┌───────────┐     ┌──────────┐     ┌────────┐     ┌──────┐
  │ INTAKE  │────→│TASK-PACK │────→│       ANALYZE         │────→│   PLAN    │────→│IMPLEMENT  │────→│ VALIDATE │────→│ REVIEW │────→│ DONE │
  │         │     │GENERATED │     │                       │     │           │     │           │     │          │     │        │     │      │
  │ create  │     │ generate │     │ Analyst               │     │ Architect │     │ Dev       │     │ QA       │     │ Review │     │      │
  │ run     │     │ context  │     │ → 10-pm-brief.json    │     │ → 20-arch │     │ → 40-diff │     │ → 50-qa  │     │ → 60-  │     │      │
  └─────────┘     └──────────┘     │                       │     │   design  │     │ → 41-dev  │     │   report │     │ review │     │      │
                                   │ Capability stages:    │     └───────────┘     │   notes   │     └──────────┘     │ report │     │      │
                                   │ ┌───────────────────┐ │                       └───────────┘                      └────────┘     └──────┘
                                   │ │ ux-audit          │ │
                                   │ │ → 15-ux-audit     │ │
                                   │ ├───────────────────┤ │
                                   │ │ security-audit    │ │
                                   │ │ → 16-security     │ │
                                   │ ├───────────────────┤ │
                                   │ │ performance-audit │ │
                                   │ │ → 17-performance  │ │
                                   │ └───────────────────┘ │
                                   └───────────────────────┘
```

## Work Graph — Project Scheduling

```
  BACKLOG                         SCHEDULER                      DRIVER
  ═══════                         ═════════                      ══════

  ┌──────────────┐
  │ EPIC: Auth   │ ←─ parent_id ─┐
  │ status: todo │               │
  │ P0, PM       │               │
  └──────────────┘               │
        │ children               │
        ▼                        │
  ┌──────────────┐     ┌──────────────────────┐     ┌──────────────────────┐
  │ TASK: Login  │ ──→ │ Bucket: ready_for_run│ ──→ │ create_run           │
  │ status: todo │     │ Sort: P0 > P1 > ...  │     │ link backlog item    │
  │ P0, DEV      │     │ Deps satisfied? ✓    │     │ invoke autonomous    │
  │ depends: []  │     │ Parent blocked? ✗    │     │ runner               │
  └──────────────┘     └──────────────────────┘     └──────────────────────┘
        │
        │ depends_on
        ▼
  ┌──────────────┐
  │ TASK: OAuth  │ ←── blocked until Login = done
  │ status: todo │
  │ P1, DEV      │
  │ depends:     │
  │  [Login]     │
  └──────────────┘

  Validation: DAG check (Kahn's algorithm) — no cycles allowed
  Epic rule: epic cannot be "done" until all children are "done"
```

## Capability System — How Extensions Work

```
  1. GOAL INPUT                   2. DETECT                      3. ACTIVATE
  ══════════                      ════════                       ══════════

  "audit security                 Intents:                       .claw/capabilities.json
   vulnerabilities"               • security ✓                   { "capabilities":
        │                         • ux ✗                           ["security_audit"] }
        │                         • performance ✗                        │
        ▼                                                                │
  goal-selector.js                Stack:                                 ▼
  (deterministic                  • Cargo.toml found
   rules, no LLM)                • cosmwasm-std dep              4. CHAIN INJECTION
                                  → stack: "cosmwasm"             ═══════════════════

                                                                  analyze
                                                                     │
                                                                     ├──→ security-audit (injected)
                                                                     │       role: Security Analyst
                                                                     │       artifact: 16-security-audit.json
                                                                     │       template: claude-security-pack.txt
                                                                     │       schema: security-audit.schema.json
                                                                     │
                                                                     ▼
                                                                  plan → implement → validate → review → done
```

## Key Properties

```
  ┌──────────────────────────────────────────────────────────────────────┐
  │                        INVARIANTS                                   │
  │                                                                     │
  │  ✓ Zero npm dependencies — Node.js built-ins only                  │
  │  ✓ Filesystem is the only API — no DB, no queue                    │
  │  ✓ All tool output is JSON (stdout)                                │
  │  ✓ All schemas use additionalProperties: false                     │
  │  ✓ Deterministic — same filesystem → same output                   │
  │  ✓ Role-enforced — wrong role cannot produce artifacts             │
  │  ✓ Capability system — extend without modifying core               │
  │  ✓ 1140 tests, 66 suites, 0 failures                              │
  └──────────────────────────────────────────────────────────────────────┘
```

## Repository Layout

```
  agent-work/
  ├── tools/                        # Shell wrappers (public API)
  │   ├── dp.sh                     #   Main pipeline CLI
  │   ├── create-mission.sh         #   Goal → capability activation
  │   ├── init-workspace.sh         #   Initialize .claw/ in a repo
  │   ├── run-next-drive.sh         #   Autonomous single-run driver
  │   ├── project-next-drive.sh     #   Project-level driver
  │   ├── project-dashboard.sh      #   Read-only dashboard JSON
  │   ├── dashboard-start.sh        #   HTTP UI on :18790
  │   └── test-all.sh               #   1090 tests, single gate
  │
  ├── skills/
  │   ├── dev-pipeline/
  │   │   ├── scripts/              # Core engine (39 modules)
  │   │   │   ├── dev-pipeline.js   #   State machine + stage config
  │   │   │   ├── capability-registry.js  # Capability loader
  │   │   │   ├── goal-selector.js  #   Intent → capability mapping
  │   │   │   ├── autonomous-runner.js    # Agent loop
  │   │   │   └── ...
  │   │   ├── schemas/              # Tool I/O schemas (27)
  │   │   ├── references/           # Artifact schemas (7)
  │   │   └── tests/                # Test suites (66)
  │   │
  │   └── capabilities/             # Pluggable extensions
  │       ├── ux_audit/
  │       │   ├── capability.json
  │       │   ├── templates/claude-ux-pack.txt
  │       │   └── references/ux-audit.schema.json
  │       ├── security_audit/
  │       └── performance_audit/
  │
  ├── templates/                    # Core stage templates (6)
  │   ├── claude-analyze-pack.txt
  │   ├── claude-plan-pack.txt
  │   ├── claude-implement-pack.txt
  │   ├── claude-validate-pack.txt
  │   └── claude-review-pack.txt
  │
  └── docs/
      ├── ARCHITECTURE.md           # Authoritative system spec
      └── GOVERNANCE.md             # Evolution phases 1-3
```

## Evolution Phases

```
  Phase 1: Agent Identity & Control    ████████████████████  DONE
  ─────────────────────────────────
  Role enforcement, agent state,
  workload tracking, responsible_agent

  Phase 2: Structured Work Graph       ████████████████████  DONE
  ──────────────────────────────
  Epic hierarchy, dependency DAG,
  cycle detection, graph-aware picker

  Phase 3: Knowledge & Artifact Layer  ████████████████████  DONE
  ───────────────────────────────────
  Artifact classification, global index,
  research workflows, agent memory

  Phase 4: Self-Improving AI Org       ████████████████████  DONE
  ──────────────────────────────
  Run analytics, self-evaluation,
  workflow suggestions, gap scanner

  Phase 5: Closed-Loop Adaptive        ████████████████████  DONE
  ─────────────────────────────
  Post-run hooks, adaptive prompts,
  agent actuation, adaptive drive loop

  Phase 6: Template-Enriched Exec      ████████████████████  DONE
  ────────────────────────────────
  Template prompts, artifact context,
  validation retry, auto-patch

  Phase 7: Last-Mile Delivery          ████████████████████  CURRENT
  ───────────────────────────
  Post-patch tests, auto-commit,
  backlog completion, agent fallback
```
