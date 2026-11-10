# ADR-0021 — WMS release gate as code (status JSON + guard + rendered Markdown)

Status: Accepted (v0.6.0). Owning module: release management.

**Context.** The product owner's WMS Production Readiness Gate v0.6 and Continuation Prompt v0.6
require a release-gate state machine (`WMS_IN_PROGRESS` → `WMS_RELEASE_CANDIDATE` →
`WMS_PRODUCTION_READY` → `AWAITING_NEXT_MODULE_SELECTION` → `NEXT_MODULE_AUTHORIZED`) with, per
criterion, required result, method, evidence, date, reviewer, status (PASS/FAIL/BLOCKED/NOT_RUN)
and open action — and forbid advancing the state on self-reported success.

**Decision.** `docs/WMS_RELEASE_STATUS.json` is the single source of truth. `scripts/wms-gate.mjs`
(`pnpm gate:check`, run by `test:all` and CI) fails closed when: a PASS lacks evidence, date or
reviewer; a state of production-ready or later is set while any criterion is not PASS or without a
named release-owner approval and an independent security-review reference;
`NEXT_MODULE_AUTHORIZED` lacks the user's module choice; a release candidate still has FAIL items;
or the Markdown rendering (`docs/WMS_RELEASE_GATE.md`, `pnpm gate:render`) is stale.
`tests/security/release-gate.test.ts` proves those refusals. "PASS" means reproducible automated
evidence self-verified by the developer, never an independent sign-off.

**Alternatives.** A hand-edited Markdown checklist (drifts, no enforcement); a GitHub Projects
board (not in the archive, not reviewable offline).

**Maintenance.** Edit the JSON, run `pnpm gate:render`, commit both. Add criteria by appending
objects with a new id; never delete a criterion — mark it superseded in `openAction`.
