# DESIGN v1.3.5 — the ingest round gets an ending (issue #15)

Patch. Bug present since `e37f242` (initial release): `state.pendingDocs` is appended by
`ingest` and rendered by the panel and `index.md`, but **no code path ever cleared it** —
ingested documents sat in "Pending new documents" forever, even after the full
reprocessing round (understanding reconfirmed → entries recorded → verify passed →
interview reconfirmed → presets re-emitted). Surfaced live during the v1.3.4
auto-discovery demo.

## Decision

The closing criterion is **`verify` passing**: integrity re-checking the index is exactly
the material completion of an ingest round (every entry sourced from the pending
documents has just been re-anchored). One line in the verify `passed` branch empties
`pendingDocs`; the result carries `pending_cleared: "N pending document(s) acknowledged
— integrity passed on the re-verified index"`, and the standard `renderIndex` refresh
drops the section. Nothing pending → no key (idempotent, silent).

Rejected: per-file clearing on `add_entries` — documents that only produce not-useful
entries (or none, e.g. an empty file) would hang in the box again, same bug relocated.

## Tests (`test/e2e.mjs` §22, P1–P4)

ingest queues (unchanged) · passing verify consumes + reports · index.md section gone ·
second passing verify stays silent. Suite: 142 checks, Node 20/22/24.
