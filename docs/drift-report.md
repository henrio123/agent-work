# Domain Leakage Drift Report

**Generated:** 2026-02-20
**Engine repo:** `/Users/henr/dev/agent-work`
**Baseline:** 657 tests, 35 suites, commit `8a2bc3b`

## Summary

The engine contains **152 domain-specific references** that prevent it from being a general-purpose goal-driven execution engine. No project names (BARGER, etc.) leak into engine code — that was cleaned in commit `40ad744`. The remaining leakage is structural: the pipeline assumes a booking-flow UX audit workflow.

| Pattern | Count | Severity | Location |
|---------|-------|----------|----------|
| `booking` | 119 | High | Scripts, tests, templates |
| `ux-ready` | 26 | High | Core pipeline, tests, schema |
| `barber` | 6 | Medium | Scripts, tests, templates |
| `barger` | 1 | Low | Script example in comment |

## Detailed Inventory

### 1. Core Pipeline (`dev-pipeline.js`)

**`ux-ready` stage hardcoded in STAGE_CONFIG** (lines 587-594)
- `pm-ready.next` points to `ux-ready`
- `ux-ready` entry defines role=UX, artifact=15-ux-audit.json
- This forces ALL projects through a UX audit stage, regardless of goal

**`15-ux-audit.json` in ARTIFACT_SCHEMA_MAP** (line 628)
- Maps to `ux-audit.schema.json`
- Validated by core `validateArtifact()` — domain schema in core gating

**Migration:** Remove `ux-ready` from core STAGE_CONFIG. Make stage chain configurable per-workspace via `.claw/pipeline.json`. Default chain: `intake → analyze → plan → implement → validate → review → done`.

### 2. Context Pack Generator (`generate-context-pack.js`)

**119 "booking" references across 550 lines.** This script is entirely domain-specific:
- Hardcoded `booking-flow` as only supported focus (line 490, 497, 501)
- Scans `src/app/book/` directory structure (line 192-210)
- Looks for `src/lib/analytics/booking.ts` (line 304)
- API patterns: `['appointments', 'customers', 'services', 'barbers', 'slots', 'shops']` (line 278)
- Translation key filter: `/book|service|barber|time|slot|confirm|appointment|cancel|reschedule|upsell/i` (line 338)
- Output field names: `booking_pages`, `booking_components`, `booking_api`, `called_from_booking`, `keys_used_in_booking`, `events_used_in_booking`

**Migration:** Refactor into a generic project introspection tool with pluggable focus detectors. Move booking-specific logic into `ux_audit` capability plugin. Generic scanner should detect: routes, components, API calls, i18n keys, analytics events — without assuming what they're for.

### 3. Templates

**`claude-ux-pack.txt`** — 4 booking references, 1 barber reference
- Line 10: "Produce a UX audit of the booking flow"
- Line 22: References `booking-flow.context.json`
- Line 50-51: Hardcoded routes `/book`, `/book/barber`, etc.

**Other templates** (`claude-pm-pack.txt`, `claude-arch-pack.txt`, etc.) — Domain-neutral. These use `{{TICKET_ID}}`, `{{TITLE}}`, `{{PROJECT_NAME}}` placeholders only.

**Migration:** Move `claude-ux-pack.txt` to capability plugin `ux_audit/templates/`. Core templates stay.

### 4. Schemas

**`ux-audit.schema.json`** — 1 `ux-ready` reference in description
- Line 4: "required artifact for the ux-ready pipeline stage"
- Schema structure is actually domain-neutral (findings, severity, routes)

**Other schemas** (`pm-brief`, `arch-design`, `dev-notes`, `qa-report`, `review-report`) — Domain-neutral.

**Migration:** Move `ux-audit.schema.json` to `ux_audit` capability plugin `schemas/`. Update description. Core schemas stay.

### 5. Shell Wrappers

**`generate-context-pack.sh`** — 2 booking references in comments
- Line 3: "Generate a context pack for a booking flow"
- Line 4: Usage example with `--focus booking-flow`

**Migration:** Update comments to be generic. Or move entire script to capability.

### 6. Tests

**`test-generate-context-pack.js`** — 38 booking references
- Creates mock Next.js project with `src/app/book/` structure
- Tests `booking-flow` focus exclusively
- Asserts on `booking_pages`, `booking_components`, `called_from_booking`, etc.

**`test-create-ticket-and-backlog.js`** — 1 booking reference
- Line 125: `tags: ['booking', 'urgent']` in test fixture

**7 test files** — 26 `ux-ready` references
- `test-state-machine.js`: Stage chain assertions include `ux-ready`
- `test-run-next-safe.js`: Expects `advanced_to: 'ux-ready'`
- `test-role-leakage.js`: Tests UX agent role at `ux-ready` stage
- `test-role-enforcement.js`: Expects PM advance → `ux-ready`
- `test-responsible-agent.js`: Tests responsible agent at `ux-ready`
- `test-run-next-loop.js`: Task file number assertions (34 vs 33)
- `test-run-next-autonomous.js`: Task file number assertions

**Migration:** After core pipeline is domain-neutral, update all stage references. Context pack tests move to capability test suite.

### 7. Script Examples

**`create-ticket-and-backlog.js`** — 1 `barger` reference
- Line 12: Usage example `--project_id barger`

**Migration:** Change to generic `--project_id my-project`.

## Migration Plan

### Step 1: Domain-Neutral Core Stages

Replace STAGE_CONFIG with configurable stages. Default chain:

```
intake → task-pack-generated → analyze → plan → implement → validate → review → done
```

Stage config becomes:
```javascript
const DEFAULT_STAGES = {
  'analyze': { role: 'Analyst', requiredArtifacts: ['10-analysis.json'], taskFile: '31-analyze-task.txt', template: 'claude-analyze-pack.txt', next: 'plan' },
  'plan':    { role: 'Architect', requiredArtifacts: ['20-plan.json'], taskFile: '32-plan-task.txt', template: 'claude-plan-pack.txt', next: 'implement' },
  'implement': { role: 'Dev', requiredArtifacts: ['40-patch.diff', '41-impl-notes.json'], taskFile: '33-implement-task.txt', template: 'claude-implement-pack.txt', next: 'validate' },
  'validate': { role: 'QA', requiredArtifacts: ['50-validation.json'], taskFile: '34-validate-task.txt', template: 'claude-validate-pack.txt', next: 'review' },
  'review':  { role: 'Review', requiredArtifacts: ['60-review.json'], taskFile: '35-review-task.txt', template: 'claude-review-pack.txt', next: 'done' },
};
```

### Step 2: Workspace Pipeline Override

Load `.claw/pipeline.json` from workspace if present. Merges extra stages (like UX audit) into the chain at specified positions.

```json
{
  "stages": {
    "ux-audit": {
      "after": "analyze",
      "role": "UX",
      "requiredArtifacts": ["15-ux-audit.json"],
      "taskFile": "32-ux-task.txt",
      "template": "ux_audit/claude-ux-pack.txt",
      "schema_map": { "15-ux-audit.json": "ux_audit/ux-audit.schema.json" }
    }
  }
}
```

### Step 3: Capability Plugins

```
skills/capabilities/
  ux_audit/
    capability.json     — declares: stages, schemas, templates, detector
    templates/
      claude-ux-pack.txt
    schemas/
      ux-audit.schema.json
    scripts/
      generate-context-pack.js   (refactored: generic introspection)
    tests/
      test-generate-context-pack.js
```

### Step 4: Backward Compatibility

Existing runs with `pm-ready`, `ux-ready`, `arch-ready` stage names continue to work via a migration map:

```javascript
const STAGE_MIGRATION = {
  'pm-ready': 'analyze',
  'ux-ready': null,  // capability-injected, skip if not loaded
  'arch-ready': 'plan',
  'dev-ready': 'implement',
  'qa-ready': 'validate',
  'review': 'review',
};
```

`normalizeStatus()` already exists — extend it to remap old stage names.

### Step 5: Test Updates

- Core tests: Assert domain-neutral stage names
- Capability tests: Assert UX-specific behavior in capability test suite
- ~40 test assertions need updating across 8 test files
