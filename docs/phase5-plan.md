# Phase 5 — Closed-Loop Adaptive Execution (Level 5)

## Overview

Phase 5 closes the observation-to-action loops opened in Phase 4. Where Phase 4 built
measurement infrastructure (self-evaluation, workflow suggestions, gap scanning, agent
performance profiles), Phase 5 makes the system **act** on what it observes.

## Stop Conditions

| # | Condition | Status |
|---|-----------|--------|
| SC-1 | Post-run hooks auto-trigger self-eval + gap scan | DONE |
| SC-2 | Adaptive prompt includes agent memory + suggestions | DONE |
| SC-3 | `recommended_agent` flows pick → drive → runner | DONE |
| SC-4 | JS drive loop with adaptive sleep, hooks, project filter | DONE |

## Epics

### Epic 1: Post-Run Lifecycle Hooks (SC-1)

After `runAutonomous()` completes, `runPostRunHooks()` automatically:
1. Runs `selfEvaluateAndRecord()` — computes quality score, writes to agent memory
2. Runs `scanGaps({ autoCreate: true })` — finds unresolved issues, creates backlog items

Both hooks are try/catch wrapped (non-fatal). Only fires for terminal run stages.

**Files created:** `post-run-hooks.js`, `post-run-hooks.output.schema.json`
**Files modified:** `project-next-drive.js`, `project-next-drive.output.schema.json`

### Epic 2: Adaptive Agent Prompt (SC-2)

`buildPromptContext()` assembles relevant agent memory and workflow suggestions into a
structured text block injected into the Claude Code prompt:

```
Prior insights for this project:
- [evaluation] Self-evaluation: score=0.85
- [lesson] QA frequently flags missing error handling

Workflow suggestions:
- recurring_qa_failure: Recurring QA failures detected
```

Context is truncated to 2000 chars. If no context exists, prompt is unchanged.

**Files created:** `prompt-context.js`, `prompt-context.output.schema.json`
**Files modified:** `autonomous-runner.js` (claudeCodeAdapter prompt)

### Epic 3: Agent Assignment Actuation (SC-3)

`recommended_agent` from the picker is passed through:
- `pickNextTask()` → `pickResult.recommended_agent`
- `projectDriveOnce()` → `autoOpts.agentId`
- `runAutonomous()` → `context.agentId`
- `claudeCodeAdapter()` → agent identity in prompt
- `buildPromptContext()` → agent-specific memory retrieval

**Files modified:** `project-next-drive.js`, `autonomous-runner.js`

### Epic 4: Adaptive Drive Loop (SC-4)

JS replacement for the bash drive loop with:
- **Adaptive sleep:** 1s after work, exponential backoff to 30s on idle, 60s on error
- **Post-run hooks:** Registered hooks called after each drive (try/catch wrapped)
- **Project filtering:** `--project <id>` restricts picker to one project
- **Stop conditions:** .stop file, max iterations, max consecutive idle, SIGTERM/SIGINT

**Files created:** `project-drive-loop.js`, `project-drive-loop.output.schema.json`, `project-drive-loop-js.sh`
**Files modified:** `project-next-pick.js` (projectId filter), `project-next-drive.js` (projectId passthrough)

### Epic 5: Dashboard & Docs

Dashboard summary extended with:
- `last_self_evaluation` — quality score from most recent evaluation memory
- `post_run_hooks_enabled` — whether the hooks module is available
- `adaptive_loop_status` — whether the JS loop module is available

## Key Integration Points

| Phase 4 (Open Loop) | Phase 5 (Closed Loop) |
|---------------------|----------------------|
| `selfEvaluateAndRecord()` manual | Auto-triggered by `runPostRunHooks()` |
| `scanGaps({ autoCreate })` manual | Auto-triggered by `runPostRunHooks()` |
| `recommended_agent` in picker output, ignored | Passed through drive → runner → prompt |
| Agent memory not surfaced to agents | `buildPromptContext()` injects into prompt |
| Workflow suggestions not surfaced | Included in prompt via `buildPromptContext()` |
| Static bash loop with fixed sleep | JS loop with adaptive sleep + hooks |
| `--project` flag accepted but not wired | `pickNextTask()` accepts `projectId` filter |
