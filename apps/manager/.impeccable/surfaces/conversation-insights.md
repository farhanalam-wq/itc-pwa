# Conversation insights — Signal Desk

## Surface contract

- **Mode:** Operate.
- **User and task:** A Field Source Manager scans recent field conversations, finds a recurring retailer need, checks how many distinct outlets support it, reviews the exact transcript evidence, and chooses a grounded follow-up.
- **Success:** In the first viewport, the manager can distinguish mention volume from outlet reach, see the territory spread and confidence, open a supporting visit, and understand the suggested next action.
- **Composition:** Follow the user-selected Signal Desk sketch (`seed:06afd2f0971dce0f`). Keep a compact pulse and finding headline at the top; put the aggregate signal and territory spread in the main column; keep the selected signal's quote, source visit, confidence, and next action visibly attached at the right. Continue below the fold with deeper reporting and a non-chart data view.
- **Signature interaction:** Selecting a signal updates its evidence panel with the supporting quote, speaker, outlet, territory, timestamp, confidence, and visit link while retaining the distinct-outlet denominator. A visit link opens transcript review at the cited segment.
- **Data contract:** Demo data is synthetic and must be labeled as such. All counts derive from the typed fixtures/API response. A repeated mention can increase mention volume but never distinct visit or outlet prevalence. Do not imply an order, price, competitor identity, or model certainty beyond the transcript. New uploads without analysis remain in a processing state and never receive fabricated insights.
- **Report scope:** Demand and pack-size requests, availability and stock-outs, margin and credit objections, competitor/pricing mentions (with uncertainty retained), sentiment cues, explicit outcomes, follow-up commitments, and coaching evidence. Coaching is evidence-led and is not an employee score.
- **Visual direction:** Match the selected sketch's dark green navigation rail and light data canvas, with a restrained neutral palette, green for supported evidence, lime reserved for a selected/verified evidence marker, and amber for uncertainty or attention. Use locally bundled Hanken Grotesk throughout. No gradients, decorative chart effects, or nested card stacks.
- **Charts:** Use ApexCharts only for views backed by typed report data. Each chart has clear units, denominator, confidence/sample context, and a nearby accessible table or equivalent. Tooltips explain metrics; color has stable meaning across charts.
- **Responsive behavior:** Desktop uses the persistent navigation rail and two-column signal/evidence layout. At tablet widths the rail can collapse and the evidence column moves below the signal. At phone widths filters wrap, insight details stack, tables remain horizontally navigable or become labeled rows, and chart labels stay readable.
- **States:** Provide loading, empty-range, no-results, stale/offline, API error, partially analyzed, low-confidence, and fully synthetic-demo states. Never render sample counts as zero when the source is unavailable.
- **Accessibility:** Semantic headings/regions, keyboard-operable filters and evidence links, visible focus, reduced motion, sufficient contrast, non-color status cues, chart data alternatives, and transcript segment links with descriptive labels.

## User constraints

- Preserve product truth in `PRODUCT.md` and the typography commitment in `DESIGN.md`.
- The Signal Desk arrangement is locked for this manager surface; deeper reporting can add views without displacing that first reading path.
- No production transcription, S3, or model integration is represented as active in the POC.
