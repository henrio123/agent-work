# Phase 4 — Self-Improving AI Organization

## Overview

Phase 4 adds self-improvement capabilities: the system learns from its own execution history, identifies inefficiencies, fills gaps autonomously, and recommends optimal agent allocation.

## Stop Conditions

| # | Condition | Status |
|---|-----------|--------|
| SC-1 | A completed run produces a structured self-evaluation comparing QA/review outcomes against project historical baselines. Assessment is written to agent memory. | DONE |
| SC-2 | The workflow suggestion tool produces actionable suggestions with evidence when given a project with varying stage durations and QA failure rates. | DONE |
| SC-3 | The gap scanner identifies unresolved issues from completed runs and can auto-create backlog items via `createTicketAndBacklog`. | DONE |
| SC-4 | Agent performance profiles are computed from stage_history and QA/review data. The picker output includes a `recommended_agent` field. | DONE |

## Architecture

### Run Analytics Engine (Epic 1)

Foundation module that scans completed runs for a project and computes per-run metrics + project-level aggregates.

- **Script:** `skills/dev-pipeline/scripts/run-analytics.js`
- **Schema:** `skills/dev-pipeline/schemas/run-analytics.output.schema.json`
- **Per-run metrics:** stage_durations, total_duration_ms, qa_verdict, qa_issues_count, review_verdict, artifact_count, autonomous_steps
- **Aggregates:** avg_duration_per_stage, qa_pass_rate, review_approval_rate, issue_severity_distribution

### Self-Evaluation (Epic 2)

Compares a run's outcomes against project baselines to produce quality scores, deviations, and suggestions.

- **Script:** `skills/dev-pipeline/scripts/self-evaluate.js`
- **Schema:** `skills/dev-pipeline/schemas/self-evaluation.output.schema.json`
- **Quality score:** `0.4 * qa_factor + 0.4 * review_factor + 0.2 * duration_factor`
- **Memory write:** `selfEvaluateAndRecord()` writes evaluation-type memory entries
- **Graceful degradation:** quality_score=null if <2 prior runs

### Workflow Suggestions (Epic 3)

Detects patterns indicating workflow inefficiencies.

- **Script:** `skills/dev-pipeline/scripts/workflow-suggest.js`
- **Schema:** `skills/dev-pipeline/schemas/workflow-suggestions.output.schema.json`
- **Detection rules:**
  - `recurring_qa_failure` — qa_fail_rate > 0.3
  - `bottleneck_stage` — stage avg > 2x median
  - `high_rejection_rate` — review rejection/changes rate > 0.2
  - `quality_trend` — last 3 runs all had failures

### Gap Scanner (Epic 4)

Identifies unresolved issues and optionally auto-creates backlog items.

- **Script:** `skills/dev-pipeline/scripts/gap-scanner.js`
- **Schema:** `skills/dev-pipeline/schemas/gap-scanner.output.schema.json`
- **Gap types:** qa_issue_no_followup, review_changes_unaddressed, research_open_question, unresolved_question
- **Auto-create:** Calls `createTicketAndBacklog()` per gap (idempotent)

### Agent Performance (Epic 5)

Computes per-agent performance scores and recommends optimal allocation.

- **Script:** `skills/dev-pipeline/scripts/agent-performance.js`
- **Schema:** `skills/dev-pipeline/schemas/agent-performance.output.schema.json`
- **Score:** `0.4 * qa_pass_rate + 0.3 * review_approval_rate + 0.3 * speed_factor`
- **Integration:** `project-next-pick.js` now includes `recommended_agent` in output

### Dashboard Integration (Epic 6)

Dashboard summary includes Phase 4 fields: `performance_summary`, `workflow_suggestions_count`, `pending_gaps_count`.

## Dependency Graph

```
  Epic 1 (Run Analytics Engine)  ← foundation
     │
     ├──────────────┬──────────────┐
     ▼              ▼              ▼
  Epic 2         Epic 3         Epic 4
  (Self-Eval)    (Workflow)     (Gap Scanner)
     │              │              │
     └──────┬───────┘              │
            ▼                      │
         Epic 5 (Agent Perf) ◄─────┘
            │
            ▼
         Epic 6 (Dashboard & Docs)
```

## Verification

```bash
bash tools/test-all.sh  # gate: 0 failures

# SC-1
node skills/dev-pipeline/scripts/self-evaluate.js --run_folder <run> --project <id> | jq '.quality_score'

# SC-2
node skills/dev-pipeline/scripts/workflow-suggest.js --project <id> | jq '.suggestions | length'

# SC-3
node skills/dev-pipeline/scripts/gap-scanner.js --project <id> --auto_create | jq '.summary.auto_created_count'

# SC-4
node skills/dev-pipeline/scripts/project-next-pick.js | jq '.recommended_agent'
```
