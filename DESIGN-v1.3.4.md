# DESIGN v1.3.4 — one release, three features (issues #11, #12, #14)

Ships as a single v1.3.4 (per the release decision on PR #13). §1–4 cover auto-discovery
(issue #11, first drafted for v1.3.2); §5 covers selective re-read (issue #12); §6 covers
the panel-lifetime watcher (issue #14).

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
- **Legacy state**: a pre-v1.3.4 `state.json` has no `docSnapshot`; the first `status`
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

## §5 Selective re-read (issue #12)

`reflow to_stage="reading"` accepts an optional `paths: [workspace-relative files]`:

- `paths` is accepted **only** with `to_stage=reading` — any other target fails outright
  (`reflow paths are only accepted with to_stage=reading`), so a pick can never silently
  narrow a later, different reflow.
- Every path is validated (`fs.stat` isFile) **before any state write**; a missing file
  fails the whole call listing the offenders — no partial scope.
- On success `state.readingScope = { paths: sortedUnique, setAt }`; `status` reports it
  as `reading_scope` and the reading guidance gains a `SELECTIVE RE-READ` line telling
  the agent to re-read exactly those files.
- The scope is cleared by: `reflow to_stage=reading` **without** `paths` (restores full
  reading), any reflow to another stage, `ingest` (new documents must not be suppressed
  by a stale pick), and advancing past reading (`add_entries` -> indexing). Cleared
  scopes are announced in the result's `invalidated` array.
- The other files are *not* touched: their entries keep `verified`/`stale` flags — the
  point of the feature is that re-reading three docs does not invalidate forty.

Panel: the reading step's reflow box renders a checklist from `state.docSnapshot.files`
(keys = the files the workflow has actually seen). Nothing checked = full re-read, same
button as before. The injected prompt carries `paths=["a","b"]` appended to the standard
reflow sentence; the agent maps it straight onto `reflow(to_stage, paths)`. Selection
state resets when the reflow box closes or the stage changes.

Tests: e2e §20 (S1–S9): set, status surface, guidance, missing-file fail (no partial
write), restore-full, ingest clears, non-reading rejection, add_entries clears.

## §6 Panel-lifetime watcher (issue #14)

Problem: `discovered` only refreshed when an agent turn called `status` (or, at best,
the panel re-read state.json every 7 s — which never recomputed anything). Users want
"file lands -> sidebar says so" *while the panel is open*, without a daemon.

Design (grilled with the user first, issue #14): events replace the *trigger*, never the
*diff* — same mtime/size manifest, no checksums; watching only while the panel is alive;
~10 s latency acceptable (event -> debounce 500 ms -> diff -> state.json -> panel poll
≤ 7 s), no sub-2 s push.

- **Lease**: the panel's existing read effect fires a fire-and-forget
  `POST /api/docflow/lease {sessionId, file}` on every poll tick. First heartbeat for a
  state file = lease acquisition: ONE catch-up `discoverDocs` reconcile (covers changes
  made while the panel was closed), then `fs.watch(dir, {recursive:true})` per existing
  `doc_roots` dir (missing roots: no watcher — `status` still reconciles them).
  Subsequent heartbeats only refresh `lastBeat`.
- **Events** are debounced 500 ms and funnel into a per-lease serial queue: fresh read
  of state.json, `discoverDocs`, persist + `renderIndex` only if changed — byte-for-byte
  the same work `status` does, so both writers converge.
- **Release**: no heartbeat for ~20 s (panel closed/navigated/host dead) -> watchers and
  timers closed (all timers `unref`'d; watchers unref'd best-effort). Nothing runs with
  nobody watching.
- **Security**: loopback-only fence (same semantics as the workbench plugin:
  `remoteAddress` ∈ {127.0.0.1, ::1, ::ffff:127.0.0.1}, Host localhost/127.0.0.1/[::1],
  reject `sec-fetch-site: cross-site`, Origin host must equal Host). `sessionId` resolves
  to the session's working directory — a caller can only lease a `<dir>/state.json`
  inside a real workspace, never an arbitrary path. `webServer` is wired via **lazy**
  `ctx.inject(['webServer'], cb)` (optional service — CLI hosts without a web server
  simply never register the route; the required `inject` list stays untouched).
- **Headless path unchanged**: `status` still reconciles on demand — the watcher is an
  extra trigger, never a dependency. e2e §21 (W1–W6) drives `leaseApi` directly:
  catch-up on first heartbeat, event-driven rewrite with **no tool call in between**,
  release stops watching, re-lease catches up, non-docflow state refused.
