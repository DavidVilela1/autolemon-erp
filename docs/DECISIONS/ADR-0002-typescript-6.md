# ADR-0002 — TypeScript 6.0.3 instead of the 7.x baseline

Status: Accepted. Owning module: tooling.

**Context.** Baseline asked for TS 7.x. On 2026-11-09, typescript@7.0.2 (native compiler) is
latest, but typescript-eslint 8.72.1 declares peer `typescript >=4.8.4 <6.1.0`.
**Decision.** Pin TypeScript 6.0.3 (latest 6.x) for typecheck, build and lint.
**Alternatives.** TS 7 for tsc + TS 6 for eslint (two compilers, divergent diagnostics); drop
type-aware lint (weaker security linting).
**Risks.** Delayed adoption of TS 7 performance. **Maintenance.** Upgrade when typescript-eslint
supports 7.x; run the full suite.
