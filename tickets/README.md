# Tickets

Each ticket is a markdown file with a YAML frontmatter block.

## Format

```markdown
---
ticket_id: OC-08
title: Add tickets as source of truth
project: agent-work
---

## Goal
What this ticket achieves.

## Steps
1. First step
2. Second step

## Acceptance
- [ ] Criteria one
- [ ] Criteria two
```

## Required frontmatter fields

- `ticket_id` — unique identifier (used as filename: `<ticket_id>.md`)
- `title` — human-readable summary
- `project` — project name for the run

## Workflow

1. Create a ticket file in `tickets/`
2. Run `./tools/dp.sh create_run_from_ticket <ticket_id>`
3. Run `./tools/dp.sh generate_task_pack <run_folder>`
4. Work from `<run_folder>/30-dev-claude-task.txt`
