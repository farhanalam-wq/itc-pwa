# Sub-agent implementation strategy

## Purpose

Use sub-agents to move independent work forward at the same time while keeping one coherent product, data model, and integration path. Delegation is for bounded implementation or review tasks; the lead agent remains accountable for scope, shared contracts, integration, and the final demo flow.

This document maps agents to the phases in [implementation-plan.md](implementation-plan.md). It does not authorize feature implementation by itself; a phase starts when the user asks to proceed and its entry conditions are met.

## Roles

There are four active slots in this environment, including the lead, so plan for no more than three concurrent sub-agents.

| Role | Primary ownership | Does not own |
| --- | --- | --- |
| Lead / integrator | Phase sequencing, user-facing decisions, shared contracts, dependency and lockfile changes, integration, final review, release commits | Parallel edits to every feature area |
| API and platform agent | Elysia routes, persistence, S3 authorization/completion, analysis job orchestration, report endpoints, API operational states | PWA screens or chart layout |
| Field PWA agent | Mobile capture flow, MediaRecorder behavior, OPFS/IndexedDB queue, service worker, sync UI and recovery | Server credentials, API contract definitions, dashboard aggregates |
| Manager reporting agent | Manager IA, conversation review, ApexCharts package/options, filter and drill-down behavior, accessible data alternatives | Audio capture or server-side analysis truth |

When work does not fit these lanes, create a short-lived specialist task with a narrow file boundary instead of creating another permanent role.

## Phase-to-agent allocation

| Plan phase | Lead / integrator | API and platform agent | Field PWA agent | Manager reporting agent | Parallelism and merge point |
| --- | --- | --- | --- | --- | --- |
| 0 — Workspace and context | Completed scaffold, package graph, project instructions, initial commit | — | — | — | Complete; commit `0cb38db` |
| 1 — Domain, API contracts, persistence | Own and approve domain vocabulary, entity lifecycle, shared contract package, migration decisions | Implement Elysia app composition and persistence only after contract shape is agreed | Review capture fields and local-to-server lifecycle; do not edit shared domain types | Review insight/report dimensions and identify dashboard query needs | Contract definition is serial. API implementation can start after contract approval; UI feature work waits on the same contract. |
| 2 — Design foundations | Confirm product truth, approve decisions needing user input, integrate shared UI package | Keep API work limited to stable contracts and health/persistence foundations | Review field constraints, device states, and capture usability | Lead shared UI/tokens and manager information hierarchy using Impeccable guidance | Shared tokens and UI primitives have one owner. The field and manager surface briefs can be prepared in parallel, but final shared tokens are merged once. |
| 3 — Field capture PWA | Lock contract and navigation boundaries | Provide reference data/session requirements when asked | Own the field route, capture states, history view, permissions, and PWA shell | Keep manager work in its own app/package | PWA can proceed independently after domain/capture contract and design foundation are stable. |
| 4 — OPFS and S3 synchronization | Own upload state machine, idempotency rules, and cross-client acceptance | Own presigned URL/completion endpoints, object metadata, and server-side verification | Own OPFS writes, IndexedDB queue, retry/resume, online/offline states | Continue report UI only against agreed server states | API and PWA implementations run in parallel on separate files/worktrees; merge at the upload protocol boundary, then integrate end to end. |
| 5 — Transcription and insight pipeline | Resolve provider/language/consent decisions with the user; approve schema and evidence requirements | Own job lifecycle, provider adapters, normalized transcript/insight persistence, retry and error states | Add analysis state visibility to history and recovery screens | Define report fixtures and report semantics from the typed insight schema | API pipeline and reporting semantics can advance in parallel after insight schema is frozen. PWA only consumes status contracts. |
| 6 — Manager reporting and ApexCharts | Own report API shapes, calculation definitions, access rules, and aggregate reconciliation | Own report endpoints and query performance | No broad PWA work; fix only agreed sync-to-manager links | Own dashboard pages, chart package, filters, evidence drill-downs, tables and exports | Report API and manager UI can run in parallel after endpoint shapes are approved. Integration uses one seeded dataset and reconciled totals. |
| 7 — Integrated demo readiness | Own scenario, seed/reset path, runbook, story, integration, and final scope | Resolve API/provider integration issues | Validate offline recording-to-sync demo path and repair field-specific issues | Validate finding-to-quote-to-conversation drill-down and repair reporting issues | Use short fix waves with exclusive file ownership, then one integrator merge and presenter walkthrough. |
| 8 — Hardening and handoff | Own release gate, operational readiness, documentation, and final decisions | Review authorization, storage, API errors, retention hooks, provider operations | Review offline resilience, mobile usability, storage pressure, consent and sync failure states | Review accessibility, chart alternatives, filtering, low-sample reporting and performance | Run focused reviews in parallel; lead closes findings and records unresolved risks before deployment. |

## Dependency and concurrency rules

1. **Freeze shared contracts before parallel feature work.** The lead owns `packages/domain`, `packages/contracts`, route names, upload/analysis state names, and report denominators. Agents propose changes through a small contract change request instead of independently changing those files.
2. **One owner per shared file at a time.** `bun.lock`, root `package.json`, `turbo.json`, `tsconfig.base.json`, `DESIGN.md`, global navigation, and shared tokens have one designated writer. The lead applies shared dependency changes with Bun after reviewing the request.
3. **Partition by app and package.** The field agent primarily changes `apps/field-pwa`; the reporting agent changes `apps/manager` and `packages/charts`; the API agent changes `apps/api`. Cross-package work is called out in the task brief before it begins.
4. **Use separate worktrees for concurrent implementation where available.** If agents share a checkout, name exact owned files and avoid concurrent writes in the same directory. Do not let two agents merge or rebase the same branch at once.
5. **No dependent work ahead of its contract.** In particular, PWA sync cannot invent server upload semantics, report charts cannot invent aggregate definitions, and analysis cannot invent product taxonomies. These are clarified by the lead before parallel tasks start.
6. **No unresolved assumptions in user-visible claims.** Provider selection, language coverage, consent wording, retention, and ApexCharts licensing remain explicit gates. Agents can build interfaces around approved abstractions while those decisions are pending, but cannot claim the integration is live.

## Delegation packet

Every sub-agent task should carry:

- **Task ID and phase:** for example `P4-FIELD-02`.
- **Outcome:** one concrete user-visible or system behavior.
- **Prerequisites:** approved contract/schema, design direction, provider choice, or dependency task.
- **Owned paths:** files the agent may change and files it must leave to another owner.
- **Acceptance conditions:** observable outcomes tied to the phase exit criteria.
- **Constraints:** Bun-only package operations, evidence-backed insights, synthetic-data labeling, accessibility, privacy, and approved design rules as applicable.
- **Verification expected:** type check/build or specified manual path; do not broaden scope to unrelated work.
- **Handoff format:** summary, changed paths, commands run and results, design/API decisions, unresolved items, and commit hash if the task was assigned a branch/worktree.

Example task brief:

> P4-FIELD-02 — Implement the local offline recording queue. Own `apps/field-pwa/src/storage/**` and the related field screen states only. Use the approved `RecordingMetadata` and upload-state contract; request changes to shared types instead of editing them. Acceptance: a stopped recording survives reload while offline, appears in history as queued, and reports errors without losing the file. Use Bun only. Return changed paths, verification results, recovery limitations, and any contract change requests.

## Review and integration protocol

1. Lead writes a short phase task map and assigns disjoint ownership.
2. Agents inspect the current branch and their relevant skill references before editing: Elysia skill for API work and Impeccable for UI work.
3. Agents report contract questions early. The lead resolves shared decisions before agents build on assumptions.
4. Each handoff is reviewed against its task acceptance conditions, assigned paths, product truth, and phase exit criteria. A successful type check/build does not replace product-flow review.
5. Integrate one dependency layer at a time: shared schema → API and local queue → transcription/insight pipeline → report endpoints/UI → full demo.
6. The lead resolves conflicts, reruns the relevant workspace checks, inspects the integrated behavior, and records the phase decision.
7. Keep integration commits small and conventional. Do not merge a feature commit that silently changes shared contracts or lockfile state.

## Commit convention

Use one conventional commit per cohesive task or reviewed integration unit:

- `feat: add OPFS recording queue`
- `fix: resume upload after connection recovery`
- `chore: pin Elysia and Bun workspace dependencies`
- `docs: define sub-agent delivery strategy`

The subject starts with `feat`, `fix`, `chore`, or `docs`, followed by a colon and a concise action. Prefer a specific outcome over `done task`. Agents may create commits only in their assigned isolated branch/worktree; the lead owns integration commits on the main working branch.

## Work distribution for the first implementation waves

### Wave A — Contracts and storage foundation

- Lead: settle visit, recording, transcript, insight, and report contracts; define stable state transitions.
- API agent: implement the health/reference/recording API skeleton and persistence migration after contract approval.
- Manager agent: map the insight schema to reporting queries and produce the conversation detail/data-view plan; do not build charts against placeholder metrics.
- Field agent: document capture and permission states against the contract; wait to implement the queue until state names are frozen.

### Wave B — Two product surfaces

- Lead: coordinate Impeccable design decisions and lock the shared token/component rules.
- Field agent: implement capture, history, and baseline PWA behavior.
- Manager agent: implement manager shell, insight drill-down, and accessible reporting components with synthetic fixtures.
- API agent: complete stable read/write endpoints and demo seed/reset path.

### Wave C — Offline-to-analysis vertical slice

- API agent: S3 authorization, upload completion, analysis job states, transcription and insight provider adapters.
- Field agent: OPFS/IndexedDB write, queued upload, retry/resume, sync state, and recovery UI.
- Manager agent: analysis state, evidence quotes, confidence, and filters driven by the final insight/report API.
- Lead: lock the upload protocol and provider contract, then connect the PWA, API, and manager in one vertical slice.

### Wave D — Reporting depth and demo closure

- Manager agent: ApexCharts views for demand, objections, pricing/competitors, availability, sentiment cues, visit outcomes, follow-up aging, and coaching rubric; provide linked tables and drill-downs.
- API agent: calculate and validate report aggregates and distinct-visit denominators; expose filtered report endpoints.
- Field agent: validate offline, interrupted recording, app restart, and reconnect scenarios; fix only field-owned behavior.
- Lead: reconcile seeded numbers, run the presenter walkthrough, close integration issues, and document provider/license decisions.

## Decision and phase gates

- Do not fan out implementation work while core domain names or upload state transitions are changing.
- Do not build production model integrations before the user has selected approved providers, languages, and credentials. Demo fixtures can be prepared in parallel, clearly labeled as synthetic.
- Do not ship a new visual world from a generic agent prompt. Use the Impeccable workflow for surface direction and review before feature styling.
- Do not represent ApexCharts use as cleared for distribution until the applicable ITC license tier is confirmed.
- The user can steer the number of simultaneous agents. Default to the smallest set that has truly independent file ownership and clear phase dependencies.
