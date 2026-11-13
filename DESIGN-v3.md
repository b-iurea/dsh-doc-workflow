# doc-workflow v3 — interview gate + agent role presets (IMPLEMENTATION CONTRACT)

Branch `feat/interview-agents-preset`. Approved design (user + brainstorming, 2026-11-13):
after the gaps gate the workflow must run an **INTERVIEW** (which agent roles are needed? what
delivery type: CODE / DOCUMENTI / both / answer-only?) then **emit specialized agent role cards
(presets)** as plain markdown under the workflow folder, and only then allow `write_plan`.
The plan stays downstream of the roles. All mitigations decided:

- Interview = new **phase of the existing gates machinery** (`gate_ask`/`gate_answer phase=interview`), not a new action pair.
- Agent PROPOSES roles/delivery derived from the verified index; the user confirms/edits (question fatigue mitigation).
- Delivery is combinable: `code`, `docs`; plus explicit `answer_only: true` (analysis-only objective → presets explicitly skipped with recorded reason).
- Presets = markdown role cards in `.doc-workflow/agents/<slug>.md` + `PRESETS.md` index — no coupling to harness-native preset install/spawn (deferred).
- Source-backed invariant preserved: the *why* of each role must cite existing useful entries (`source_entries` ⊆ useful U ids). The role's body (prompt) is prescriptive/free.
- Invalidation: interview re-answer ⇒ presets stale ⇒ stage back to `presets`. `ingest` ⇒ interview gate re-arms (reconfirm) + presets stale. Verification going stale ⇒ emitted presets become stale (same places as existing `verification.status = 'stale'` writes).
- `write_plan` still requires stage `plan`; stage `plan` is only reachable with presets `emitted` OR `skipped` (answer-only).
- Terminal handoff (spawn integration) and role-scope conflict blocking are OUT of scope v3; write_scope overlap is an advisory warning in `emit_presets` result only.

## 1. State schema additions (STATE_VERSION = 3)

`freshState` adds:

```js
gates: { ..., interview: { status: 'locked' } }        // same lifecycle as gaps: locked → open → pending → answered
interview: {},                                        // filled at answer time (below)
presets: { status: 'none' },                          // none | emitted | skipped | stale
```

On interview answer (see §3):

```js
state.interview = { answerOnly: bool, delivery: ['code','docs'][subset, [] if answerOnly], roles: [names], answeredAt }
state.presets = { status: 'emitted', emittedAt, cards: [ { role, file, why, source_entries, prompt_body, write_scope? } ] }
              | { status: 'skipped', skipReason: 'interview: delivery=answer-only, no execution roles', skippedAt }
```

`start` also creates `questions-interview.md` (`# Interview questions\n\n`). Add a small
`ensureMd(file, header)` helper (stat → write header if missing) used by gate_ask/gate_answer so
migrated v2 folders don't crash on append.

Migration in `migrateState` (v2 → v3, set `state.version = 3`):
- defaults above if missing (dirty=true)
- if `stage === 'plan'` → `stage = 'interview'`, `gates.interview = { status: 'open' }` (the never-written plan must pass the new gates)
- `stage === 'done'` states keep done (completed plans are not revoked) with empty interview/presets shells.
Keep the existing v1→v2 demotion logic untouched; STATE_VERSION becomes 3.

## 2. Stage machine

`reading → indexing → (recheck ↔) consistency → gaps → interview → presets → plan → done`
plus an internal stage name `'interview'` and `'presets'`.

Routing: replace every `if (state.gates.gaps.status === 'answered') state.stage = 'plan'`
(in `gate_answer`, `verify`, `crosscheck`) with:

```js
function afterGapsAnswered(state) {           // called when verified && gaps answered
  if (state.gates.interview.status === 'answered') {
    if (state.interview.answerOnly || state.presets.status === 'emitted') state.stage = 'plan'
    else state.stage = 'presets'
  } else { state.stage = 'interview'; state.gates.interview.status = 'open' }
}
```

- `gate_answer phase=gaps` → if `overallVerified` → call it.
- `verify`/`crosscheck` on success, if gaps answered → call it (same branch they use today).
- On verify/crosscheck success while interview NOT answered → interview stage/gate as above.

`statusPayload` adds:

```js
interview: { status: <gateSummary>, delivery: state.interview.delivery || [], answer_only: !!state.interview.answerOnly, roles: state.interview.roles || [] },
presets: { status: state.presets.status, cards: (state.presets.cards||[]).map(c => ({ role: c.role, source_entries: c.source_entries })) , skip_reason: state.presets.skipReason }
```

`gates` in statusPayload also gets `interview: overallVerified ? gateSummary(...) : 'locked until integrity + consistency pass'`.

`guidanceFor` new cases:
- `case 'interview'`: PROPOSE to the user (ask_user_question) from the verified index which agent
  roles are needed to reach the objective and which delivery type (code / docs / both — or the
  objective is answer-only). Log with `gate_ask phase=interview` + `gate_answer phase=interview`
  carrying the `interview` payload. User confirmation, not free-form interrogation.
- `case 'presets'`: write one role card per confirmed role; each card MUST justify itself with
  `source_entries` citing useful index entries (U…) — the role's existence must be traceable; then
  `emit_presets cards=[...]`.
- `case 'plan'` gains: reference the emitted role cards (agents/*.md) in the plan's team section.

## 3. Interview gate (reuse gate_ask / gate_answer)

- `phase` enum: `understanding | gaps | interview`. `gate_ask phase=interview` locks like gaps:
  requires `overallVerified(state)`.
- `gate_answer phase=interview` additionally REQUIRES arg `interview`:
  `{ answer_only?: boolean, delivery?: ('code'|'docs')[], roles?: string[] }`
  - if `answer_only !== true`: `delivery` must be a non-empty array of 'code'/'docs' AND `roles`
    a non-empty array of strings (role names), else `fail(...)` explaining the schema.
  - store `state.interview = { answerOnly, delivery: answerOnly ? [] : delivery, roles: answerOnly ? [] : roles, answeredAt: now() }`; clear `gates.interview.reconfirm`.
  - answer-only ⇒ `state.presets = { status:'skipped', skipReason:'interview: delivery=answer-only, no execution roles', skippedAt: now() }` and `state.stage='plan'`.
  - otherwise `state.stage='presets'`; if presets was 'emitted' (re-answer) it becomes 'stale'.
- Re-answering after 'answered' is allowed (updates + marks presets stale).

## 4. New action `emit_presets`

Args: `cards: [{ role, why, source_entries: [U ids], prompt_body, write_scope?: [strings] }]`.

Enforce (fail messages actionable):
1. `overallVerified(state)` — else locked.
2. `gates.interview.status === 'answered'` — else "run the interview gate first".
3. `!state.interview.answerOnly` — else "answer-only objective: presets are skipped by design".
4. non-empty cards; per card: `role` string, `why` string, `prompt_body` string,
   `source_entries` non-empty array of ids existing in `state.entries` and `useful === true`.

Side effects:
- Regenerate `agents/` dir (remove + mkdir), write one file per card: `agents/<slug>.md` with
  frontmatter block (`role`, `delivery` joined, `source_entries` list, `write_scope` list) then the
  `prompt_body`; slug = role lowercased, non `[a-z0-9]+` runs → `-`.
- Write `PRESETS.md` index: table role | why | source entries | delivery | write scope | file.
- `state.presets = { status:'emitted', emittedAt: now(), cards: normalized with file }`, `state.stage='plan'`.
- Advisory: if two cards' write_scopes overlap (string-equal or one is a path prefix of the other),
  add non-blocking `warnings: ['write_scope overlap: A ↔ B']` to the result.
- `reset` already rm -rf the whole folder → agents/ covered. `write_plan` requires stage 'plan' (unchanged)
  and, when `state.presets.status === 'emitted'`, appends a machine-generated section to PLAN.md:
  `## Delivery & team (generated)` listing delivery answer, roles + card file paths.

## 5. Staleness propagation

- Everywhere existing code sets `verification.status` to `stale`/`unverified` (add_entries,
  update_entry, remove_entry, attest, ingest, verify-fail path keeps 'failed'): also
  `if (state.presets.status === 'emitted') state.presets.status = 'stale'`.
- `ingest`: additionally `gates.interview.reconfirm = gates.interview.status === 'answered'`.
  (Stage routing on re-verify then follows §2 and re-arms interview ask via reconfirm guidance.)
- `gate_answer phase=interview` when already answered: presets 'emitted' → 'stale'.
- guidance (reading case): if `gates.interview.reconfirm` mention re-confirming interview after new docs.

## 6. Tool surface changes

- action enum += `emit_presets` (place before `ingest`).
- description + PROMPT_SECTION: extend the loop sentence: `... gaps gate -> interview gate
  (phase=interview: propose roles + delivery code/docs/answer-only, user confirms -> emit_presets writes
  source-backed agent role cards under agents/ + PRESETS.md; answer-only skips presets explicitly) -> write_plan`.
- parameters += `interview` (object: `answer_only` bool, `delivery` enum array, `roles` string array) and
  `cards` (array of objects: required role, why, source_entries, prompt_body; optional write_scope).
- `phase` enum += 'interview'.

## 7. Panel contract (client.js reads RAW state.json — this is the contract)

New raw fields the panel may see: `stage` in {'interview','presets'}, `gates.interview`,
`interview` {delivery, roles, answerOnly, answeredAt}, `presets` {status, emittedAt, cards:[{role,...}], skipReason}.
MUST degrade gracefully for v2 states (missing fields ⇒ treat as locked/none, never crash).

- `STEPS` rail: `['reading','indexing','consistency','gaps','interview','presets','plan','done']`; add the two names to `STAGE_NAMES`, `STAGE_CHIP` (both 'dfp-c-brand').
- Gates box: third row `gate.interview`.
- New sections after Gates: **Interview** (delivery chips, roles pills, answer-only badge) and
  **Role cards** (status chip none/emitted/skipped/stale + pill per card role + skip reason line).
- COPY en+it keys for all new labels (it: "Colloquio", "Ruoli agente", "Consegna", "code/documenti/solo risposta", "Schede ruolo: emesse/omesse/da rifare").
- Update the file's header comment to mention the new sections.

## 8. e2e (`test/e2e.mjs`)

Adjust + extend (keep the existing 13 assertions passing with new expectations):
- `11b` gaps answered → stage **`interview`** (was 'plan').
- gate_answer interview WITHOUT `interview` payload → fail; WITH invalid (empty roles) → fail.
- interview answered {delivery:['code'], roles:['migrator','reviewer']} → stage `presets`.
- `emit_presets` before interview (fresh check earlier in flow) → locked; card citing unknown/non-useful entry → fail; good cards (cite U1,U3 etc.) → ok → stage `plan`, `PRESETS.md` + `agents/*.md` exist on disk.
- write_plan → done; final status exposes interview + presets.
- re-answer interview → presets stale → stage `presets`; re-emit → plan; write_plan appends generated team section.
- ingest after done → presets stale + interview reconfirm flag (assert on state.json).
- answer-only path: new workspace `ws-answer` (copy of docs): fast-forward gates/entries/verify/crosscheck/gaps (reuse U1/U2 fixture path), interview with `{answer_only:true}` → presets skipped + stage plan → write_plan ok.
- migration `#13` now expects version **3** and a v2 state with stage 'plan' demoted to 'interview' (update fixture: version 2 state with gaps answered, stage 'plan', verification passed — after status, stage must be 'interview' and gates.interview open).
- update the final `ALL n CHECKS PASSED` count automatically (it's computed) and the README dev-section count if stated.

## 9. Repo-level (lead handles — do NOT touch these files)

`.github/workflows/ci.yml` (new), `README.md`, `package.json` (version 1.2.0, test/check scripts), `DESIGN-v3.md` itself.
