# doc-workflow

A [DeepSeek Harness](https://github.com/deepseek-ai) plugin bundle that turns "read the project docs and make a plan" into an enforced, auditable workflow: **objective → document reading → verified index → clarification gates → interview (agent roles + delivery) → source-backed role cards → notes & plan**.

The agent cannot silently hand you conclusions scraped from documents. Every claim it keeps in the index is anchored to a verbatim quote from a real file, programmatically re-checked, and judged for trustworthiness — and whenever the documents are unclear or insufficient *for your objective*, the workflow stops and asks **you** questions. Before a plan is written, the workflow also interviews you about *who executes it and what gets delivered*, and materializes those roles as portable agent role cards.

## The workflow

```mermaid
flowchart TD
    A[define objective] --> B[read project docs]
    N[new documents] -.-> B
    B -.- Q1{{"comprehension questions:<br>objective vs. documents"}}
    Q1 -.- B
    B --> C[scrape & filter USEFUL info]
    B -.-> D[scrape & filter NOT-USEFUL info]
    C --> E[(index.md)]
    D -.-> E
    E --> F[verify INTEGRITY: sources + verbatim quotes]
    F -. check failed .-> B
    F --> K[CONSISTENCY: crosscheck every pair]
    K -. conflict / fix entries .-> B
    K -.- Q2{{"missing-information questions:<br>what is needed to reach the objective"}}
    Q2 -.- I{{"INTERVIEW gate: agent PROPOSES roles +<br>delivery (code / docs / both / answer-only),<br>user confirms or edits"}}
    I --> P[emit_presets: agent role cards<br>agents/*.md + PRESETS.md]
    I -. "answer-only objective" .-> S[presets explicitly skipped<br>reason recorded]
    P --> G[write notes & plan for the objective]
    S --> G
    G --> T[emit_tasks: task drafts per plan phase<br>role + write_scopes + blockers → TASKS.md]
    G -. "no execution roles" .-> U[emit_tasks skipped<br>reason recorded]
    P -. "new docs / re-answer ⇒ stale" .-> B
    T -. "reflow(to_stage): restart from any step ≤ current,<br>downstream artifacts invalidated" .-> B
```

- **Auto-discovery (v1.3.4)**: documents rarely announce themselves. Every `docflow status` diffs the `doc_roots` against a lightweight mtime/size manifest (taken at `start`, refreshed at `ingest`) and reports `discovered`: files that appeared or changed since the last acknowledgement. They surface in the panel and in the agent's `next` guidance, and they **keep notifying until you acknowledge** — entering the flow still requires an explicit `ingest`, so nothing gets read into the workflow behind your back.
- **Selective re-read (v1.3.4)**: after a `reflow to_stage=reading` you rarely want to re-read *everything* — usually only the docs that changed. `reflow(to_stage="reading", paths=[…])` scopes the re-read to those files; every other document **keeps its verification state**. The panel's reading reflow box shows a checklist of the known files, status reports the live scope as `reading_scope`, and a reflow without `paths` (or any `ingest`) restores the full reading.
- **Panel-lifetime watcher (v1.3.4)**: while the Docflow panel is open you shouldn't have to ask "any new files?" — the mounted panel sends a loopback-only heartbeat about every 7 s, the host runs one catch-up diff when the lease starts and then `fs.watch`es the `doc_roots`, re-running the same mtime/size diff on events. When the panel closes the lease lapses within ~20 s and the watchers close with it: no daemon, no polling while nobody is watching. Headless `status` keeps reconciling exactly as before.
- **Reflow (v1.3.1)**: a workflow rarely needs a full reset — usually just one step has to be redone. `docflow reflow to_stage=<step>` restarts from any step at or upstream of the current stage (never forward, never the objective itself) and invalidates exactly the downstream artifacts per a fixed effect matrix: re-running `indexing` clears the verification + verdicts, re-running `gaps` re-opens the gaps gate and marks the interview for reconfirmation, re-running `presets` demands a fresh `emit_presets` before the plan can be written again, and so on — while the objective, the extracted entries and every gate's history are **never** silently dropped. The panel's stage rail turns each reachable step into a clickable box showing what that step last produced, with a **"Resume from here"** button that injects the reflow request straight back into the chat (the agent runs `docflow reflow` and continues; copy-paste fallback only if the session is not live).
- **Comprehension gate** (red line 1): before extracting anything, the agent must ask you what is ambiguous about the objective *given these documents*, and you must answer.
- **Two scrapes**: useful entries (`U1…`) and explicitly rejected ones (`N1…`) both land in `index.md`, so the filtering is reviewable, not invisible.
- **Source-backed only (v2)**: every entry carries a written source — either an internal doc (`source_file` + **mandatory verbatim `source_quote`**) or an external one (`source_ref` URL/path + quote). Content without a quote is rejected at admission: nothing is ever *assumed*.
- **Integrity** (the green→blue loop): `docflow verify` checks programmatically that each entry's anchor file still exists and its verbatim quote is still found in it (whitespace-normalized), and that every entry was attested (`ok`/`suspect`). A line anchor without its quote now *fails* — it cannot prove the content. External sources (URL or foreign path) additionally block `VERIFIED` until a human vouches: `attest verdict=trusted` after you reviewed them.
- **Logical consistency (v2)**: after integrity passes, `docflow crosscheck` walks the **pair matrix** over all useful entries: each pair is judged `consistent` or `conflict` (conflicts record a note; `consistency.md` lists the matrix with mechanical value-hints — dates/versions/quantities that differ between the two entries). Any edit to an entry invalidates its pairs. The gaps gate and everything downstream open only when integrity **and** consistency are `VERIFIED`.
- **Gaps gate** (red line 2): only after verification passes can the agent ask you what information is still missing to reach the objective.
- **Interview gate (v3)**: with the index verified and the gaps answered, the agent **proposes** — derived from the verified index, not invented — which agent roles are needed to execute the objective and which delivery applies: `code`, `docs`, both, or `answer-only` for pure-analysis objectives. You confirm or edit (the interview is a confirmation, not an interrogation); answers are logged to `questions-interview.md` and kept as workflow state.
- **Agent role cards (v3)**: `docflow emit_presets` materializes each confirmed role as a portable markdown card under `.doc-workflow/agents/`, indexed by `PRESETS.md`. A card is admitted only when its *reason to exist* cites useful index entries (`source_entries`) — the "why" stays source-backed, the role prompt body is free. Overlapping `write_scope` between cards surfaces as an advisory warning. For `answer-only` objectives presets are explicitly **skipped with a recorded reason** — no bureaucratic roles. `write_plan` unlocks only after cards are emitted or explicitly skipped, and when cards exist the generated *Delivery & team* section is appended to `PLAN.md`.
- **Task drafts (v3.1)**: with the plan written and role cards emitted, `docflow emit_tasks` bridges docs-to-team: each draft names an **emitted** role, sits in a plan phase, inherits the card's `write_scope` and wires `blocked_by` into an acyclic within-batch graph. Validation is enforced (unknown roles, cycles, empty fields are rejected; unreferenced plan phases only warn). Output is `TASKS.md` + a machine-readable `tasks` block in `state.json` — a 1:1 feed for any task board (e.g. harness shared tasks), spawn stays out of the plugin. Explicit skip with reason for objectives that need no execution tasks; stale role cards mark the drafts stale too.
- **New documents** can be ingested at any time (`docflow ingest`); the understanding gate re-arms for confirmation, verification becomes stale, the interview gate re-arms and emitted role cards are marked `stale` (task drafts with them).

## What you get

| Piece | What it does |
|---|---|
| `docflow` host tool | The whole state machine, one tool with an `action` parameter: `status · start · gate_ask · gate_answer · add_entries · update_entry · remove_entry · attest · verify · crosscheck · emit_presets · emit_tasks · ingest · write_plan · reflow · reset`. Every result carries a `next[]` list of the exact next steps; a system-prompt section keeps the agent driving the workflow literally. |
| State on disk | `<cwd>/.doc-workflow/` — `state.json`, `objective.md`, `index.md`, `questions-understanding.md`, `questions-gaps.md`, `questions-interview.md`, `verification.md`, `consistency.md`, `PRESETS.md`, `agents/*.md`, `TASKS.md`, `NOTES.md`, `PLAN.md`. Plain files: greppable, diffable, survives sessions. |
| Right-sidebar panel | A live read-only dashboard (tab **Document workflow**): stage rail with the v2 *consistency*, v3 *interview → role cards* and v3.1 *task drafts* phases, a VERIFIED/pending/conflict banner, integrity pills + the consistency matrix (missing pairs, conflict notes), gates (understanding / gaps / interview), the interview block (delivery chips + proposed/confirmed roles), the role-card block (emitted / skipped / stale + per-card pills), the task-draft block (rows with role pill, blockers, write-scope chips), expandable U/N entries with source badge (internal / external `ext`), verify/attest dots and the verbatim quote, pending new documents and the plan block. Auto-refreshes every 7 s, discovers one panel per project in the workspace. |

## Install

From npm (any DSH instance — host tool + panel, no checkout needed): open the plugin manager (Discover / market) and install **`dsh-doc-workflow`**, or from a session:

```
plugin_manager install_bundle dsh-doc-workflow
```

Or add the bundle row to your profile pack:

```yaml
- insert:
    - id: doc-workflow
      name: 'dsh-doc-workflow'
```

From a local checkout (development): `plugin_manager install_bundle <path-to>/doc-workflow-plugin` — or keep a `link:` dependency to the checkout while iterating.

> **Migration from the pre-1.3.6 local bundle**: if this plugin was previously installed as `@local/doc-workflow`, disable that entry once the npm one is enabled — they would register two sidebar tabs. Workflow state on disk (`.doc-workflow/` folders) is untouched by the rename.

## Use

Kick off with an objective and document roots:

> start a docflow for "migrate the billing API from v1 to v2", docs in `./docs`

The agent will run `docflow start`, ask its comprehension questions (via `ask_user_question` in chat), record your answers, extract entries, attest and verify them, cross-check consistency, ask the gaps questions, propose the role/delivery interview for your confirmation, emit the role cards, write `NOTES.md` + `PLAN.md` and finally translate the plan into validated `TASKS.md` drafts. State is enforced server-side: extraction before the comprehension gate is answered is rejected, `emit_presets` is rejected until the interview is answered and the index is verified, `write_plan` is rejected until presets are emitted or explicitly skipped, `emit_tasks` only runs after the plan and only with roles that exist among the emitted cards, etc.

## Development

```bash
npm run check    # host + client + suite must parse
npm test         # regression suite (prints its own assertion count), exits 0
```

The e2e suite drives the real host module through the full happy path plus the failure loops (bogus quote → verify fails → `recheck` → fix → passes → gaps → interview → presets → plan → tasks → done; conflict → fix → re-review; answer-only skip path; un-re-answered interview blocks presets; unknown-role / cyclic `emit_tasks` rejected; `reflow` legality + the full per-target invalidation matrix, including a reflow-restart→re-emit round trip back to `done`; v1/v2/v3-legacy state migration) with guardrail checks at every stage-gate. CI runs it on Node 20/22/24 via GitHub Actions (`.github/workflows/ci.yml`).

After editing the host half in a live profile, toggle the plugin (e.g. `include:doc-workflow` off/on) to hot-reload; after editing the client half, reinstall (`remove_bundle` + `install_bundle`) so the client manifest is re-synced.

## Layout

```
index.js              host half: the docflow tool + state machine + system-prompt section
client.js             browser half: right-sidebar live panel (React via harness module loader, tokens-only theming)
cordis.patch.yml      bundle patch row
locale/{en,it}.json   bundle meta
icon.svg              tab/plugin icon
DESIGN-v3.md          implementation contract for the interview/presets (v3) flow
DESIGN-v3.1.md        implementation contract for emit_tasks / task drafts (v3.1)
DESIGN-v1.3.1.md      implementation contract for reflow / step-level restart (v1.3.1)
DESIGN-v1.3.4.md      implementation contract for v1.3.4: auto-discovery + selective re-read + panel-lifetime watcher
DESIGN-v1.3.5.md      bugfix contract: verify-passing consumes the pending-documents round (v1.3.5)
DESIGN-v1.3.6.md      infra contract: npm rename + tag-triggered publish pipeline (v1.3.6)
test/e2e.mjs          headless regression suite (+ test/docs fixtures)
.github/workflows/ci.yml   GitHub Actions: npm run check + npm test on Node 20/22/24
.github/workflows/publish.yml  GitHub Actions: tag vX.Y.Z → version guard → tests → npm publish
```

MIT © b-iurea
