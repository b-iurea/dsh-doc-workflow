# DESIGN v1.3.1 — `reflow`: restart the workflow from any earlier step

Issue #9. Human decisions: action name **`reflow`**; the panel button must **auto-restart** the flow (prompt injection, no copy-paste as primary); legal targets = any step at or upstream of the current stage, objective definition excluded (that stays `reset`).

## §1 Stage order & legality

`REFLOW_ORDER = ['reading','indexing','consistency','gaps','interview','presets','plan','tasks']` (indices 0..7).

`stagePos(state.stage)`: identity for the 8 names; **`recheck` maps to `indexing`**; **`done` maps to 99** (all targets legal). `no-workflow` (no state) is N/A.

`reflow` rule: `target = REFLOW_ORDER.indexOf(args.to_stage)`; reject unless `0 <= target <= stagePos(current)`. Error message must name the current stage and list legal targets. Rationale: reflow re-runs step X and invalidates downstream artifacts; it never jumps forward (forward moves stay gate-enforced).

Never touched by reflow: `objective`, `doc_roots`, `createdAt`, `entries` (always preserved — invalidation of derived state happens through the existing staleness machinery, never silently), understanding gate history (its answers live in questions-understanding.md and stay).

## §2 Per-target effect matrix

Common tail for every target: `state.updatedAt = now()`, writeJson + renderIndex, return `{ ok:true, reflowed_to, stage, kept:[...], invalidated:[...], next: guidanceFor(state) }`. `invalidated`/`kept` are short human-readable strings the agent relays to the user.

| `to_stage` | effects (in addition to stage change) |
|---|---|
| `reading` | stage → `reading`. Nothing cleared (re-reading docs; entry edits fire the normal staleness path). |
| `indexing` | `verification` → `{status:'unverified'}` fresh shell (freshState shape, line ~471); `consistency.verdicts` → `{}` + `recomputeConsistency`; if the recompute lands `passed`/`n/a` (0–1 useful entries) **do not auto-route** — hold stage `indexing` (user is re-running extraction). `presetsStale(state)` (chains tasks). |
| `consistency` | keep `verification`; `consistency.verdicts` → `{}` + recompute (missing pairs ⇒ `pending`); stage → `consistency`. If recompute is `n/a` (0–1 useful entries): replicate the verify-pass routing — gaps answered ⇒ `afterGapsAnswered(state)`, else stage `gaps` + `gates.gaps.status='open'`. `presetsStale(state)`. |
| `gaps` | `gates.gaps.status='open'` (keep its old fields as history: rename object to `{status:'open', reconfirm:true}` preserving `asked/answered` flags if present); interview chain downstream: `gates.interview.status='open'` + `reconfirm:true`, `presetsStale(state)`; stage → `gaps`. |
| `interview` | `gates.interview.status='open'` + `reconfirm:true` (keep `state.interview` record — re-answer overwrites and `presetsStale` fires in gate_answer already); `presetsStale(state)`; stage → `interview`. |
| `presets` | `state.presets = { status:'pending' }` (files on disk stay as reference; write_plan guard rejects `pending` — same guard as before); `presetsStale` equivalent for tasks: if `state.tasks?.status==='emitted'` → `state.tasks.stale=true`; stage → `presets`. Requires interview answered — always true by legality. |
| `plan` | `state.plan = {}`; tasks stale-chain as above; presets untouched; stage → `plan`. (write_plan simply re-overwrites NOTES/PLAN.) |
| `tasks` | `delete state.tasks` (status synthesizes `pending` per v3.1 §1; TASKS.md file stays as reference); stage → `tasks`. Presets must be emitted — guaranteed by legality; if presets currently `skipped`, `tasks` target still allowed (agent can only re-skip: emit_tasks guards it). |

Note on `presetsStale`: it currently flips `emitted→stale` and chains tasks (index.js:147). `reflow(presets)` deliberately differs (full `pending`, cards cleared) — implement inline, don't bend `presetsStale`.

## §3 Tool surface

- `action` enum += `reflow` (place after `emit_tasks`).
- New parameter `to_stage`: enum of the 8 names, description "reflow: the step to re-run from; must be the current or an earlier step".
- `runDocflow` case `reflow` implements §1–§2. Unknown/missing `to_stage` → fail with the enum.
- Tool description: insert `-> reflow(to_stage): re-run any step at or upstream of the current stage, invalidating downstream artifacts (entries and gates history are never silently dropped)` into the stage machine sentence; also mention in the "next" guidance of every stage? **No** — guidance stays as-is (reflow is user-initiated, agent learns it from the injected prompt or the issue).
- `statusPayload`: add `reflow_targets: REFLOW_ORDER.slice(0, stagePos(current)+1)` (panel can compute it too, but the tool payload makes it discoverable for agents; cheap).

## §4 Panel → chat bridge (auto-restart)

Harness API (verified in `@deepseek-ai/dsh-api-session-controller`): `remote.session.prompt({ requestId, sessionId, mode, content })`, mode ∈ `queue|steer`, `content: [{type:'text', text}]`, requestId any client-minted string; returns `{accepted:true}`; errors as RemoteError (`session/not-found` if the agent isn't live).

- `client.js` `exports.inject` (line ~452): add `'remote.session'` to the list (currently has `remote.workspaceFiles` only).
- Rail steps at index ≤ current become clickable buttons (unreachable steps render as before). Clicking a step opens/updates an inline **Reflow detail** area (use native `<details>`/`<summary>` or equivalent minimal-state approach — no framework assumptions):
  - **Last-run info** per step, from state only (all optional, hide what's missing):
    - reading: objective, doc_roots count
    - indexing: entries count (U/N), `verification.status` + `lastRun`
    - consistency: `consistency.status`, verdict count, conflict ids if any
    - gaps: `gates.gaps` answeredAt-ish timestamps present in gate object
    - interview: `interview` — answerOnly badge / delivery / roles / `answeredAt`
    - presets: status chip + emittedAt + card roles (+ skipReason)
    - plan: `plan.writtenAt` (+ TASKS pointer already in v3.1 block)
    - tasks: status/emittedAt/count/skipReason (already rendered in v3.1 block — summary only)
  - Button **"Riparti da qui" / "Resume from here"**: on click → `remote.session.prompt({requestId: 'dfp-reflow-' + Date.now() + '-' + rand, sessionId: <bound session id already used by load>, mode: 'queue', content: [{type:'text', text: TEMPLATE}]})`. Then mark the button disabled + "richiesta inviata ✓" until the next 7 s refresh changes the stage (or errors).
  - TEMPLATE (language-neutral for the agent): `[docflow-panel] Reflow requested from step "<stage-label>". Call docflow action=reflow to_stage=<stage>, tell the user what was kept vs invalidated from the result, and continue from its next guidance.`
  - Failure path (RemoteError/agent not live): show the same one-line instruction text in the detail area with a `copy` affordance so the user can paste manually — graceful degradation, still primary = auto.
- If the docflow host exposes no session binding (state discovery via probe used `sessionId` — reuse the exact same value the panel already uses for `workspaceFiles.readBytes`).

## §5 Migration & defensive

- reflow works on migrated v2-legacy states (the human's case: flows started at plugin 1.1.0). All fields it touches exist post-migration; code must use optional chains like the rest of v3.1 (`state.tasks?.status`).
- Panel must stay defensive: fields absent ⇒ info line omitted (v2/v3-era states), rail steps beyond current never clickable, `remote.session` absent ⇒ buttons render info-only with the copy fallback.

## §6 e2e expectations (test/e2e.mjs)

- legality: from `presets` stage, `reflow to_stage=tasks` rejected (names current stage + legal list); from `done`, every target legal; `recheck` current-stage treated as indexing position.
- cascade per target (fixture with U1..U4, verdicts, presets emitted, plan+tasks emitted):
  - `indexing` → verification fresh, verdicts {}, stage indexing, presets stale + tasks stale, entries intact.
  - `consistency` → verification kept `passed`, verdicts {}, stage consistency.
  - `interview` → gate open + reconfirm, presets stale.
  - `presets` → presets.status pending, write_plan rejected until re-emit, stage presets.
  - `plan` → plan {} , stage plan, presets untouched.
  - `tasks` → tasks block gone (status synthesizes pending), stage tasks.
  - `reading` → stage reading, nothing else changed (compare state deep-equal minus stage/updatedAt).
- `reflow(presets)` then full re-emit happy path returns to done (guards fire normally in between).
- migrated-v2 fixture (reuse ws-migrate fixture) loads and reflows `to_stage=indexing` fine.
- status `reflow_targets` correct at 2–3 stages.
- existing 80 checks stay green; label new checks `R1..Rn`.

## §7 Files & version

- `index.js` (backend owner), `test/e2e.mjs` (backend owner), `client.js` (panel owner), README + `package.json` → **1.3.1** (lead). `DESIGN-v1.3.1.md` is the contract (lead).
- Acceptance for everyone: `node --check` green; `cd test && node e2e.mjs` all green; no git commands from teammates; no commits.
