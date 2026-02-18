# Security Decisions — OpenClaw Dev Workspace

## Gateway

- **Bind:** `loopback` only — gateway is not exposed to the network.
- **Port:** `18789` (default) — accessible only from localhost.
- **Mode:** `local` — no remote connections accepted.

## Filesystem Scope

- **Workspace:** `/Users/henr/dev/agent-work` — all agent operations are restricted to this directory.
- **Permissions:** All workspace directories are `700` (owner-only read/write/execute).
- **Config file:** `~/.openclaw/openclaw.json` is `600` (owner-only read/write).

## Skills

- **Local skills only:** Skills are loaded from `/Users/henr/dev/agent-work/skills` via `skills.load.extraDirs`.
- **No remote registry:** ClawHub and remote skill registries are not configured. No `clawhub install` commands should be run.
- **Bundled skills:** Allowed (`allowBundled: true`) as these ship with the verified npm package.

## Channels

- **No channels connected by default.** The onboarding wizard was configured with minimal channel access.
- **DM policy:** When channels are added, use `"dmPolicy": "pairing"` (require pairing code approval).
- **No browser control:** Not enabled.

## Credentials

- **No production credentials** are stored in this workspace or config.
- **No long-lived tokens** beyond what OpenClaw's daemon requires for local gateway operation.
- **API keys** should be set via environment variables, not stored in `openclaw.json`.

## Ongoing

- Run `openclaw security audit --deep` periodically.
- Run `openclaw doctor` after any config changes.
- Review this file when adding channels or tools.
