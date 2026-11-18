# Implementation plan

## 1. Outcome and product boundary

Build a demo-ready, typed monorepo with two connected product surfaces: an offline-capable field recording PWA and a managerial conversation reporting dashboard. The core proof is that a field conversation can be preserved through loss of connectivity, synchronized safely, transcribed, converted into structured, evidence-backed signals, and reviewed by a manager.

The demo must distinguish three states that are easy to conflate:

1. A recording is present on the device.
2. Its audio has reached the configured object store.
3. Transcription and analysis have completed and the report is reviewable.

An uploaded recording is not automatically an analyzed conversation. Synthetic fixtures must be labeled, and live audio must not be shown with invented transcript or insight results.

## 2. Current stack and workspace boundaries

- **Workspace/package manager:** Bun workspaces and Bun lockfile; no Corepack or pnpm.
- **Task graph:** Turborepo for workspace builds, type checks, and parallel development servers.
- **Web apps:** React, TypeScript, and Vite; separate manager and field PWA deployments.
- **API:** Elysia 2 release candidate on Bun, with request/response validation defined from shared schemas. Pin the resolved version in bun.lock and recheck its official docs when the package lock changes.
- **Visualization:** ApexCharts through React-ApexCharts, wrapped in the shared typed charts package.
- **Typography:** Hanken Grotesk, bundled locally.
- **Shared packages:** domain, contracts, API client, UI, charts, and synthetic demo data.
- **Agent guidance:** project-local Impeccable and Elysia skills; product/design context lives in PRODUCT.md and DESIGN.md.

The committed Bun lockfile records the exact dependency graph. This scaffold resolves Bun 1.4.2, Turborepo 2.11.12, Vite 8.3.8, and Elysia 2.0.0-rc.3. Elysia 2 is still a release candidate, so re-evaluate the pin once a stable release is available before production deployment.

The web clients use the API as the shared source of truth. OPFS is a device-side durable queue for audio bytes, not a cross-device data store. The server owns uploaded recording metadata, analysis jobs, transcripts, insights, and manager reporting.

## 3. Phase map

| Phase | Name | Main result | Depends on |
| --- | --- | --- | --- |
| 0 | Workspace and project context | Bun/Turborepo skeleton, app shells, shared packages, design and product briefs | Current task |
| 1 | Domain, API contracts, and persistence | Typed models, Elysia route layout, database schema, local demo seed | 0 |
| 2 | Design system and visual foundations | Impeccable-informed design rules, reusable accessible UI, Hanken typography | 0–1 |
| 3 | Field capture PWA | Installable mobile workflow with record, pause, stop, and history | 1–2 |
| 4 | Offline storage and upload sync | OPFS/IndexedDB queue and retry-safe S3 transfer | 1, 3 |
| 5 | Transcription and conversation insight pipeline | Audio-to-transcript-to-structured insight job lifecycle | 1, 4 |
| 6 | Manager reporting and ApexCharts | Evidence-first overview, drill-downs, filters, and chart suite | 1, 2, 5 |
| 7 | End-to-end demo readiness | Seeded story, offline demonstration controls, integrated walkthrough | 3–6 |
| 8 | Hardening and deployment handoff | Operational, privacy, accessibility, and deployment readiness | 3–7 |

## 4. Phase 0 — Workspace and project context

**Status:** completed in this scaffold task. Later phases remain planned and are not implemented yet.

### Work

- Pin Bun in the root package manifest and define apps/* and packages/* workspaces.
- Configure Turborepo tasks for persistent dev servers, dependency-aware builds, type checks, and clean-up.
- Create app shells for field PWA, manager dashboard, and Elysia API, with distinct ports and focused Bun scripts.
- Create typed package boundaries for domain models, API contracts/client, shared UI, charts, and demo fixtures.
- Establish PRODUCT.md and DESIGN.md so later UI and reporting work shares one user and design context.
- Add the user-requested skills with the requested commands: npx skills add pbakaus/impeccable for design guidance and bunx skills add elysiajs/skills for Elysia guidance. Review the resulting skill instructions before following them; preserve the install/lock metadata if the CLI creates it.
- Generate and commit bun.lock after registry access is available. The environment must not silently fall back to npm, pnpm, or Corepack.

### Exit criteria

- Bun recognizes all workspace packages and can run the three app dev scripts.
- Turbo sees the same workspace graph and package dependency edges.
- Each app and package has TypeScript settings and named scripts.
- Product and design briefs state the intended audience, evidence policy, typography, and field workflow.
- Skill installation result and dependency lock status are documented. If a protected skill directory or registry access blocks installation, report that limitation rather than claiming the skill is installed.

## 5. Phase 1 — Domain, API contracts, and persistence

### 5.1 Domain model

Define shared, versionable entities before building the screens:

- **Visit:** representative, outlet, territory, start/end time, consent event, visit context, and declared outcome.
- **Recording:** stable recording ID, local/device ID, MIME type, byte length, duration, OPFS filename, S3 object key, checksum, upload state, and analysis state.
- **Transcript segment:** segment ID, speaker label, start/end offsets, text, language, and speech recognition confidence.
- **Insight:** category, normalized entity/value, countable signal, source recording/segment references, extracted quote, confidence, suggested action, model/provider metadata, review state, and correction history.
- **Order/commitment:** source attribution, amount or product reference when stated, explicit versus inferred status, owner, and due date.
- **Analysis job and sync event:** idempotency key, attempts, timestamps, errors, and state transitions for operational visibility.

Avoid putting API SDK objects, browser handles, or chart-library types in the domain package.

### 5.2 API shape

Design typed Elysia 2 route groups for health, authentication/session, reference data, visits, upload authorization/completion, recording status, transcripts, insights, and manager reports. Use Elysia schemas for runtime validation, inferred TypeScript types, and generated API documentation from one contract source. Add pagination and explicit filters to list/report endpoints. Follow the Elysia v2 skill and current v2 documentation rather than applying v1 examples.

Suggested initial routes:

- GET /health
- GET /v1/me and GET /v1/reference-data
- POST /v1/visits and POST /v1/visits/:visitId/recordings
- POST /v1/recordings/:recordingId/upload-authorizations
- POST /v1/recordings/:recordingId/upload-complete
- GET /v1/recordings and GET /v1/recordings/:recordingId
- GET /v1/recordings/:recordingId/transcript and GET /v1/recordings/:recordingId/insights
- GET /v1/reports/overview, /signals, /outcomes, /team, and /follow-ups

### 5.3 Persistence

Choose a relational schema with explicit migrations. Separate the audio object in S3 from searchable metadata and analysis records in the database. Start with synthetic seed data for the manager report and deterministic IDs so demo views are repeatable. Keep a local-development configuration separate from deployed credentials.

### Exit criteria

- Shared types describe the lifecycle from visit capture through analyzed insights.
- Elysia validates input and response shapes at route boundaries.
- A seeded report can be returned by the API without relying on chart or UI code.
- Each insight points back to one or more transcript segments or is explicitly marked as unavailable/unverified.

## 6. Phase 2 — Design system and visual foundations

### Work

- Apply the Impeccable skill’s product-aware design workflow: inspect the product context, establish hierarchy, critique the result, and record reusable decisions in DESIGN.md.
- Treat both products as Operate surfaces. Use the Impeccable new-work workflow to settle each surface’s composition before implementing feature UI; the shell CSS is not the final visual direction.
- Bundle Hanken Grotesk locally so typography survives offline app-shell use.
- Define tokens for color, type scale, spacing, borders, focus, elevation, status, and chart series.
- Build shared accessible primitives: app shell, navigation, buttons, form fields, status badges, tables, empty/loading/error states, filter controls, drawers, and evidence/quote blocks.
- Make manager desktop-first but responsive; make field capture mobile-first, thumb-reachable, and usable in bright outdoor conditions.
- Keep charts visually subordinate to their finding and show a table or text equivalent for important data.

### Exit criteria

- Both apps use the same token vocabulary and Hanken font assets.
- Keyboard focus, contrast, labels, error feedback, reduced-motion behavior, and narrow-screen behavior are addressed in shared primitives.
- The field recording action remains the strongest visual affordance on the capture screen.
- The dashboard gives the user a clear reading path from aggregate finding to the visits and quotes supporting it.

## 7. Phase 3 — Field capture PWA

### Capture flow

- Resolve representative identity from the session; allow outlet selection/search and optional route/visit context.
- Capture an explicit consent acknowledgment and timestamp before recording. The final wording and jurisdictional policy must be supplied by ITC before real field use.
- Request microphone access only after a user gesture; show denied, unavailable, and interrupted states.
- Support start, pause, resume, stop, elapsed time, and clear recording state. Prevent accidental second active recordings.
- Save a visit/recording record even when the audio is short or the network drops.
- Provide history with duration, outlet, time, local/upload/analysis state, retry action, and delete action according to retention policy.
- Include an optional development-only offline toggle for a controlled demo; also validate true browser offline mode.

### PWA behavior

- Add manifest, icons, service worker, app-shell caching, update handling, install affordance, and offline-safe routes.
- Cache the assets required to reopen capture/history; avoid caching authenticated API responses or transcripts without an explicit privacy design.
- Explain local storage state, available quota, and what happens when device storage is low.

### Exit criteria

- A representative can record a short audio visit and find it in history after reload.
- Recording control state remains correct through pause/resume and error interruptions.
- The interface never reports a remote upload or analysis result before the server confirms it.

## 8. Phase 4 — OPFS durability and S3 synchronization

### Local-first storage

- Stream MediaRecorder blobs into an OPFS file rather than retaining the entire audio in memory.
- Store metadata, chunk offsets/checkpoints, idempotency keys, and retry scheduling in IndexedDB.
- Use storage persistence where available and detect OPFS/quota support. If the required browser capability is absent, show a clear fallback or block recording with an explanation; do not claim OPFS durability when using a weaker path.
- Finalize metadata only after the file writer closes successfully; recover incomplete files after a browser crash.

### Upload protocol

- Ask the Elysia API for a short-lived pre-signed S3 upload authorization.
- Use retryable multipart/chunk upload for recordings large enough that a single transfer is fragile; persist part IDs and completed offsets locally.
- Include a checksum and server-validated content metadata. The API verifies the upload completion event and transitions the server record.
- Resume on app launch and online/network recovery; use bounded exponential backoff with jitter, cancellation, and a visible manual retry.
- Make completion idempotent. Do not mark a recording synced merely because the browser initiated the PUT.
- Keep S3 bucket credentials and provider secrets exclusively server-side; use least-privilege IAM and lifecycle/retention policies.

### Exit criteria

- A recording made offline survives app restart and later completes one server-recognized upload.
- A dropped transfer resumes or retries without duplicate recording metadata or corrupted audio.
- Local, uploading, remotely uploaded, transcription, and analysis states are separately visible.

## 9. Phase 5 — Transcription and conversation intelligence

### Provider boundary

Define TranscriptionProvider and InsightProvider interfaces. Use deterministic fixtures to exercise the pipeline in local demo mode. Choose the production/demo transcription and LLM providers after confirming approved vendor, data region, languages, privacy terms, and credentials. If AWS is the selected environment, the likely path is an S3-triggered asynchronous transcription job followed by a structured insight job; the provider adapters remain replaceable.

### Transcription pipeline

- Accept only completed, integrity-checked audio objects.
- Detect or configure language; evaluate English, Hindi, Kannada, and other field languages with ITC rather than assuming one language.
- Return timestamped speaker segments, language, provider/job IDs, and confidence where the provider supports them.
- Persist raw provider output separately from normalized transcript segments.
- Support failed, low-confidence, and partially complete states with a retry path.

### Insight extraction schema and taxonomy

For each conversation, extract the following with structured evidence and confidence. Preserve speaker and timestamp for each phrase, distinguish explicit statements from inference, account for negation, corrections, and code-switching, and normalize equivalent terms without losing the original words:

1. **Visit context and outcome:** visit purpose, order placed/no order/follow-up/new outlet, products discussed, explicit quantities or values.
2. **Retailer need and demand:** product/category, brand, SKU or variant, pack size, requested quantity, price point, preferred promotion, consumer ask, new-format request, purchase frequency, and whether it is an explicit request or a model inference.
3. **Availability and execution:** current stock statement, stock-out, assortment gap, shelf/display visibility, replenishment, delivery timing, product freshness/quality, and unresolved service issue.
4. **Objections and competitive context:** price/margin, discount, credit/payment cycle or days, competitor brand/product/price, product knowledge, perceived consumer demand, delivery, and other normalized categories. Preserve exact competitor names and stated amounts as entities.
5. **Interest and sentiment cues:** stated enthusiasm/hesitation, change during the conversation, and the transcript evidence that supports it.
6. **Commitments and next steps:** who promised what, due date if stated, manager/rep owner, and completion status.
7. **Conversation quality evidence:** whether the rep asked discovery questions, explained a benefit, addressed an objection, and agreed a close/next action. Any derived quality indicator must display the rubric and cited segments; it is a coaching aid, not an opaque person score.
8. **Opportunity signal:** potential value or probability only when backed by explicit data and a documented calculation; never merge inferred opportunity with booked sales.

Normalize products, packs, territories, objection labels, and outcomes so reports aggregate equivalent phrases. Store original quote and transcript segment IDs alongside normalized labels.

Keep both raw mention volume and distinct-visit prevalence. For example, five mentions in one visit are not five retailers with the same objection. Do not treat silence about a product, price, or concern as evidence of no demand or no objection. Normalize quantities, currency, dates, and pack units without discarding the spoken value, and keep conflicting statements visible for review instead of silently choosing one.

### Human review and quality gates

- Validate provider JSON against a strict schema and reject malformed/incomplete output.
- Require quote/segment provenance for every factual insight. Mark unsupported model statements as ungrounded and exclude them from aggregate counts.
- Store model name/version, prompt/schema version, processing time, confidence, and review/correction events.
- Provide manager correction and feedback capture in the conversation detail view.
- Keep identifiable audio/transcript access role-controlled; make retention and deletion behavior explicit.

### Exit criteria

- A seeded or provider-processed conversation has transcript segments and multiple typed insights with traceable quotes.
- Failed transcription/analysis does not block access to the recording or other dashboard data.
- Aggregate metrics count only valid, deduplicated insight records and communicate sample size/confidence.

## 10. Phase 6 — Manager reporting dashboard and ApexCharts

### Information architecture

- **Overview:** field pulse, high-value findings, team activity, sync/analysis health, and due follow-ups.
- **Conversation intelligence:** recurring demand/objection/availability/competitor themes with time and territory drill-down.
- **Conversation review:** transcript with audio playback, timestamp navigation, speaker labels, insight evidence, confidence, and review controls.
- **Team and territory:** aggregate coverage and coaching signals with minimum sample thresholds and evidence access.
- **Recordings and follow-ups:** upload/analysis pipeline, unresolved commitments, and exceptions requiring attention.

### ApexCharts visual suite

All charts must use shared typed option builders in @itc/charts, controlled color semantics, responsive breakpoints, tooltips with definitions, empty states, and synchronized report filters. Charts are a view of validated report API data; chart code does not compute business truth.

1. **Field pulse KPI strip:** visits, unique outlets, confirmed orders, follow-ups due, opportunity estimate (separate), analysis completion, and median sync lag. Show comparison window and denominator.
2. **Visit outcome funnel:** completed visits to explicit order, follow-up, and no-order outcomes; distinguish missing/unknown outcomes.
3. **Visit and analysis trend:** daily/weekly stacked bars for captured, uploaded, transcribed, analyzed, and failed visits, paired with time-to-sync/analyze line.
4. **Demand signal matrix:** heatmap of territory × product/category or pack-size request count, with outlet count, confidence, and minimum-sample handling.
5. **Objection mix:** horizontal ranked bars for objection categories, distinct-visit count, raw mention count, share of analyzed visits, and filter-by-category behavior.
6. **Objection trend:** stacked area or small-multiple line trends over the selected time range to show whether credit, margin, stock, or competitor objections are rising/falling.
7. **Retailer need and product mention:** ranked product/pack requests with explicit/inferred split, territory drill-down, and trend.
8. **Conversation sentiment distribution:** stacked bars/area by time or territory; never imply clinical emotion measurement, and show that these are model-labeled conversation cues.
9. **Follow-up aging:** due/overdue counts and age buckets, with drill-through to the commitment quote and owner.
10. **Conversation quality rubric:** transparent component distributions (discovery, benefit explanation, objection response, close/next step), evidence count, and confidence. Avoid leaderboard rankings by default.
11. **Competitor and pricing signals:** mentions of competing brand/product, quoted competitor price, discount/margin pressure, and trend by territory, shown only when a quote supports the extracted value.
12. **Evidence-backed insight cards:** concise narrative, frequency, affected outlets/territories, confidence, representative quotes, and recommended manager action; open the underlying visits.

### Dashboard interactions

- Global date range, territory, representative, product, outcome, and insight category filters.
- Chart selections update the related table or insight list and can be cleared visibly.
- Every visual has an accompanying accessible summary/table and CSV export of the currently authorized filtered data.
- Use explicit denominators and sample sizes; suppress or mark low-sample comparisons.
- Separate captured date, upload date, transcription date, and analysis date in reporting filters where relevant.
- Preserve filter state in URL/search parameters for shareable review links, subject to authorization.

### ApexCharts licensing gate

Before distribution, confirm ITC’s ApexCharts license terms for the intended commercial use. Current vendor terms distinguish community, commercial, and OEM redistribution rights; building an externally distributed chart-enabled product may require OEM rights. Keep the product’s own report data model and chart configuration separate from the library so another chart renderer can be substituted if procurement or legal review requires it.

### Exit criteria

- Dashboard cards and charts reconcile to the same report API aggregates.
- Selecting a data point lands on the exact supporting insight/visit set.
- Summary, sample size, confidence, and supporting evidence are available without relying on hover alone.
- The reporting view distinguishes orders from potential opportunities and fixture data from real records.

## 11. Phase 7 — Integration and demo readiness

### Demo story

1. Start in the manager overview and show a top-level field pulse.
2. Open one insight, such as repeated small-pack demand or a credit-cycle objection.
3. Filter by territory/product and show counts, affected outlets, confidence, and a transcript quote.
4. Open the conversation and jump from quote to timestamped transcript/audio.
5. Switch to the field app, capture a new short conversation, pause/resume, and stop.
6. Toggle offline or disable the network, capture a second visit, close/reopen the app, and confirm it remains queued locally.
7. Reconnect and show upload status, then explain the separate transcription and analysis states.
8. If credentials/provider config are unavailable, use a labeled synthetic report fixture; do not imply that the newly recorded sample produced that fixture insight.

### Integration work

- Verify both web apps point to the same Elysia API and that API events update dashboard state without refresh confusion.
- Add demo seed/reset controls behind an explicit demo-mode flag.
- Provide a one-command local start and environment template with safe example values only.
- Add a concise runbook for microphone permissions, offline simulation, seeded reports, and provider configuration.

### Exit criteria

- A presenter can follow the story without developer tools or hand-editing database records.
- The main path works on a laptop browser and a phone-sized viewport.
- Demo fixtures and any simulated transport are unmistakably labeled.

## 12. Phase 8 — Hardening and deployment handoff

- Validate authorization at every recording, transcript, insight, and report endpoint.
- Apply least-privilege S3 roles, short-lived upload URLs, encryption in transit/at rest, retention rules, and deletion propagation.
- Add audit events for recording access, transcript review/correction, insight overrides, and exports.
- Define service-level dashboards for upload failures, queue age, transcription latency, analysis failure, and provider cost.
- Test supported mobile browsers and OPFS behavior, including storage pressure, interrupted writes, app updates, airplane mode, and low connectivity.
- Document data residency, consent, retention, subject deletion, and incident response with ITC security/privacy stakeholders.
- Deploy PWA, manager, and API using environment-specific configs; add CI for lockfile installation, type checks, build, and security/dependency review.
- Set operational limits for audio size/duration, concurrent jobs, rate limits, and cost budgets.

## 13. Cross-cutting acceptance criteria

- A queued recording has one stable identity through local save, retry, object upload, analysis, and manager review.
- Managers can move from a chart or insight to the transcript evidence that generated it.
- All user-visible model findings communicate confidence and analysis state.
- Consent, recording access, retention, and deletion are not left to front-end conventions alone.
- The UI is accessible, responsive, and works offline for capture/history after initial load.
- Demo values and real uploaded/audio-derived values cannot be confused.
- Bun is the sole workspace and package manager; bun.lock is the committed dependency lock.

## 14. Decisions to resolve during the relevant phases

- Which transcription and insight providers are approved, and who supplies credentials?
- Which languages must the first demo recognize, and what language mix is realistic in a visit?
- What is the required consent language and retention/deletion policy?
- Which representative/outlet identifiers and sales taxonomies can be used in the demo?
- Does ITC already have an S3 account/bucket and an approved AWS region?
- What reporting data may be shown to which manager roles, and what minimum sample size is acceptable for comparisons?
- Which ApexCharts license applies to ITC’s internal demo and eventual customer-facing deployment?

## 15. Technical references

- Bun workspaces and install behavior: https://bun.sh/docs/pm/workspaces and https://bun.sh/docs/pm/cli/install
- Turborepo workspace setup and task graph: https://turborepo.dev/docs/getting-started/add-to-existing-repository
- Elysia 2 RC announcement and typed validation direction: https://next.elysiajs.com/blog/elysia-20-rc/ and https://next.elysiajs.com/essential/validation/
- ApexCharts React wrapper and version compatibility: https://apexcharts.com/docs/react-charts/
- ApexCharts current licensing terms: https://apexcharts.com/license/
- Impeccable design workflow: https://impeccable.style/
- Hanken Grotesk project and OFL details: https://github.com/marcologous/hanken-grotesk
