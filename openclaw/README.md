# OpenClaw Integration

OpenClaw provides a control plane for agent-based orchestration. Skills are loaded from `skills/` directories as SKILL.md files with YAML frontmatter. Agents invoke `tools/*.sh` wrappers via bash/exec.

## Available Skills

| Skill | Directory | Description |
|-------|-----------|-------------|
| `dev-pipeline` | `skills/dev-pipeline/` | Core orchestration pipeline with role-based stage machine |
| `barger-flow` | `skills/barger-flow/` | Booking-flow commands for the BARGER salon project |

## Command → Tool Mapping

| Slash Command | Tool Script | Output |
|---------------|------------|--------|
| `/barger status` | `./tools/project-dashboard.sh` | JSON dashboard |
| `/barger pick` | `./tools/project-next-pick.sh` | JSON pick result |
| `/barger drive` | `./tools/project-next-drive.sh` | JSON drive result |
| `/barger loop` | `./tools/project-drive-loop.sh` | JSON loop summary |
| `/barger create-ticket` | `./tools/create-ticket.sh` | JSON creation result |
| `/barger audit` | Instructional (no tool) | Agent follows UX audit checklist |

## Setup

1. Ensure OpenClaw is installed and configured (`~/.openclaw/openclaw.json`)
2. Enable skills in the workspace config:

```json
{
  "skills": [
    { "path": "skills/dev-pipeline" },
    { "path": "skills/barger-flow" }
  ]
}
```

3. Skills are loaded automatically when their directory contains a valid `SKILL.md` with YAML frontmatter.

## Security

- **Least privilege:** Each agent role has explicit `allowed_actions` defined in `projects/<id>/agents.json`
- **Approval gates:** All state transitions require schema validation before advancing
- **Read-only defaults:** Dashboard, index, and watch commands are read-only
- **Anti-truncation:** Ticket guard prevents referencing work that isn't persisted to disk
- **Schema enforcement:** `additionalProperties: false` on all schemas prevents silent data corruption

## Architecture

```
openclaw/
├── README.md                      ← This file
└── example.gateway.config.yml     ← Example gateway configuration

skills/
├── dev-pipeline/                  ← Core orchestration skill
│   ├── SKILL.md
│   ├── scripts/                   ← Node.js implementations
│   ├── schemas/                   ← JSON Schema definitions
│   ├── references/                ← Reference schemas (optional artifacts)
│   └── tests/                     ← Test suites
└── barger-flow/                   ← BARGER project skill
    └── SKILL.md

tools/                             ← Shell wrappers (entry points)
├── project-dashboard.sh
├── project-next-pick.sh
├── project-next-drive.sh
├── project-drive-loop.sh
├── create-ticket.sh
└── ...

projects/
├── barger/                        ← BARGER project data
│   ├── project.json
│   ├── agents.json
│   └── backlog/
└── ai-organisation-os/            ← AI Org OS project data
```
