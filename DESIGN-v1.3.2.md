# DESIGN v1.3.2 — auto-discovery of new/changed files under doc_roots (issue #11)

Minor change. Goal: when a new file appears under the workflow's `doc_roots`, the
panel and the agent's `next` guidance say so — without anyone calling `ingest`
manually first, and **without ever entering the flow by itself**.

## §1 Mechanism (host, `index.js`)

- **Manifest**: `state.docSnapshot = { takenAt, files: { <wsRelPath>: { m: mtimeMsFloor, s: sizeBytes } }, truncated? }`.
  Taken at `start` (baseline: everything already under the roots is "known") and
  refreshed per-path at `ingest` (acknowledgement).
- **Scan** (`scanRootFiles`): each doc root — file root = itself, dir root = bounded
  recursive walk; skips hidden dirs (covers `.doc-workflow`, `.git`) and `node_modules`;
  cap 2000 files → `truncated: true` on overflow. Pure `stat` metadata, no content read.
- **Diff** (`discoverDocs` on every `status` call): current scan vs manifest →
  `new` (missing in manifest) / `changed` (mtime or size differs), sorted by path.
  `state.discoveredDocs = [{path, kind, seenAt}]`; `seenAt` is stable across repeats.
  The status result writes state.json **only when the diff changed** (lossless-JSON safe:
  every field defined). No background timer — `status` is the poll point, per the
  "check on demand" constraint of the issue.
- **Acknowledgement**: `ingest paths=[…]` refreshes the manifest entries for the
  ingested files/directories (a directory path acknowledges its subtree) and removes
  them from `discoveredDocs`. Everything not ingested keeps notifying on every status.
- **Guidance**: `guidanceFor` appends, at any stage, an `AUTO-DISCOVERY:` line listing
  the files and instructing the agent to surface them, get the user's acknowledgement,
  then `ingest` — explicitly forbidding silent ingest. `index.md` gains a
  "Discovered — new/changed files not yet ingested" section.
- **Legacy state**: a pre-v1.3.2 `state.json` has no `docSnapshot`; the first `status`
  only takes the baseline (already-read docs must not flood the notice) and returns
  `discovered: []`. `migrateState` defaults `discoveredDocs: []`. `STATE_VERSION` stays 3
  (both fields are additive-optional).

## §2 Payload surface

- `status.discovered = [{path, kind, seen_at}]`
- `status.doc_snapshot = { taken_at, files, truncated? }` (absent before the first baseline)
- tool description updated with the discovery contract.

## §3 Panel (`client.js`)

`renderDiscovered` box (brand-accent, between entries and pending): one row per
discovered file with a `new`/`changed` chip, plus the en/it hint "tell the agent to
ingest these". The panel renders `state.json` as written by the tool — the discovery
computation stays server-side (no fs access from the browser half).

## §4 Tests (`test/e2e.mjs` §19, D1–D8)

baseline at start · changed+new discovered on next status · stable repeat · ingest one
keeps the other notifying · all ingested -> quiet · directory ingest acknowledges the
subtree · legacy state baselines silently then discovers.
