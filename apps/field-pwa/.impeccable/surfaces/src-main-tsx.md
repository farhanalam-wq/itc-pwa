---
version: 1
slug: "src-main-tsx"
primary_target: "src/main.tsx"
related_targets: []
---

# Field capture PWA — Session Board

## Surface contract

- **Mode:** Operate.
- **User and task:** A field sales representative records a consented shop visit from a phone, including when the network is unavailable.
- **Success:** The representative can confirm the outlet and consent, start, pause/resume, stop, and find the resulting local recording in history. The UI always distinguishes local OPFS storage, API metadata registration, media upload, and analysis.
- **Constraints:** Hanken Grotesk; phone-first; installed shell and local assets must load offline; OPFS audio plus IndexedDB metadata; no recording without explicit consent; no claims that S3 or transcription is active when configuration is absent. No audio or transcript is sent to the manager dashboard until an actual upload/analysis pipeline exists.

## Direction contract

**THESIS:** Keep readiness, timer, and transport controls in one instrument-like session panel so a representative can verify capture at a glance and stay focused on the retailer.

**OWN-WORLD:** Continue the product’s deep green and light canvas, using lime for the active/ready control and amber for attention. Hanken Grotesk, compact status typography, tabular timer numerals, restrained dividers, and one dark recording surface carry the screen; the structure comes from the Session Board sketch, not from decorative hardware.

**STORY:** The representative sets the visit context, confirms the shopkeeper’s consent, records and pauses as needed, then stops. A saved state confirms the audio is on this phone; local queue, API metadata, S3 upload, and analysis remain separate visible states. History contains real local captures; synthetic examples stay labeled.

**FIRST VIEWPORT:** At 390×844, place the product and connection state in a short header, readiness and queue state directly below, then the current outlet and a dark timer-led recorder. Start owns the broad lime action; Pause and Stop sit together beneath it. Recent recordings follow in a compact list, with Record and History navigation anchored at the bottom. At wider widths the same order stays centered and does not become a dashboard.

**FORM:** Session Board, the roll’s assigned lead (position 1), selected from `seed:f43600de8c01d3cd`. Signature interaction: Start changes the timer and panel state; Pause freezes the elapsed time and resumes the same file; Stop finalizes the OPFS file and exposes its local and upload states. Motion is limited to a short state change and timer updates, with reduced motion honored.

**FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
