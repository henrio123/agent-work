# Drift Report — Domain Leakage Verification

This is a standing verification record for the `agent-work` repository. Its
purpose is to confirm that the repo contains a **reusable orchestration
engine**, not project-specific operational state.

## Purpose

`agent-work` is intended to function as a pure engine: any project's runtime
data (tickets, backlog items, runs, agent memory, artifacts) should live in a
target workspace under `.claw/`, never inside this repository. This report
confirms that boundary holds at the current `HEAD` and documents how it is
maintained.

## Result

No active domain-specific project state is embedded in the engine repo.
Earlier material that referenced specific customer or project domains was
removed or refactored out during the engine extraction work. What remains in
the repo is the orchestration code, schemas, documentation, tests, and the
workspace-agent contract files.

## Boundaries (Current State)

- **Project state** — backlog items, task packs, runs, agent memory,
  artifacts, tickets — lives under each target repo's own `.claw/` directory.
  It is never written into this repository.
- **Engine** — the `agent-work` repo contains:
  - Orchestration scripts under `skills/dev-pipeline/scripts/`
  - JSON Schemas under `skills/dev-pipeline/schemas/` and `references/`
  - Capability extensions under `skills/capabilities/`
  - Shell wrappers under `tools/`
  - Architecture and governance docs under `docs/`
  - Workspace-agent contract files at the root (`AGENTS.md`, `BOOTSTRAP.md`,
    `HEARTBEAT.md`, `IDENTITY.md`, `SOUL.md`, `USER.md`, `TOOLS.md`) — these
    instruct an AI agent that visits this workspace and are not part of the
    orchestrator runtime.
- **Integration spec** — `openclaw/` contains an integration contract for an
  external control plane (`README.md` and `example.gateway.config.yml`).
  Nothing in this repo executes those files; they document the consumer
  contract for a separate product.

## How the Boundary Is Enforced

- All path resolution goes through `safePath()`, anchored on `WORKSPACE_ROOT`
  (the **target** repo, not this one).
- The orchestrator's filesystem writes are constrained to declared output
  locations (run folders, backlog items, task packs, tickets) inside the
  target workspace.
- `.gitignore` excludes `.claw/` so that any local engine-on-itself testing
  cannot accidentally leak project state into commits.

## Verification Checklist

The following are the gates this report attests to for the current `HEAD`:

- [x] No hardcoded customer or project-specific data in tracked sources.
- [x] No API keys, tokens, or other secrets in tracked sources. The
      configuration surface is documented in `.env.example` (only
      `WORKSPACE_ROOT`, `DP_AUDIT_LOG`, and the optional `LOOP_*` tuning
      variables — no credentials).
- [x] `bash tools/test-all.sh` passes with zero failures on the current
      `HEAD`.

## Scope and Caveats

This report is a structural verification, not a security audit. It records
that the engine/state boundary holds and that the test gate is green. It
does not claim production use, formal compliance review, or third-party
verification. Re-run the gate (`bash tools/test-all.sh`) and re-inspect for
hardcoded paths whenever extracting or refactoring the engine further.
