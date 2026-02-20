---
name: barger-flow
description: Booking-flow orchestration skill for the Barger salon platform. Provides slash commands for project status, task picking, driving, and ticket creation.
version: 1.0.0
author: henr
user-invocable: true
metadata:
  openclaw:
    emoji: "💈"
    requires:
      bins:
        - node
---

# Barger Flow Skill

Orchestration commands for the BARGER booking platform project. All commands produce JSON output and are safe for automation.

**Project:** BARGER Booking Platform
**Stack:** Next.js, Prisma, PostgreSQL (Neon), i18n (ET/EN/RU)
**Repo:** `/Users/henr/Desktop/barger`
**Project ID:** `barger`

## Commands

### `/barger status`

Show the aggregated project dashboard for all projects (including BARGER).

```bash
./tools/project-dashboard.sh
```

Returns JSON with per-project status counts, backlog summary, and overall health.

### `/barger pick`

Pick the next eligible backlog item using deterministic priority ordering.

```bash
./tools/project-next-pick.sh
```

Returns JSON with the picked item's ID, project, type, priority, and owner_role. The picker is global — BARGER tasks are picked alongside other projects based on priority.

### `/barger drive [--dry_run]`

Execute one orchestration step on the next eligible item.

```bash
./tools/project-next-drive.sh
./tools/project-next-drive.sh --dry_run
```

Returns JSON drive result. Use `--dry_run` to preview without making changes.

### `/barger loop [--sleep N] [--max N]`

Run the drive loop continuously until stopped or exhausted.

```bash
./tools/project-drive-loop.sh --sleep 5 --max 10
```

| Flag | Default | Description |
|------|---------|-------------|
| `--sleep N` | 5 | Seconds between iterations |
| `--max N` | 100 | Maximum iterations before auto-stop |

Stop the loop by creating a `.stop` file in the workspace root.

### `/barger create-ticket "<title>" "<problem>"`

Create a new ticket and backlog item for the BARGER project atomically.

```bash
./tools/create-ticket.sh \
  --ticket_id BARGER-XX \
  --title "Short title" \
  --project_id barger \
  --description "Detailed problem description" \
  --type dev \
  --priority P1 \
  --owner_role DEV \
  --goal "What success looks like" \
  --steps "Step 1,Step 2,Step 3"
```

**Required flags:** `--ticket_id`, `--title`, `--project_id`, `--description`, `--type`, `--priority`, `--owner_role`, `--goal`, `--steps`

**Optional flags:** `--tags`, `--depends_on`, `--parent_id`, `--phase`, `--stop_condition`, `--artifacts_expected`

Returns JSON with `ticket_path` and `backlog_path` on success.

### `/barger audit`

Perform a UX audit of the booking flow. This is an instructional command — follow the checklist below:

1. Open the BARGER repo at `/Users/henr/Desktop/barger`
2. Identify the booking flow entry point (typically a services/booking page)
3. Walk through each step of the booking flow in all three locales (ET, EN, RU)
4. For each step, evaluate:
   - **Usability:** Is the flow clear? Are there dead ends?
   - **Accessibility:** Keyboard navigation, screen reader support, contrast
   - **i18n:** Are all strings translated? Any layout breaks with longer text?
   - **Performance:** Any visible lag or loading issues?
5. Document findings in a `15-ux-audit.json` artifact following `references/ux-audit.schema.json`
6. Summarize severity counts and recommend priority fixes

## Notes

- The picker and driver are global tools — they operate across all registered projects. BARGER tasks are picked by priority alongside other project tasks.
- All commands are idempotent and produce JSON output suitable for CI/automation.
- Ticket IDs for BARGER should follow the pattern `BARGER-NN` (e.g., `BARGER-01`).
- The backlog lives at `projects/barger/backlog/*.json` and tickets at `tickets/BARGER-NN.md`.
