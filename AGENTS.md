# Repository instructions

- Use Bun for workspace/package operations and scripts. Do not use Corepack, npm, pnpm, or yarn to manage this repository.
- Before UI implementation, read PRODUCT.md, DESIGN.md, and the relevant Impeccable skill references in .agents/skills/impeccable.
- Before Elysia implementation, read the relevant Elysia skill references in .agents/skills/elysiajs and the official docs for the version in bun.lock.
- The current API scaffold is pinned to Elysia 2.0.0-rc.3. Keep the lockfile and implementation plan in sync when the framework version changes.
- Keep demo fixtures explicitly synthetic. Do not present fixture transcripts or insights as the result of a newly recorded conversation.
- Keep extracted findings linked to transcript evidence and confidence; distinguish confirmed orders from inferred opportunity.
