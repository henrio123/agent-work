# Domain Leakage Drift Report

**Updated:** 2026-02-20
**Engine repo:** `/Users/henr/dev/agent-work`
**Baseline:** 681 tests, 36 suites, commit `9864ae7`

## Summary

After Phase 1 (domain-neutral stage names, commit `ec05a69`) and Phase 2 (capability registry, commit `9864ae7`), pipeline stages are domain-neutral. Remaining domain leakage is in the context-pack generator, UX template/schema still in core, and tests using domain-specific fixtures.

| Pattern | Count | Severity | Location | Remediation |
|---------|-------|----------|----------|-------------|
| `booking` | ~80 | High | generate-context-pack.js, test, template | Refactor script to generic focus scanner |
| `ux-ready` | 2 | Low | STAGE_MIGRATION (backward compat) | Keep — needed for legacy run migration |
| `barber` | ~5 | Medium | Tests, template | Remove with context-pack refactor |
| `claude-ux-pack.txt` | 1 | Medium | Core templates/ dir | Move to ux_audit capability |
| `ux-audit.schema.json` | 1 | Medium | Core references/ dir | Move to ux_audit capability |

## Remediation Plan

### Phase 2: Migrate UX into capability (this commit)
1. Create `skills/capabilities/ux_audit/` with capability.json, templates/, references/
2. Move `templates/claude-ux-pack.txt` → capability (make template domain-neutral)
3. Move `skills/dev-pipeline/references/ux-audit.schema.json` → capability
4. Refactor `generate-context-pack.js` to generic focus scanner (no hardcoded booking)
5. Update `test-generate-context-pack.js` to use generic field names
6. Update `test-create-ticket-and-backlog.js` tag fixture
7. Update `tools/generate-context-pack.sh` comments

### Phase 3: Goal-driven capability selection (this commit)
1. Create `skills/dev-pipeline/scripts/goal-selector.js` — deterministic intent+stack→capability mapping
2. Create `tools/create-mission.sh` — writes .claw/missions/ and .claw/capabilities.json
3. Add stub capabilities: security_audit, performance_audit

### Verification Target
```
grep -rn "BARGER\|barger\|booking\|funnel" --include='*.js' --include='*.sh' --include='*.txt' --include='*.json' . | grep -v node_modules | grep -v drift-report.md
```
Should return 0 results after remediation.
