# ITC Field Source

A Bun-managed Turborepo workspace for the Field Source Manager proof of concept.

## Workspace

- `apps/field-pwa` — field recording PWA shell
- `apps/manager` — manager reporting dashboard shell
- `apps/api` — Elysia 2 RC API shell
- `packages/domain` — shared field, recording, transcript, and insight types
- `packages/contracts` — request and response schemas shared by API and clients
- `packages/api-client` — typed browser client for the Elysia API
- `packages/ui` — shared UI foundations
- `packages/charts` — shared ApexCharts types, options, and reporting visualizations
- `packages/demo-data` — explicitly synthetic demo fixtures
- `docs/implementation-plan.md` — phase-by-phase delivery plan and acceptance gates

## Requirements

- Bun 1.4 or later
- Network access to the configured package registry for the first install

## Start

Run `bun install`, then `bun run dev`. The apps are intentionally placeholder shells at this stage; the feature work is sequenced in the implementation plan.

Useful focused commands:

- `bun run dev:field` — field PWA shell
- `bun run dev:manager` — manager shell
- `bun run dev:api` — Elysia API shell
- `bun run typecheck` — workspace TypeScript checks
- `bun run build` — workspace production builds

## Design and product context

Read `PRODUCT.md` and `DESIGN.md` before building UI. The Impeccable skill and the Elysia skills are intended as project-local agent guidance once installed.

All seeded examples must be labeled synthetic. Do not imply that a newly recorded conversation was transcribed or analyzed unless a configured provider completed those jobs.
