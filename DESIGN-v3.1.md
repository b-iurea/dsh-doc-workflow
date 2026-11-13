# DESIGN-v3.1 — Team bridge: `emit_tasks` (issue #3)

Additive minor of v3. State format stays `STATE_VERSION = 3`; everything new is an optional field the v3 panel must keep ignoring when absent.

## §1 Stage machine

```
reading → indexing → recheck ⇄ consistency → gaps → interview → presets → plan → tasks → done
```

- New stage `tasks` between `plan` and `done`.
- `write_plan`: when `presets.status === 'emitted'` → stage becomes `tasks` (was: `done`). All other routes unchanged (answer-only/skipped presets → `write_plan` still lands `done` directly; a tasks step with no roles is meaningless).
- `emit_tasks` is valid **only** in stage `tasks`; on success → `done`.
- Legacy states: stage `done` without `tasks` field = accepted as-is (no retro-demotion; panel shows no tasks block).

## §2 State field `tasks`

Absent (`pending`) | emitted | skipped:

```jsonc
"tasks": {
  "status": "emitted",            // "emitted" | "skipped"
  "emittedAt": "…ISO…",           // or skippedAt
  "skipReason": "…",              // skipped only
  "stale": true,                  // optional flag, see §5
  "warnings": ["…"],              // coverage warnings, §4.6
  "items": [
    { "id": "slugbed", "subject": "…", "role": "Migratore API Billing",
      "plan_phase": "Prep (entro 2026-02-20)",
      "write_scopes": ["services/billing-api/"],
      "blocked_by": ["other-task-id"] }
  ]
}
```

## §3 Tool surface

New action `emit_tasks`:

- `tasks`: array (may be empty **only** with `skip_reason`).
- `skip_reason`: optional string; explicit skip allowed in stage `tasks` (mirrors presets skip semantics).

`status` must report: `tasks: pending|emitted|skipped` + stale flag + warnings + item count.

## §4 Validation (hard rejects unless noted)

1. Stage must be `tasks` (clear error otherwise).
2. `presets.status === 'emitted'` — answer-only flows never reach here; a skipped-presets state calling `emit_tasks` without `skip_reason` is rejected with guidance.
3. Per task: `subject`, `description`, `plan_phase` non-empty; `id = slug(subject)` with collision suffix `-2/-3` (same convention as preset slugs); trimmed.
4. `role`: must exactly equal a role name from the **emitted** presets cards. Unknown role → reject listing valid role names.
5. `write_scopes`: optional array of non-empty strings; when absent, inherits the card's `write_scope` verbatim (may end up `[]` — allowed, advisory-only concept from v3).
6. `blocked_by`: each entry must be an id of another task **in this batch**; self-reference and cycles → reject with the offending cycle path; duplicate refs deduped.
7. Soft warning (not blocking): every distinct bold phase label in PLAN.md (`**…**` lines under a heading containing `Fasi`/`Phases`, or `### ` headings) should be referenced by ≥1 task `plan_phase`; unreferenced phases produce `coverage: plan phase "X" has no task` warnings. Unknown `plan_phase` value with zero phase candidates (no PLAN.md markers found) → single warning `coverage: PLAN.md phase markers not found`, no per-phase checks.

## §5 Staleness

- Reusing the existing staleness triggers (add/update/remove_entry, attest, ingest): when they mark `presets.stale = true`, they **also** mark `tasks.stale = true` if tasks emitted (tasks derive from cards; chain must be visible).
- `emit_tasks` re-run from stage `tasks` overwrites cleanly (status emitted, stale cleared, warnings recomputed).
- Presets skipped → tasks must be skipped: skip path stores `skipReason`.

## §6 Artifacts

`TASKS.md` (workflow dir):

```markdown
# Task drafts
<!-- machine consumers: state.json "tasks" block is authoritative -->

## <subject>
- **role**: <role> · **plan phase**: <plan_phase>
- **write_scopes**: `a/`, `b/`
- **blocked_by**: id1, id2 (none when empty)

<description verbatim>
```

Skipped: `TASKS.md` contains the header + `_Skipped: <reason>_`. Header also carries a one-line pointer that the mapping to `team_task_create` is 1:1 (`subject/description/blocked_by/write_scopes`).

## §7 write_plan interplay

`## Delivery & team (generated)` section unchanged. After the role list it gains a one-line pointer: `Task drafts: TASKS.md (pending|emitted N|skipped)` — regenerated on every write_plan.

## §8 Panel contract (client.js)

- Rail: 9 steps `reading, indexing, consistency, gaps, interview, presets, plan, tasks, done` (`recheck` maps to step index 1 like today).
- New block **Task drafts**: status chip pending/emitted/skipped/stale (da rifare), per item a row: subject + role pill (card tooltip keeps working) + `⛓ blocked_by count` + write_scopes as code chips; tooltip = description. Absent field (v3 state) ⇒ hidden entirely.
- New COPY strings en+it (Schede ruolo style): "Task drafts"/"Bozze di task", pending/emitted/skipped chips reuse preset chip vocabulary.

## §9 e2e expectations (extend test/e2e.mjs, keep all v3 checks green)

- full flow into stage `tasks` after write_plan (presets emitted) — assert stage, not `done`
- answer-only flow still ends `done` at write_plan (no tasks stage)
- emit_tasks happy path → done; TASKS.md exists with sections; state items complete; inherits card write_scopes
- rejects: unknown role; role from skipped presets; cycle (assert path in error); self-block; empty subject; wrong stage
- skip path: `tasks: []` + skip_reason → status skipped → done
- staleness chain: entry update → presets.stale **and** tasks.stale
- coverage warnings: unreferenced bold phase listed, not blocking
- migration: v3 `done` state without tasks untouched; v2 fixture still migrates per §v3 rules
- legacy panel safety: statusPayload serializes tasks absent vs present without breaking v2-style consumers.

## §10 Package

`package.json` version `1.3.0`. README gains: `emit_tasks` bullet, stage list with `tasks`, layout line `TASKS.md`.
