# ADR-0005 — Explicit composition root; no decorator-metadata DI

Status: Accepted. Owning module: platform.

**Decision.** Services are plain classes built once in `composition.ts`; Nest controllers
receive the container through one token with explicit `@Inject`. `emitDecoratorMetadata`
is off; validation uses Zod, not class-validator.
**Why.** Works identically under tsc, tsx (esbuild) and Vitest (oxc); the dependency graph is
visible in one file; services are trivially testable.
**Trade-off.** Less Nest 'magic' (no per-request providers); acceptable for a modular monolith.
