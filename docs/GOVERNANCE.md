# Governance

Rules for how work is done in this system. These rules prevent scope drift, lost tasks, and undocumented changes.

## 1. Golden Rules

### 1.1 Every Change Is Tied to a Ticket

No code, schema, tool, or documentation change is made without a ticket. Tickets live in `tickets/<ticket_id>.md`. The ticket file must exist before work begins. Use `./tools/ticket-guard.sh <ticket_id>` to verify.

### 1.2 Every JSON Structure Has a Schema

Every JSON structure in the system must have a corresponding schema with `additionalProperties: false`. This rule covers three categories:

| Category | Location | Examples |
|---|---|---|
| **Output schemas** | `skills/dev-pipeline/schemas/*.output.schema.json` | Tool command stdout contracts |
| **Input schemas** | `skills/dev-pipeline/schemas/*.schema.json` | `backlog-item`, `project`, `agents` |
| **Reference schemas** | `skills/dev-pipeline/references/*.schema.json` | `status`, `pm-brief`, `qa-report` |

All three categories require `additionalProperties: false` at the root level and on any nested object that declares `properties`. If the structure changes, the schema must change first. Fields present in real data but absent from the schema are a governance violation.

### 1.3 Every Schema Has Tests

Every schema must be validated in at least one test. Tests live in `skills/dev-pipeline/tests/`. Each test file must be listed in the `SUITES` array in `tools/test-all.sh`.

### 1.4 No External Dependencies

The system uses only Node.js built-in modules: `node:fs`, `node:path`, `node:os`, `node:crypto`. No `npm install`. No `package.json`. No `node_modules/`.

### 1.5 Tools Output JSON Only

All tool stdout is JSON. The only exception is `ticket-show.sh` which prints raw ticket markdown. Errors go to stderr as `{ "ok": false, "error": "..." }`. Exit code 0 for success, 1 for errors.

## 2. Definition of Done for a Ticket

A ticket is done when all of the following are true:

1. All deliverables listed in the ticket's Steps or Acceptance section are complete.
2. `bash tools/test-all.sh` passes with 0 failures.
3. New tools have shell wrappers in `tools/`.
4. New tools have tests in `skills/dev-pipeline/tests/`.
5. New schemas have `additionalProperties: false` per Rule 1.2.
6. `skills/dev-pipeline/SKILL.md` is updated if new tools or commands were added.
7. Changes are committed with the commit message specified in the ticket.
8. `git status` shows a clean working tree after the commit.

## 3. Scope Control Rules

1. A ticket defines exactly what to build. Do not add features not listed in the ticket.
2. If a gap is found during implementation, create a new ticket for it. Do not expand the current ticket.
3. Refactors that change runtime behavior require their own ticket.
4. Documentation-only changes require their own ticket (like this one).
5. If a ticket says "no new tools", do not create new tools.
6. If a ticket says "no new dependencies", do not add dependencies.

## 4. Documentation Update Rules

1. `skills/dev-pipeline/SKILL.md` is the operational reference. Update it when adding tools, commands, schemas, or changing behavior.
2. `docs/ARCHITECTURE.md` is the structural reference. Update it when adding new concepts, changing the filesystem layout, or modifying the state machine.
3. `docs/GOVERNANCE.md` is this file. Update it when changing process rules.
4. Do not add inline documentation that duplicates what is already in these files.
5. Test counts in SKILL.md are informational. Update them when adding test files.

## 5. Versioning and Release Notes Rules

1. The tool version is in `dev-pipeline.js` as `TOOL_VERSION`. Bump it when changing the public CLI interface.
2. The skill version is in `skills/dev-pipeline/SKILL.md` frontmatter. Bump it when changing the skill's contract.
3. Schema versions are implicit: the schema file itself is the version. Breaking changes to a schema require updating all tests that validate against it.
4. Commit messages follow the pattern: `feat:` for new features, `fix:` for bug fixes, `chore:` for non-functional changes, `refactor:` for behavior-preserving restructuring.
5. Each ticket specifies its exact commit message. Use it verbatim.
