# ADR-0018 — pnpm 12 supply-chain policy and release-age exclusions

Status: Accepted. Owning module: tooling.

pnpm 12 blocks dependencies published within its minimum release age and lifecycle scripts by
default. Only esbuild may run install scripts (`allowBuilds`). Same-day patch releases of
NestJS 12.4.2, Vite 8.3.7 and rolldown 1.2.18 (published across several major lines on
2026-11-09, typical of security fixes) were excluded from the age gate; re-evaluate after 7 days
(SEC-OPEN-011).
