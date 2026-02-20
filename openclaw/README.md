# OpenClaw Integration

OpenClaw provides a control plane for agent-based orchestration. Skills are loaded from `skills/` directories as SKILL.md files with YAML frontmatter. Agents invoke `tools/*.sh` wrappers via bash/exec.

## Architecture

agent-work is a **pure engine** — it contains no project data. All project state lives inside the target repository under a `.claw/` hidden folder. The engine operates on external repos via `--workspace` flag or `WORKSPACE_ROOT` env var.

```
agent-work/                       (engine — no project data here)
├── skills/dev-pipeline/          (orchestration engine)
│   ├── SKILL.md
│   ├── scripts/                  (Node.js implementations)
│   ├── schemas/                  (JSON Schema definitions)
│   ├── references/               (reference schemas)
│   └── tests/                    (test suites)
├── tools/                        (shell wrappers)
├── openclaw/                     (this directory)
└── templates/                    (artifact templates)

/path/to/target-repo/             (any project repo)
└── .claw/                        (orchestration state)
    ├── project.json
    ├── agents.json
    ├── backlog/
    ├── task-packs/
    ├── runs/
    ├── tickets/
    ├── agents/
    └── artifacts/
```

## Quick Start

```bash
# 1. Initialize a target repo
./tools/init-workspace.sh --workspace /path/to/my-project

# 2. Create a ticket
./tools/create-ticket.sh --workspace /path/to/my-project \
  --ticket_id T-01 --title "Fix login" --project_id my-project \
  --description "Login times out" --type dev --priority P1 \
  --owner_role DEV --goal "Fix the timeout" --steps "Diagnose,Fix,Test"

# 3. Check status
./tools/project-dashboard.sh --workspace /path/to/my-project

# 4. Drive work forward
./tools/project-next-drive.sh --workspace /path/to/my-project --dry_run
```

## Command → Tool Mapping

All tools accept `--workspace <path>` or `WORKSPACE_ROOT` env var.

| Command | Tool Script | Output |
|---------|------------|--------|
| Init workspace | `./tools/init-workspace.sh` | JSON with created paths |
| Dashboard | `./tools/project-dashboard.sh` | JSON dashboard |
| Pick next | `./tools/project-next-pick.sh` | JSON pick result |
| Drive once | `./tools/project-next-drive.sh` | JSON drive result |
| Drive loop | `./tools/project-drive-loop.sh` | JSON loop summary |
| Create ticket | `./tools/create-ticket.sh` | JSON creation result |
| Apply patch | `./tools/apply-dev-patch.sh` | JSON apply result |

## Security

- **Least privilege:** Each agent role has explicit `allowed_actions` in `.claw/agents.json`
- **Approval gates:** All state transitions require schema validation
- **Path safety:** All file operations are sandboxed under WORKSPACE_ROOT via `safePath()`
- **Anti-truncation:** Ticket guard prevents referencing work that isn't persisted to disk
- **Schema enforcement:** `additionalProperties: false` on all schemas prevents silent data corruption
