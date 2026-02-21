# Phase 3 Plan — Knowledge & Artifact Layer

**Author:** Product Management
**Date:** 2026-02-21
**Status:** Draft — pending team review
**Baseline:** 773 tests, 41 suites, 25 core scripts, 3 capabilities
**Governance:** All work subject to `docs/ARCHITECTURE.md` Phase 3 stop conditions

---

## Executive Summary

Phases 1 and 2 gave us **identity** (who can do what) and **structure** (how work relates). Phase 3 gives us **memory** — the system learns from its own execution history.

Today, every run starts from scratch. An agent completing Task B has no awareness that Task A already solved a similar problem yesterday. Research findings disappear after the run closes. Agent observations evaporate between sessions.

Phase 3 turns the pipeline from a stateless executor into a knowledge-compounding system. When it ships, the pipeline gets smarter with every run it completes.

---

## Stop Conditions (from ARCHITECTURE.md)

These are non-negotiable. Phase 3 is not complete until **all four** evaluate to true:

| # | Condition | Mapped To |
|---|-----------|-----------|
| SC-1 | Artifact index tool produces valid JSON covering all artifacts across all projects and runs | Epic 2 |
| SC-2 | Research tasks have a dedicated workflow with a validated output schema | Epic 3 |
| SC-3 | Agent memory persists across runs (write in run N, read in run N+1) | Epic 4 |
| SC-4 | Project dashboard includes knowledge state (artifact counts by type, research findings count, memory entry count) | Epic 5 |

---

## Pre-Phase: Documentation Debt (Epic 0)

The capability system, goal-selector, and mission layer shipped without documentation updates. Governance rule 4 requires docs to stay current. This must ship before Phase 3 work begins.

### Epic 0: Close Documentation Debt

**Priority:** P0 — blocks all Phase 3 work
**Owner:** PM
**Rationale:** GOVERNANCE.md rules 1.1 and 4.x require documentation parity. External contributors and agents cannot discover the capability system without docs.

| Task | ID | Description | Deps |
|------|----|-------------|------|
| Update README test counts | E0-T1 | Change 630→773 tests, 34→41 suites in 4 locations. Update "Done" and "Features" sections to mention capability system, mission layer. | — |
| Update SKILL.md | E0-T2 | Add sections: Capability System (registry, manifests, activation), Mission Layer (goal-selector, create-mission), new tools (create-mission.sh). Add 3 new capabilities to tool inventory. | — |
| Update ARCHITECTURE.md | E0-T3 | Add section 4.7 `.claw/capabilities.json`, section 4.8 `.claw/missions/`. Document capability registry in section 10.2. Update "Current System State" to mention capability system. | — |
| Update drift-report.md | E0-T4 | Mark Phases 2-3 remediation as DONE. Update baseline to 773 tests / 41 suites. Record zero domain leakage result. | — |
| Update CI test count reference | E0-T5 | Verify `.github/workflows/test.yml` still works. Update any hardcoded count expectations. | — |

---

## Phase 3 Epics

### Dependency Graph

```
  Epic 0 (Doc Debt)
     │
     ▼
  Epic 1 (Classification Schema)
     │
     ├──────────────────┐
     ▼                  ▼
  Epic 2 (Index)     Epic 3 (Research)     Epic 4 (Agent Memory)
     │                  │                      │
     └──────────┬───────┘                      │
                │                              │
                ▼                              │
         Epic 5a (Cross-Run Knowledge) ◄───────┘
                │
                ▼
         Epic 5b (Dashboard Knowledge State)
```

---

### Epic 1: Artifact Classification Schema

**Priority:** P0 — foundational, everything depends on this
**Owner:** Architect
**Stop condition served:** Prerequisite for SC-1, SC-4

Every artifact in the system gets a semantic type tag. This is the vocabulary layer that all subsequent epics depend on.

| Task | ID | Description | Deps |
|------|----|-------------|------|
| Define classification taxonomy | E1-T1 | Design the set of semantic types. Starting set from ARCHITECTURE.md: `decision`, `design`, `implementation`, `test-result`, `research-finding`, `observation`. Evaluate if `analysis`, `audit`, `review-verdict` should be added for capability artifacts. Write ADR. | — |
| Create artifact-classification.schema.json | E1-T2 | JSON Schema in `schemas/`. Required fields: `artifact_file`, `semantic_type` (enum), `stage`, `run_id`, `project_id`, `created_at`. `additionalProperties: false`. | E1-T1 |
| Build classification rules engine | E1-T3 | Deterministic mapping: filename pattern → semantic type. `10-pm-brief.json` → `analysis`, `20-arch-design.json` → `design`, `40-dev-patch.diff` → `implementation`, `50-qa-report.json` → `test-result`, `60-review-report.json` → `review-verdict`. Capability artifacts classified via capability manifest metadata. No LLM calls. | E1-T1 |
| Write tests | E1-T4 | Test classification rules for all core artifacts + capability artifacts. Edge cases: unknown filenames, malformed artifacts, capability artifacts without manifest metadata. | E1-T2, E1-T3 |

**Acceptance:** Every artifact filename in the system maps to exactly one semantic type. Unknown files return `null` (not error). Classification is deterministic.

---

### Epic 2: Global Artifact Index

**Priority:** P0 — required for SC-1
**Owner:** Dev
**Stop condition served:** SC-1 directly

A read-only tool that scans all runs across all projects and produces a searchable index of every artifact.

| Task | ID | Description | Deps |
|------|----|-------------|------|
| Design index output schema | E2-T1 | `artifact-index.output.schema.json` in `schemas/`. Fields: `ok`, `generated_at`, `total_artifacts`, `artifacts[]` (each with: `file`, `semantic_type`, `project_id`, `run_id`, `stage`, `schema_valid`, `created_at`, `size_bytes`). Filterable by type, project, stage. `additionalProperties: false`. | E1-T2 |
| Build artifact-index.js | E2-T2 | Script in `scripts/`. Scans all workspace `.claw/runs/*/` directories. For each run folder, reads `status.json` for metadata, classifies each artifact file using E1-T3 rules, validates against schema if known. Returns sorted array. Deterministic output (same filesystem → same result, excluding `generated_at`). | E2-T1, E1-T3 |
| Create shell wrapper | E2-T3 | `tools/artifact-index.sh --workspace <path> [--type <semantic_type>] [--project <id>] [--stage <stage>]`. Filters applied server-side before JSON emission. | E2-T2 |
| Write tests | E2-T4 | Test: empty workspace, workspace with runs, filtering by type/project/stage, deterministic ordering, schema validation of output, read-only safety (no writes). Target: ~15 tests. | E2-T2, E2-T3 |
| Add to test-all.sh | E2-T5 | Register test suite. | E2-T4 |

**Acceptance:** `./tools/artifact-index.sh --workspace /path | jq '.total_artifacts'` returns correct count. Output validates against schema. Tool is read-only.

---

### Epic 3: Research Workflow

**Priority:** P1 — required for SC-2
**Owner:** Architect + Dev
**Stop condition served:** SC-2 directly

Research tasks follow a different flow than standard dev tasks. They produce structured findings instead of code patches.

| Task | ID | Description | Deps |
|------|----|-------------|------|
| Design research output schema | E3-T1 | `research-findings.schema.json` in `references/`. Required fields: `ticket_id`, `hypotheses[]` (each: `id`, `statement`, `status`: confirmed/rejected/inconclusive), `methods[]` (each: `id`, `description`, `tools_used`), `findings[]` (each: `id`, `hypothesis_id`, `description`, `evidence[]`, `confidence`: high/medium/low), `conclusion`, `open_questions[]`. `additionalProperties: false`. | — |
| Create research capability | E3-T2 | New capability at `skills/capabilities/research/`. Manifest: injects `research` stage after `analyze`, role "Researcher", artifact `18-research-findings.json`, template `claude-research-pack.txt`. This uses the existing capability system — no core engine changes. | E3-T1 |
| Create research template | E3-T3 | `skills/capabilities/research/templates/claude-research-pack.txt`. Template with placeholders for ticket context, hypothesis framing, evidence gathering instructions, structured output format. | E3-T2 |
| Update goal-selector | E3-T4 | Add `research` intent detection in `parseIntents()`. Keywords: `research`, `investigate`, `explore`, `analyze`, `study`, `evaluate`, `compare`. Map to `research` capability. | E3-T2 |
| Write e2e tests | E3-T5 | Follow established pattern from `test-ux-audit-e2e.js`. Test chain injection, template resolution, artifact gating, scaffold, validation. Target: ~16 tests. | E3-T2, E3-T3 |
| Write goal-selector tests | E3-T6 | Add tests to `test-goal-selector.js` for research intent detection and capability mapping. | E3-T4 |

**Acceptance:** `create-mission.sh --workspace /path --goal "research caching strategies"` activates `research` capability. Pipeline gates on `18-research-findings.json`. Scaffold produces valid minimal artifact.

---

### Epic 4: Agent Memory Layer

**Priority:** P1 — required for SC-3
**Owner:** Dev
**Stop condition served:** SC-3 directly

Agents can write observations during runs and read them in future runs. Memory is append-only and schema-validated.

| Task | ID | Description | Deps |
|------|----|-------------|------|
| Design memory entry schema | E4-T1 | `agent-memory.schema.json` in `schemas/`. Required fields: `id` (uuid), `agent_id`, `run_id`, `project_id`, `stage`, `type` (enum: `observation`, `lesson`, `pattern`, `warning`), `content` (string, max 2000 chars), `tags[]`, `created_at`. `additionalProperties: false`. | — |
| Design memory index schema | E4-T2 | `agent-memory-index.output.schema.json`. Fields: `ok`, `agent_id`, `total_entries`, `entries[]`, `by_type` counts. | E4-T1 |
| Build agent-memory.js | E4-T3 | Script with commands: `write_memory --agent_id <id> --run_id <id> --type <type> --content <text> --tags <t1,t2>` and `read_memory --agent_id <id> [--type <type>] [--project <id>] [--limit N]`. Write is append-only: creates `.claw/agents/<id>/memory/<timestamp>.json`. Read scans and returns sorted array. Never deletes or modifies existing entries. | E4-T1, E4-T2 |
| Create shell wrappers | E4-T4 | `tools/agent-memory-write.sh` and `tools/agent-memory-read.sh`. Both use `--workspace` flag. | E4-T3 |
| Integration with autonomous-runner | E4-T5 | After each stage completion, the runner writes an automatic observation: `{ type: "observation", content: "Completed <stage> for <ticket_id>. Artifacts: [...]", tags: [stage, ticket_id] }`. Only if agent_id is set. | E4-T3 |
| Write tests | E4-T6 | Test: write + read round-trip, append-only guarantee (existing entries untouched), filtering by type/project, schema validation, empty memory returns empty array, memory persists across separate read calls (simulating separate runs). Target: ~18 tests. | E4-T3, E4-T4 |
| Add to test-all.sh | E4-T7 | Register test suite. | E4-T6 |

**Acceptance:** Agent writes observation in Run N. Separate invocation reads it back in Run N+1. Memory files accumulate, never overwrite. Schema validation passes.

---

### Epic 5a: Cross-Run Knowledge Retention

**Priority:** P2 — depends on Epic 2 + Epic 4
**Owner:** Dev
**Stop condition served:** Deliverable (supports SC-4 indirectly)

The task pack generator references artifacts and memory from prior runs when building context.

| Task | ID | Description | Deps |
|------|----|-------------|------|
| Design knowledge context section | E5a-T1 | Add `prior_knowledge` section to task-pack.schema.json. Fields: `related_artifacts[]` (file, run_id, semantic_type, relevance), `agent_memories[]` (content, type, from_run), `related_findings[]` (from research runs). All optional arrays — backward compatible. | E2-T1, E4-T1 |
| Update task-pack-generate.js | E5a-T2 | When generating a task pack, scan artifact index for same project. Find artifacts with matching semantic type or tags. Include top 5 most relevant (by recency, same ticket priority). Scan agent memory for same project. Include top 5 most relevant observations. | E5a-T1, E2-T2, E4-T3 |
| Write tests | E5a-T3 | Test: task pack with no prior knowledge (empty arrays), with prior artifacts, with agent memories, relevance scoring, backward compat (old task packs still valid). Target: ~12 tests. | E5a-T2 |

**Acceptance:** Task pack for Task B in a project that already completed Task A includes references to Task A's artifacts and agent observations from Task A's run.

---

### Epic 5b: Dashboard Knowledge State

**Priority:** P2 — required for SC-4, depends on Epic 1 + Epic 2 + Epic 3 + Epic 4
**Owner:** Dev
**Stop condition served:** SC-4 directly

The project dashboard output includes knowledge metrics.

| Task | ID | Description | Deps |
|------|----|-------------|------|
| Design knowledge state fields | E5b-T1 | Add to `project-dashboard.output.schema.json`: per-project `knowledge_state` object with `artifact_counts_by_type` (object), `research_findings_count` (integer), `memory_entry_count` (integer), `total_artifacts` (integer). Top-level summary gets `knowledge_summary`. | E1-T2, E3-T1, E4-T2 |
| Update project-dashboard.js | E5b-T2 | After computing existing fields, scan artifact index and memory index for each project. Aggregate counts. Lightweight — re-uses artifact-index and agent-memory modules. | E5b-T1, E2-T2, E4-T3 |
| Write tests | E5b-T3 | Test: dashboard with no knowledge (zero counts), with artifacts and memory, schema validation of output, backward compat. Target: ~10 tests. | E5b-T2 |
| Update test-all.sh | E5b-T4 | Register new tests or add to existing dashboard test suite. | E5b-T3 |

**Acceptance:** `./tools/project-dashboard.sh --workspace /path | jq '.projects[0].knowledge_state'` returns artifact counts by type, research findings count, and memory entry count.

---

## Execution Order

```
  Week 1          Week 2          Week 3          Week 4          Week 5
  ───────         ───────         ───────         ───────         ───────

  ┌─────────┐
  │ Epic 0  │  Documentation debt (P0)
  │ 5 tasks │
  └────┬────┘
       │
       ▼
  ┌─────────┐
  │ Epic 1  │  Classification schema (P0)
  │ 4 tasks │
  └────┬────┘
       │
       ├───────────────┬──────────────────┐
       ▼               ▼                  ▼
  ┌─────────┐   ┌─────────┐       ┌─────────┐
  │ Epic 2  │   │ Epic 3  │       │ Epic 4  │
  │ Index   │   │Research │       │ Memory  │
  │ 5 tasks │   │ 6 tasks │       │ 7 tasks │
  └────┬────┘   └────┬────┘       └────┬────┘
       │              │                 │
       └──────┬───────┘                 │
              ▼                         │
       ┌──────────┐                     │
       │ Epic 5a  │ ◄──────────────────┘
       │Cross-Run │
       │ 3 tasks  │
       └────┬─────┘
            │
            ▼
       ┌──────────┐
       │ Epic 5b  │  Dashboard knowledge (completes SC-4)
       │ 4 tasks  │
       └──────────┘
```

Epics 2, 3, and 4 can run **in parallel** after Epic 1 ships. Epic 5a requires 2 + 4. Epic 5b requires everything.

---

## Totals

| Metric | Count |
|--------|-------|
| Epics | 7 (including Epic 0) |
| Tasks | 38 |
| New scripts | 3 (`artifact-index.js`, `agent-memory.js`, classification rules in existing or new file) |
| New schemas | 5 (`artifact-classification`, `artifact-index.output`, `research-findings`, `agent-memory`, `agent-memory-index.output`) |
| New capabilities | 1 (`research`) |
| New shell wrappers | 3 (`artifact-index.sh`, `agent-memory-write.sh`, `agent-memory-read.sh`) |
| New test suites | ~4-5 |
| Estimated new tests | ~70-80 |
| Modified existing files | ~6 (`task-pack.schema.json`, `task-pack-generate.js`, `project-dashboard.js`, `project-dashboard.output.schema.json`, `goal-selector.js`, `autonomous-runner.js`) |

---

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Artifact index scan is slow on large workspaces | Dashboard latency | Lazy scan — only re-index changed run folders (compare mtime). Keep index cached at `.claw/artifact-index.cache.json`. |
| Memory accumulation unbounded | Disk bloat over time | Per-agent memory cap (1000 entries). Oldest entries archived, not deleted. Soft limit with warning in dashboard. |
| Task pack context window overflow | LLM context blown with too many references | Hard limit: max 5 prior artifacts + 5 memories in task pack. Relevance scoring by recency + same-ticket affinity. |
| Research capability scope creep | Research becomes a catch-all for anything not dev | Strict taxonomy: research tasks require `type: "research"` in backlog. Goal-selector only maps explicit research intents. |
| Schema migrations for existing workspaces | Existing `.claw/` dirs break | All new fields are additive (optional arrays, optional objects). `normalizeStatus()` pattern for backward compat. No breaking changes. |

---

## Success Metrics

After Phase 3 ships:

1. **Zero test failures** — `bash tools/test-all.sh` passes (target: ~850+ tests)
2. **All 4 stop conditions true** — verified by running each tool against a populated workspace
3. **No new external dependencies** — still zero npm packages
4. **Backward compatible** — existing workspaces work without migration
5. **Documentation current** — ARCHITECTURE.md, SKILL.md, README.md all updated

---

## What Comes After (Level 4 Preview)

Phase 3 creates the foundation for Level 4 (self-improving AI organization):

| Level 4 Feature | Phase 3 Foundation |
|------------------|--------------------|
| Self-evaluation loops | Agent memory stores quality assessments → future self-evaluation compares against historical baselines |
| Workflow optimization | Artifact index reveals patterns (e.g., "QA always rejects after Dev skips tests") → system suggests pipeline changes |
| Autonomous ticket creation | Research findings + agent observations identify gaps → system proposes new backlog items |
| Adaptive role allocation | Memory tracks agent performance per stage → scheduler factors in historical success rate |

None of this is in scope for Phase 3. But every Phase 3 deliverable was designed to enable it.
