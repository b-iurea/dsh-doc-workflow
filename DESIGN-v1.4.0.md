# DESIGN v1.4.0 — review notes become a first-class source (issue #17)

Minor. The workflow trusts the documents, but the human is the one who knows the facts the
docs miss ("the GA date moved to 2026-04-15", "the client is the payer, not the payee").
Today that knowledge only travels through chat and evaporates: it never lands in the index,
never joins the consistency matrix, and nothing survives the session. v1.4.0 lets the user
attach **typed notes to workflow artifacts** from the panel (and the tool, at parity), makes
a FACT a *human source* that the integrity machinery cross-checks against the extracted
index, and resolves conflicts with an explicit **supersession** record the user can restore.

## 1 State model (additive, version stays 3)

`state.notes: []` — ordered records `NOTE<n>`: `{ id, target, type, body, author: "human", at, status }`.
`state.supersedions: []` — records `{ id: SUP<n>, kind: "entry→fact" | "fact→entry", fromId (loser), toId (winner), at }`.
`migrateState` fills both arrays (the v3.1 `tasks` precedent: additive blocks, no version bump);
`freshState` starts them empty. Notes are **never** silently dropped by `reflow`, `ingest` or
stage moves — the reflow effect matrix keeps them untouched (the e2e asserts a state diff).

- `target`: an index entry id (`U…`/`N…`), an emitted preset role name (exact card name), or an
  artifact: `plan` | `notes` | `objective`. Existence is validated against a freshly-read state.
- `type`: `FACT | SUGGESTION | GUIDANCE | CONSTRAINT` (a QUESTION type was rejected — questions
  are the gates' job, notes are answers/statements).
- `status`: `open | addressed | superseded`. `body` ≤ 4000 chars, non-empty.
- Ids: `NOTE<n>` via a scan of `state.notes` (same pattern as `nextId`); supersessions `SUP<n>`.

## 2 FACT = human source, the F×U matrix

A FACT is content the human asserts: **no `source_quote` by design** (the author IS the source),
so it is attestable by construction and never goes through the integrity file-anchor check.
It joins the **consistency matrix**: `consistencyLayout` gains, for every *open* FACT note, a
pair against every useful non-superseded entry (F×U, keys `NOTE1|U2` via the existing `pairKey`
sort — no collision with `U…`/`N…` entry ids). `crosscheck` accepts `a`/`b` referencing note ids
(membership checked against the matrix); `recomputeConsistency` requires the F×U verdicts like
any other pair, so a fresh FACT at a passed stage demotes consistency to `pending` and the flow
blocks until the pairs are judged. `address`ing a FACT drops its pairs (`clearConsistencyFor`).

## 3 Conflict → supersession (the only versioning)

When a crosscheck `conflict` names a FACT and an entry, the flow blocks (as any conflict) and
the guidance tells the agent to ask the user **whether the fact replaces the entry**. A
`supersede {fact, entry, winner: "fact"|"entry"}` records the outcome — allowed **only** for a
pair that currently carries a conflict verdict (no arbitrary supersession):

- `winner: "fact"` → kind `entry→fact`: the entry is marked `superseded` (kept visible, excluded
  from the matrix, plan grounding and the integrity check), the FACT becomes `addressed`.
- `winner: "entry"` → kind `fact→entry`: the FACT is marked `superseded`, the entry untouched.

Superseding changes the index basis: `verification` goes `stale`, presets/tasks take the normal
staleness chain, consistency recomputes and routes (replicating the verify-pass routing).
**Restore** (tool + panel button) inverts a supersession record: the loser comes back (`open`),
the record is deleted, and — per the issue — the winning FACT is deleted when it is a note.
No general artifact versioning was added (rejected in the issue): supersession exists only for
this conflict path.

## 4 Channel: panel-native writes from day one + tool parity

`POST /api/docflow/notes` with `{sessionId, file, action: "add"|"address"|"restore"|"supersede", note?, id?, supersede?}`
reuses the v1.3.4 lease-route discipline: `isLoopbackRequest` fence, the `file` must be the
workspace-relative `<dir>/state.json` the panel watches, and the handler **re-reads state.json
fresh** before mutating. The handler is exported (`notesApi.handle`) so the e2e drives it
headlessly, exactly like `leaseApi`.

Concurrent writes are serialized by a per-path promise lock (`withStateLock`): `leaseReconcile`
and the notes handler both run their read-mutate-write inside it, so a note-add racing a
discovery reconcile can never lose a write (the acceptance test runs both concurrently).

Tool parity: `docflow action=note` with `note_action: add|list|address|restore|supersede`
(the agent records notes dictated in chat, lists them, addresses them, supersedes, restores).

## 5 Surfacing

- `statusPayload`: `notes: [{id, target, type, status, body, set_at}]` (all, ordered) +
  `supersedions` + `entries.superseded` count.
- `guidanceFor`: an `OPEN NOTES (n): …` line whenever open notes exist (any stage), naming
  `NOTE→target type` and telling the agent to address/supersede before plan; open FACTs add the
  F×U crosscheck instruction; open CONSTRAINTs are re-surfaced at the interview and plan stages.
- `renderIndex`: a `## Review notes` section (grouped by target, superseded notes + supersession
  records last).
- Panel: a **Notes** section (renderNotes) with the composer (target select over entries +
  emitted roles + plan/notes/objective, type select, body textarea, Add), per-note **Address**,
  supersession history with **Restore**, and an "Add note" affordance in the entry detail that
  pre-targets that entry. Writes go through the loopback route; the 7 s lease poll picks the
  new state up via the existing `version:bytes` fingerprint.

## Tests (`test/e2e.mjs` §23, NT1–NT12)

tool add → state+index+guidance · FACT adds F×U pairs, consistent verdicts pass silently ·
conflict + supersede entry→fact (entry out of matrix/guidance) + restore (back + FACT deleted) ·
fact→entry supersession · notes survive reflow(reading)+ingest (state diff) · route validation
(unknown target, bad type, oversized body write nothing) + loopback fence via fake req/res ·
concurrent note-add + lease-reconcile keeps both effects · migration fills the blocks ·
role-card target accepted, ghost target rejected · tool surface (action enum, note params).
Suite: 160 checks (sections 1–22 kept + new §23 notes block NT1–NT18), Node 20/22/24.
