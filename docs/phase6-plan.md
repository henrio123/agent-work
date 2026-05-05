# Phase 6 — Template-Enriched Agent Execution

## Summary

Phase 6 closes four gaps in the autonomous pipeline:

1. **Template-enriched prompts** — `claudeCodeAdapter` now reads rendered stage task files (e.g., `31-analyze-task.txt`) via `buildAdapterPrompt()` instead of building minimal prompts from scratch. Templates provide GOAL/STEPS/OUTPUT instructions.

2. **Prior artifact context** — `buildArtifactContext()` reads prior artifacts from the run folder and injects their content into the prompt. Each stage gets the artifacts it needs per `STAGE_ARTIFACT_DEPS`.

3. **Validation retry loop** — When `validateDraft()` returns errors, the adapter retries up to `maxRetries` times with error feedback via `buildRetryPrompt()`. Retries are tracked in the audit trail.

4. **Auto-patch application** — After the implement stage writes `40-dev-patch.diff`, `applyDevPatch()` is invoked (dry-run first, then real). Failure is non-fatal and recorded in the result.

## New Files

| File | Purpose |
|------|---------|
| `skills/dev-pipeline/scripts/adapter-prompt-builder.js` | `buildAdapterPrompt()`, `buildArtifactContext()`, `buildRetryPrompt()` |
| `skills/dev-pipeline/tests/test-adapter-prompt-builder.js` | 22 tests for Epics 1 & 2 |
| `skills/dev-pipeline/tests/test-validation-retry.js` | 7 tests for Epic 3 |
| `skills/dev-pipeline/tests/test-auto-patch.js` | 7 tests for Epic 4 |
| `skills/dev-pipeline/tests/test-dashboard-phase6.js` | 6 tests for Epic 5 |
| `docs/phase6-plan.md` | This document |

## Modified Files

| File | Change |
|------|--------|
| `skills/dev-pipeline/scripts/autonomous-runner.js` | `claudeCodeAdapter` calls `buildAdapterPrompt()` with fallback. Retry loop in `needs_artifacts` handler. Post-implement patch hook. `retries_attempted` and `patch_application` in `_result()`. |
| `skills/dev-pipeline/scripts/project-dashboard.js` | Computes 4 Phase 6 feature flags |
| `skills/dev-pipeline/schemas/project-dashboard.output.schema.json` | Added `template_enrichment_enabled`, `artifact_context_enabled`, `retry_loop_enabled`, `auto_patch_enabled` |
| `tools/test-all.sh` | Registered 4 new test suites |
| `docs/ARCHITECTURE_DETAILED.md` | Phase 6 section |
| `README.md` | Updated Level 6 status |

## Key Design Decisions

- **Lazy require with fallback** — `claudeCodeAdapter` uses try/catch around `require(ADAPTER_PROMPT_BUILDER_PATH)`. If the module is missing, it falls back to the original minimal prompt. This ensures backward compatibility.
- **Non-fatal patch application** — The entire patch block is try/catch wrapped. A failed `git apply` never blocks the pipeline.
- **Retry prompt injection** — Retries re-invoke the same adapter with a `retryPrompt` field in context. The adapter sees the retry context and can use it.
- **`maxRetries: 0` disables retries** — Exact prior behavior is preserved when retries are disabled.
