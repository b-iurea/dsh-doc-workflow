/**
 * doc-workflow — document-driven planning workflow for the Harness.
 *
 * Implements the flow: objective -> read project docs -> understanding gate ->
 * useful/not-useful filtering into index.md -> INTEGRITY verification (every
 * entry is source-backed with a verbatim quote: internal project file or
 * declared external source, never assumed; re-read loop on failure) ->
 * CONSISTENCY review (per-topic logical cross-check with a forced verdict
 * matrix; conflicts must be resolved) -> missing-information gate ->
 * INTERVIEW gate (the user confirms the agent roles + delivery type proposed
 * from the verified index) -> agent role presets: source-backed markdown
 * cards under agents/ + PRESETS.md, or an explicit skip for answer-only
 * objectives -> notes + plan -> team task drafts: emit_tasks renders TASKS.md,
 * 1:1 mappable to the shared team task board, or records an explicit skip.
 * Incremental input of new documents re-enters
 * the reading stage and re-arms the interview.
 *
 * All state lives in the session workspace under a per-session folder so the
 * user can read and edit it. The `docflow` tool is the single writer.
 */

import fs from 'node:fs/promises'
import { watch as fsWatch } from 'node:fs'
import path from 'node:path'

export const inject = ['tools', 'sessions', 'workingDirectory', 'systemPrompt']

const STATE_VERSION = 3
const DEFAULT_DIR = '.doc-workflow'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function now() {
  return new Date().toISOString()
}

function fail(error, guidance) {
  return { ok: false, error, ...(guidance ? { guidance } : {}) }
}

function normSpace(s) {
  return String(s).replace(/\s+/g, ' ').trim()
}

function safeDirName(dir) {
  if (typeof dir !== 'string' || dir.trim() === '') return DEFAULT_DIR
  const base = path.basename(dir.trim())
  if (base === '.' || base === '..' || base.startsWith('.')) return base
  return base
}

function validId(id) {
  return typeof id === 'string' && /^(U|N)\d+$/.test(id)
}

function nextId(state, prefix) {
  let max = 0
  for (const id of Object.keys(state.entries)) {
    if (id.startsWith(prefix)) max = Math.max(max, Number(id.slice(1)))
  }
  return `${prefix}${max + 1}`
}

const GATE_DOCS = {
  understanding: { file: 'questions-understanding.md', header: '# Understanding questions\n\n' },
  gaps: { file: 'questions-gaps.md', header: '# Missing-information questions\n\n' },
  interview: { file: 'questions-interview.md', header: '# Interview questions\n\n' },
}

// v1.4.0 (issue #17): typed review notes. A QUESTION type was rejected by design —
// questions belong to the gates; notes are the user's statements. FACT is the one type
// that joins the consistency matrix (it is a human source, attestable by construction).
const NOTE_TYPES = ['FACT', 'SUGGESTION', 'GUIDANCE', 'CONSTRAINT']
const NOTE_ARTIFACTS = ['plan', 'notes', 'objective']
const NOTE_BODY_MAX = 4000

function validNoteId(id) {
  return typeof id === 'string' && /^NOTE\d+$/.test(id)
}

function validSupId(id) {
  return typeof id === 'string' && /^SUP\d+$/.test(id)
}

function nextNoteId(state) {
  let max = 0
  for (const n of state.notes || []) {
    if (typeof n.id === 'string' && n.id.startsWith('NOTE')) max = Math.max(max, Number(n.id.slice(4)) || 0)
  }
  return `NOTE${max + 1}`
}

function nextSupId(state) {
  let max = 0
  for (const s of state.supersedions || []) {
    if (typeof s.id === 'string' && s.id.startsWith('SUP')) max = Math.max(max, Number(s.id.slice(3)) || 0)
  }
  return `SUP${max + 1}`
}

/** target existence against a freshly-read state: entry id, emitted preset role, or artifact.
 *  Returns an error string, undefined when the target is valid. */
function noteTargetError(state, target) {
  if (typeof target !== 'string' || target.trim() === '')
    return 'note.target is required: an index entry id (U…/N…), an emitted role name, or plan|notes|objective'
  const t = target.trim()
  if (NOTE_ARTIFACTS.includes(t)) return undefined
  if (validId(t)) return state.entries[t] ? undefined : `note.target ${t} is not an existing index entry`
  const roles = state.presets && Array.isArray(state.presets.cards) ? state.presets.cards.map((c) => c.role) : []
  if (roles.includes(t)) return undefined
  return `note.target "${t}" is not an existing entry id, an emitted role (${roles.length ? roles.join(', ') : 'none emitted'}), or plan|notes|objective`
}

// v1.3.1 §1: the reflow ladder — re-run step X, invalidate downstream artifacts.
// 'recheck' is the failed-verify parking position for indexing; 'done' sits past
// the ladder (pos 99) so every target is legal from it. no-workflow (no state) is N/A.
const REFLOW_ORDER = ['reading', 'indexing', 'consistency', 'gaps', 'interview', 'presets', 'plan', 'tasks']

function stagePos(stage) {
  if (stage === 'recheck') return REFLOW_ORDER.indexOf('indexing')
  if (stage === 'done') return 99
  return REFLOW_ORDER.indexOf(stage)
}

const FACT_PATTERNS = [
  { kind: 'date', re: /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/g },
  { kind: 'version', re: /\bv\d+(?:\.\d+){0,3}\b/gi },
  { kind: 'quantity', re: /\b\d+(?:[.,]\d+)?\s?(?:%|kb|mb|gb|ms|rps|qps|giorni|days?|ore|hours?|settimane?|weeks?|mesi?|months?|anni?|years?)\b/gi },
]

function factValues(text) {
  const out = {}
  for (const p of FACT_PATTERNS) {
    const m = String(text || '').match(p.re)
    if (m) out[p.kind] = [...new Set(m.map((s) => s.trim().toLowerCase()))].sort()
  }
  return out
}

function pairKey(a, b) {
  return [a, b].sort().join('|')
}

/** v1.4.0 (issue #17): matrix members — useful non-superseded entries + open FACT notes.
 *  The pairs are U×U plus F×U (every FACT against every useful entry): the human source is
 *  cross-checked against the extracted index, and superseded entries leave the matrix. */
function matrixMembers(state) {
  const entries = Object.keys(state.entries)
    .filter((id) => state.entries[id].useful && !state.entries[id].superseded)
    .sort()
  const facts = (state.notes || []).filter((n) => n.type === 'FACT' && n.status === 'open').map((n) => n.id).sort()
  return { entries, facts }
}

function consistencyLayout(state) {
  const c = state.consistency
  const { entries, facts } = matrixMembers(state)
  const pairs = []
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) pairs.push([entries[i], entries[j]])
  for (const f of facts) for (const e of entries) pairs.push([f, e])
  const missing = pairs.filter(([a, b]) => !c.verdicts[pairKey(a, b)]).map(([a, b]) => pairKey(a, b))
  const conflicts = pairs
    .filter(([a, b]) => c.verdicts[pairKey(a, b)] && c.verdicts[pairKey(a, b)].verdict === 'conflict')
    .map(([a, b]) => ({ pair: pairKey(a, b), note: c.verdicts[pairKey(a, b)].note }))
  return { pairs, missing, conflicts }
}

/** membership test for crosscheck verdicts: entries (useful, not superseded) + open FACT notes */
function matrixMemberSet(state) {
  const { entries, facts } = matrixMembers(state)
  return new Set([...entries, ...facts])
}

/** display text for a matrix member (entry content+quote, or the FACT note body) */
function matrixText(state, id) {
  const e = state.entries[id]
  if (e) return `${e.content} ${e.source_quote || ''}`
  const n = (state.notes || []).find((x) => x.id === id)
  return n ? n.body : ''
}

/** mechanical value-mismatch hints for a pair (informational aid, not blocking) */
function pairHints(state, a, b) {
  const fa = factValues(matrixText(state, a))
  const fb = factValues(matrixText(state, b))
  const hints = []
  for (const p of FACT_PATTERNS) {
    const va = fa[p.kind] || []
    const vb = fb[p.kind] || []
    if (!va.length || !vb.length) continue
    const shared = va.filter((v) => vb.includes(v))
    if (shared.length) continue
    hints.push(`${p.kind} differ: ${a}[${va.join(', ')}] vs ${b}[${vb.join(', ')}]`)
  }
  return hints
}

function recomputeConsistency(state) {
  const c = state.consistency
  const { pairs, missing, conflicts } = consistencyLayout(state)
  c.status = pairs.length === 0 ? 'n/a' : conflicts.length ? 'conflict' : missing.length ? 'pending' : 'passed'
  c.updatedAt = now()
  return c.status
}

function overallVerified(state) {
  return state.verification.status === 'passed' && ['passed', 'n/a'].includes(state.consistency.status)
}

/** routing once integrity + consistency are verified and the gaps gate is answered */
function afterGapsAnswered(state) {
  if (state.gates.interview.status === 'answered') {
    if (state.interview.answerOnly || state.presets.status === 'emitted') state.stage = 'plan'
    else state.stage = 'presets'
  } else {
    state.stage = 'interview'
    state.gates.interview.status = 'open'
  }
}

/** any edit that invalidates verification also invalidates emitted role cards */
function presetsStale(state) {
  if (state.presets && state.presets.status === 'emitted') {
    state.presets.status = 'stale'
    // v3.1: task drafts derive from the cards — keep the invalidation chain visible
    if (state.tasks && state.tasks.status === 'emitted') state.tasks.stale = true
  }
}

/** drop verdicts touching a changed/removed entry so its pairs must be re-reviewed */
function clearConsistencyFor(state, id) {
  const c = state.consistency
  if (!c || !c.verdicts) return
  for (const k of Object.keys(c.verdicts)) {
    if (k.split('|').includes(id)) delete c.verdicts[k]
  }
  recomputeConsistency(state)
}

async function renderConsistency(dirAbs, state) {
  const c = state.consistency
  const { pairs, missing, conflicts } = consistencyLayout(state)
  let md = `# Consistency review — ${now()}\n\nStatus: **${c.status}**. Logical coherence is NOT machine-provable: this is the enforced cross-check. Every pair of useful entries needs a verdict via \`docflow crosscheck verdicts=[{a, b, verdict: consistent|conflict, note}]\`. A \`conflict\` blocks the workflow until the conflicting entries are corrected (update_entry / remove_entry invalidates the verdict) and the pair re-reviewed.\n\n`
  if (pairs.length === 0) md += 'Fewer than two useful entries — nothing to cross-check; consistency passes automatically.\n'
  for (const [a, b] of pairs) {
    const v = c.verdicts[pairKey(a, b)]
    const hints = pairHints(state, a, b)
    const label = (id) => {
      const e = state.entries[id]
      if (e) return `**${id}** ${e.title} (${e.source_kind || 'doc'}): ${e.content}`
      const n = (state.notes || []).find((x) => x.id === id)
      return n ? `**${id}** (FACT note by the human on \`${n.target}\`): ${n.body}` : `**${id}**`
    }
    md += `## ${a} ↔ ${b}\n\n- ${label(a)}\n- ${label(b)}\n`
    if (hints.length) {
      md += '- ⚠ mechanical value hints: ' + hints.join('; ') + '\n'
    }
    md += v
      ? `- verdict: **${v.verdict.toUpperCase()}**${v.note ? ` — ${v.note}` : ''} (${v.at})\n\n`
      : '- verdict: _missing_\n\n'
  }
  await fs.writeFile(path.join(dirAbs, 'consistency.md'), md, 'utf8')
}

/** in-place upgrade of pre-current states; returns true if something changed */
function migrateState(state) {
  if (
    state.version === STATE_VERSION &&
    state.consistency &&
    state.gates &&
    state.gates.interview &&
    state.interview &&
    state.presets &&
    Array.isArray(state.notes) &&
    Array.isArray(state.supersedions)
  )
    return false
  let dirty = false
  if (!state.consistency) {
    state.consistency = { status: 'n/a', verdicts: {}, updatedAt: undefined }
    dirty = true
  }
  // v1.4.0 (issue #17): notes + supersedions shells (additive blocks, version stays 3 —
  // the v3.1 tasks precedent: fill on load, never bump for additive state)
  if (!Array.isArray(state.notes)) {
    state.notes = []
    dirty = true
  }
  if (!Array.isArray(state.supersedions)) {
    state.supersedions = []
    dirty = true
  }
  for (const e of Object.values(state.entries)) {
    if (!e.source_kind) {
      e.source_kind = 'doc'
      dirty = true
    }
  }
  if (!Array.isArray(state.discoveredDocs)) {
    state.discoveredDocs = []
    dirty = true
  }
  if (state.version !== STATE_VERSION) {
    if (state.version < 2) {
      // v1 trusted "line anchor, no quote" and had no consistency phase: force re-check
      if (state.verification && state.verification.status === 'passed') {
        state.verification.status = 'stale'
        state.stage = 'indexing'
      }
    }
    state.version = STATE_VERSION
    dirty = true
  }
  // v2 -> v3: interview gate + presets shells
  if (!state.gates) state.gates = { understanding: { status: 'open' }, gaps: { status: 'locked' } }
  if (!state.gates.interview) {
    state.gates.interview = { status: 'locked' }
    dirty = true
  }
  if (!state.interview) {
    state.interview = {}
    dirty = true
  }
  if (!state.presets) {
    state.presets = { status: 'none' }
    dirty = true
  }
  // a v2 state parked at plan must still pass the interview + presets gates
  // (a 'done' plan was written under v2 rules and is never revoked)
  if (state.stage === 'plan') {
    state.stage = 'interview'
    state.gates.interview.status = 'open'
    dirty = true
  }
  return dirty
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

async function appendMd(file, text) {
  await fs.appendFile(file, text, 'utf8')
}

/** create a gate markdown file with its header if missing (migrated folders predate newer gate files) */
async function ensureMd(file, header) {
  try {
    await fs.stat(file)
  } catch {
    await fs.writeFile(file, header, 'utf8')
  }
}

// ---------------------------------------------------------------------------
// workspace resolution
// ---------------------------------------------------------------------------

function resolveWorkspace(ctx, exec) {
  const wd = ctx.workingDirectory
  if (exec && exec.agent) {
    const session = ctx.sessions.get(exec.agent.id)
    if (session) {
      const dir = wd.get(session)
      if (dir) return dir
    }
  }
  return wd.defaultDirectory
}

// ---------------------------------------------------------------------------
// state load/save + index.md rendering
// ---------------------------------------------------------------------------

async function loadState(ctx, exec) {
  const cwd = resolveWorkspace(ctx, exec)
  const stored = await readJson(path.join(cwd, DEFAULT_DIR, 'state.json'))
  if (stored && stored.kind === 'docflow') return { cwd, dir: DEFAULT_DIR, state: stored }
  // a workflow may live in a custom folder; scan one level for state.json
  try {
    for (const ent of await fs.readdir(cwd, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name === DEFAULT_DIR) continue
      const data = await readJson(path.join(cwd, ent.name, 'state.json'))
      if (data && data.kind === 'docflow') return { cwd, dir: ent.name, state: data }
    }
  } catch {}
  return { cwd, dir: DEFAULT_DIR, state: undefined }
}

function entryLine(id, e) {
  const kind = e.source_kind || 'doc'
  const src =
    kind === 'external'
      ? `external \`${e.source_ref || '?'}\``
      : `internal \`${e.source_file}${e.source_line ? `:${e.source_line}` : ''}\``
  const lines = [`### ${id} — ${e.title}`, '', `> ${e.content}`, '', `- **Source** (${kind}): ${src}`]
  if (e.relevance) lines.push(`- **Relevance**: ${e.relevance}`)
  const v = e.verify
  if (v) {
    if (v.status === 'ok') lines.push(`- **Integrity**: ok (${v.detail})`)
    else if (v.status === 'failed') lines.push(`- **Integrity**: FAILED (${v.detail})`)
    else lines.push(`- **Integrity**: unanchored (${v.detail})`)
  } else {
    lines.push('- **Integrity**: not verified')
  }
  if (e.attest) lines.push(`- **Trustworthiness**: ${e.attest.verdict}${e.attest.note ? ` — ${e.attest.note}` : ''}`)
  else lines.push('- **Trustworthiness**: not attested')
  lines.push('')
  return lines.join('\n')
}

async function renderIndex(dirAbs, state) {
  const entries = state.entries
  const useful = Object.keys(entries).filter((id) => entries[id].useful).sort()
  const useless = Object.keys(entries).filter((id) => !entries[id].useful).sort()
  const out = [
    '# Project document index',
    '',
    `Generated by the docflow workflow. Objective: see \`${state.dir || DEFAULT_DIR}/objective.md\`. Stage: **${state.stage}**. Integrity: **${state.verification.status}** (last run ${state.verification.lastRun || 'never'}) · Consistency: **${(state.consistency && state.consistency.status) || 'n/a'}**.`,
    '',
    '## Useful information',
    '',
  ]
  if (useful.length === 0) out.push('_none yet_', '')
  for (const id of useful) out.push(entryLine(id, entries[id]))
  out.push('## Non-useful information (kept for traceability)', '')
  if (useless.length === 0) out.push('_none yet_', '')
  for (const id of useless) out.push(entryLine(id, entries[id]))
  if (state.pendingDocs && state.pendingDocs.length) {
    out.push('## Pending new documents', '')
    for (const p of state.pendingDocs) out.push(`- \`${p}\``)
    out.push('')
  }
  if (state.discoveredDocs && state.discoveredDocs.length) {
    out.push('## Discovered — new/changed files not yet ingested', '')
    for (const d of state.discoveredDocs) out.push(`- \`${d.path}\` (${d.kind}, seen ${d.seenAt})`)
    out.push('')
  }
  // v1.4.0 (issue #17): Review notes section — grouped by target, superseded last
  const notes = state.notes || []
  const sups = state.supersedions || []
  if (notes.length || sups.length) {
    out.push('## Review notes', '')
    const alive = notes.filter((n) => n.status !== 'superseded')
    const dead = notes.filter((n) => n.status === 'superseded')
    const byTarget = new Map()
    for (const n of alive) {
      if (!byTarget.has(n.target)) byTarget.set(n.target, [])
      byTarget.get(n.target).push(n)
    }
    if (alive.length === 0) out.push('_none active_', '')
    for (const [target, list] of byTarget) {
      out.push(`### On \`${target}\``, '')
      for (const n of list) out.push(`- **${n.id}** · ${n.type} · ${n.status} (${n.at}): ${n.body}`)
      out.push('')
    }
    if (dead.length) {
      out.push('### Superseded notes', '')
      for (const n of dead) out.push(`- **${n.id}** · ${n.type} · superseded (${n.at}): ${n.body}`)
      out.push('')
    }
    if (sups.length) {
      out.push('### Supersessions', '')
      for (const s of sups) out.push(`- **${s.id}** ${s.kind}: \`${s.fromId}\` superseded by \`${s.toId}\` (${s.at})`)
      out.push('')
    }
  }
  await fs.writeFile(path.join(dirAbs, 'index.md'), out.join('\n'), 'utf8')
}

function gateSummary(state, phase) {
  const g = state.gates[phase]
  if (!g) return 'locked'
  return g.status
}

function guidanceFor(state) {
  const g = []
  switch (state.stage) {
    case 'reading':
      g.push('Read the documents under doc_roots with your own tools (read/grep/glob).')
      if (state.readingScope && Array.isArray(state.readingScope.paths) && state.readingScope.paths.length)
        g.push(`SELECTIVE RE-READ (v1.3.3): the user scoped this re-read to ${state.readingScope.paths.length} file(s) — ${state.readingScope.paths.map((p) => '`' + p + '`').join(', ')} — re-read ONLY these; the other files keep their verification state and need no re-read. A later reflow to_stage=reading without paths (or an ingest) restores the full reading.`)
      if (state.gates.understanding.status === 'open')
        g.push('FORM UNDERSTANDING QUESTIONS: wherever the objective is ambiguous or a passage is unclear/unreliable w.r.t. the objective, ask the user with ask_user_question, then log them with action=gate_ask phase=understanding, and record the user answers with action=gate_answer phase=understanding. The understanding gate must be answered before entries can be recorded.')
      if (state.gates.understanding.reconfirm)
        g.push('New documents were ingested: reconfirm your understanding with the user (gate_ask + gate_answer phase=understanding).')
      if (state.gates.interview && state.gates.interview.reconfirm)
        g.push('New documents were ingested: after re-verification reconfirm the interview with the user — a gate_answer phase=interview re-answer updates the roles and marks emitted presets stale.')
      g.push('Filter what you read into USEFUL and NON-USEFUL information for the objective and record it with action=add_entries (batch several entries per call). Every entry MUST be source-backed with a verbatim source_quote and a source_kind: "doc" (source_file = project file) or "external" (source_ref = URL or absolute path of the external written source). Assumed content is not admissible.')
      break
    case 'indexing':
      g.push('Keep adding entries with add_entries as you read.')
      g.push('Then assess trustworthiness: check entries for contradictions or doubtful claims, and record your judgment with action=attest (verdict ok|suspect, ids or ["ALL"], note). Entries whose source_kind is "external" additionally require a human vouch: ask the user to review the source, then attest them with verdict "trusted".')
      g.push('Run action=verify for the INTEGRITY check: every entry source must be readable and its quote found verbatim (line-only anchors or assumed content FAIL). On failure re-read and fix the flagged passages.')
      g.push('When integrity passes you enter the CONSISTENCY phase: cross-check the entries logically (pairs) and record verdicts with action=crosscheck.')
      break
    case 'consistency':
      g.push('INTEGRITY passed. Now the LOGICAL CONSISTENCY phase: open consistency.md in the workflow folder — it lists every pair of useful entries to cross-check, with mechanical value hints (dates/versions/quantities that differ).')
      g.push('For EACH pair record your semantic judgment with action=crosscheck verdicts=[{a, b, verdict: consistent|conflict, note}]. Coverage must be complete.')
      g.push('A "conflict" verdict BLOCKS the workflow: fix the conflicting entries (update_entry/remove_entry invalidates that verdict), re-verify if needed, and re-review the pair until consistent.')
      break
    case 'recheck': {
      g.push('INTEGRITY FAILED. Re-read the cited passages for the failed/untrustworthy entries listed in the result, correct them with update_entry (or delete with remove_entry), re-attest doubtful ones, then run verify again.')
      break
    }
    case 'gaps':
      g.push('Integrity and logical consistency verified. NOW ASK ABOUT MISSING INFORMATION: identify what is still missing to reach the objective, ask the user with ask_user_question, then log with gate_ask phase=gaps and record answers with gate_answer phase=gaps.')
      break
    case 'interview':
      g.push('RUN THE INTERVIEW GATE: from the verified index PROPOSE to the user which agent roles are needed to reach the objective and the delivery type (code / documents / both) — or whether the objective is answer-only (analysis, no execution roles). This is a confirmation, not an interrogation: present your proposal with ask_user_question, log it with gate_ask phase=interview, and record the confirmed result with gate_answer phase=interview carrying the interview payload {answer_only?, delivery?, roles?}.')
      break
    case 'presets':
      g.push('WRITE THE ROLE CARDS: one card per confirmed role. Each card MUST justify itself with source_entries citing useful index entries (U…) — the existence of a role must be traceable to verified information (the role prompt_body itself is yours to write). Then call action=emit_presets cards=[{role, why, source_entries, prompt_body, write_scope?}]: the cards are rendered under agents/ + PRESETS.md and the plan gate opens.')
      break
    case 'plan':
      g.push('All gates satisfied. Write the notes and the plan to reach the objective, then call action=write_plan with notes_md and plan_md (markdown). They are saved to NOTES.md and PLAN.md.')
      if (state.presets && state.presets.status === 'emitted') {
        g.push('Reference the emitted role cards (agents/*.md) in the plan team section; write_plan appends the generated "Delivery & team (generated)" section.')
        g.push('With presets emitted write_plan lands on the tasks stage: draft the team tasks there with emit_tasks.')
      }
      break
    case 'tasks':
      g.push('WRITE THE TASK DRAFTS: one team task per unit of work from the plan, each assigned to a confirmed role (exact card name) and tagged with a PLAN.md phase. Call action=emit_tasks tasks=[{subject, description, role, plan_phase, write_scopes?, blocked_by?}] — rendered to TASKS.md, 1:1 mappable to team_task_create.')
      g.push('blocked_by may only reference other tasks in the same batch; write_scopes default to the role card write_scope.')
      g.push('If no task drafts make sense, call emit_tasks with tasks=[] plus skip_reason.')
      break
    case 'done':
      g.push('Workflow complete. If new documents arrive, use action=ingest to re-enter the loop.')
      break
    default:
      g.push('Call action=start with the objective and doc_roots.')
  }
  // v1.4.0 (issue #17): open notes are surfaced at every stage; FACTs drive the F×U matrix;
  // CONSTRAINTS are re-surfaced where they bind (interview proposal, plan writing)
  const notes = state.notes || []
  const openNotes = notes.filter((n) => n.status === 'open')
  if (openNotes.length) {
    const clip = (s) => (s.length > 60 ? s.slice(0, 60) + '…' : s)
    const listed = openNotes.slice(0, 6).map((n) => `${n.id}→${n.target} (${n.type}): "${clip(n.body)}"`)
    g.push(
      `OPEN NOTES (${openNotes.length}): ${listed.join('; ')}${openNotes.length > 6 ? '; …' : ''}. These are the user's own statements — acknowledge them; when one is consumed, mark it with action=note note_action=address id=<NOTE…> (open ids: ${openNotes.map((n) => n.id).join(', ')}).`,
    )
    const facts = openNotes.filter((n) => n.type === 'FACT')
    if (facts.length && ['indexing', 'consistency', 'recheck'].includes(state.stage))
      g.push(`FACT NOTES (${facts.map((f) => f.id).join(', ')}) join the consistency matrix as human-sourced pairs against every useful entry: run verify, then crosscheck the ${facts.map((f) => f.id).join('/') + '|U…'} pairs (crosscheck a/b accept NOTE ids). A conflict naming a FACT asks the user whether the fact replaces the entry; record the answer with action=note note_action=supersede.`)
    const cons = openNotes.filter((n) => n.type === 'CONSTRAINT')
    if (cons.length && (state.stage === 'interview' || state.stage === 'plan'))
      g.push(`OPEN CONSTRAINTS (re-surfaced): ${cons.map((n) => `${n.id}→${n.target}: ${clip(n.body)}`).join('; ')} — honor these in the ${state.stage === 'interview' ? 'interview proposal' : 'plan'}.`)
  }
  if (state.stage === 'consistency') {
    const factConf = consistencyLayout(state).conflicts.filter((cf) => cf.pair.split('|').some((p) => validNoteId(p)))
    if (factConf.length)
      g.push(`FACT CONFLICT on ${factConf.map((c) => c.pair).join(', ')}: ask the user (ask_user_question) whether the fact replaces the entry; on yes record action=note note_action=supersede supersede={fact:"NOTE…", entry:"U…", winner:"fact"|"entry"} — the supersession resolves the conflict and unblocks the matrix.`)
  }
  if (state.discoveredDocs && state.discoveredDocs.length) {
    const list = state.discoveredDocs.map((d) => `\`${d.path}\` (${d.kind})`).join(', ')
    g.push(`AUTO-DISCOVERY: ${state.discoveredDocs.length} file(s) under doc_roots are new or changed since the last ingest — ${list}. Surface this to the user and, once they acknowledge, call action=ingest with these paths to enter them in the flow. Do not ingest without the user's acknowledgement.`)
  }
  return g
}

function statusPayload(state, dirAbs) {
  const entries = Object.values(state.entries)
  const payload = {
    ok: true,
    stage: state.stage,
    objective: state.objective,
    doc_roots: state.doc_roots,
    folder: dirAbs,
    entries: {
      useful: entries.filter((e) => e.useful).length,
      not_useful: entries.filter((e) => !e.useful).length,
      superseded: entries.filter((e) => e.superseded).length,
    },
    gates: {
      understanding: gateSummary(state, 'understanding'),
      gaps: overallVerified(state) ? gateSummary(state, 'gaps') : 'locked until integrity + consistency pass',
      interview: overallVerified(state) ? gateSummary(state, 'interview') : 'locked until integrity + consistency pass',
    },
    interview: {
      status: gateSummary(state, 'interview'),
      delivery: state.interview.delivery || [],
      answer_only: !!state.interview.answerOnly,
      roles: state.interview.roles || [],
    },
    presets: {
      status: state.presets.status,
      cards: (state.presets.cards || []).map((c) => ({ role: c.role, source_entries: c.source_entries })),
      ...(state.presets.skipReason ? { skip_reason: state.presets.skipReason } : {}),
    },
    // v3.1: expose the tasks block as-is (camelCase per DESIGN §2) + count for chips
    tasks: state.tasks
      ? {
          ...state.tasks,
          stale: !!state.tasks.stale,
          warnings: state.tasks.warnings || [],
          count: Array.isArray(state.tasks.items) ? state.tasks.items.length : 0,
        }
      : { status: 'pending', stale: false, warnings: [], count: 0 },
    verification: state.verification.status,
    verified: overallVerified(state),
    // v1.3.1 §3: the legal reflow targets, discoverable for agents (panel can compute them too)
    reflow_targets: REFLOW_ORDER.slice(0, stagePos(state.stage) + 1),
    consistency: (() => {
      const cl = consistencyLayout(state)
      return { status: state.consistency.status, pairs: cl.pairs.length, missing: cl.missing, conflicts: cl.conflicts }
    })(),
    // v1.4.0 (issue #17): typed notes + supersession history (the panel renders both)
    notes: (state.notes || []).map((n) => ({ id: n.id, target: n.target, type: n.type, status: n.status, body: n.body, set_at: n.at })),
    supersedions: state.supersedions || [],
    pending_docs: state.pendingDocs || [],
    // v1.3.2 (issue #11): files discovered by the last scan, awaiting ingest.
    discovered: (state.discoveredDocs || []).map((d) => ({ path: d.path, kind: d.kind, seen_at: d.seenAt })),
    ...(state.docSnapshot
      ? {
          doc_snapshot: {
            taken_at: state.docSnapshot.takenAt,
            files: Object.keys(state.docSnapshot.files || {}).length,
            ...(state.docSnapshot.truncated ? { truncated: true } : {}),
          },
        }
      : {}),
    ...(state.readingScope
      ? { reading_scope: { paths: state.readingScope.paths, set_at: state.readingScope.setAt } }
      : {}),
    next: guidanceFor(state),
  }
  if (state.plan && state.plan.writtenAt) payload.plan = { notes: path.join(dirAbs, 'NOTES.md'), plan: path.join(dirAbs, 'PLAN.md') }
  return payload
}

function freshState(objective, docRoots, dirName) {
  return {
    kind: 'docflow',
    version: STATE_VERSION,
    dir: dirName,
    objective,
    doc_roots: docRoots,
    stage: 'reading',
    gates: {
      understanding: { status: 'open', asked: false, answered: false },
      gaps: { status: 'locked' },
      interview: { status: 'locked' },
    },
    interview: {},
    presets: { status: 'none' },
    verification: { status: 'unverified', lastRun: undefined, failed: [], unanchored: [], unattested: [] },
    consistency: { status: 'n/a', verdicts: {}, updatedAt: undefined },
    entries: {},
    // v1.4.0 (issue #17): typed review notes (NOTE…) + supersession records (SUP…)
    notes: [],
    supersedions: [],
    pendingDocs: [],
    // v1.3.2 (issue #11): mtime/size manifest of doc_roots taken at start/ingest, plus the
    // auto-discovered new/changed files still waiting for an ingest acknowledgement.
    docSnapshot: null,
    discoveredDocs: [],
    plan: {},
    createdAt: now(),
    updatedAt: now(),
  }
}

// ---------------------------------------------------------------------------
// v1.3.2 (issue #11): auto-discovery of new/changed files under doc_roots
// ---------------------------------------------------------------------------

const SCAN_FILE_CAP = 2000

function relPath(cwd, abs) {
  return path.relative(cwd, abs).split(path.sep).join('/')
}

/** mtime/size manifest of one root (file root = itself; dir root = bounded recursive walk). */
async function scanRootFiles(abs, cwd, files, counter) {
  let st
  try {
    st = await fs.stat(abs)
  } catch {
    return
  }
  if (st.isFile()) {
    files[relPath(cwd, abs)] = { m: Math.floor(st.mtimeMs), s: st.size }
    return
  }
  if (!st.isDirectory()) return
  const stack = [abs]
  while (stack.length) {
    const dir = stack.pop()
    let ents
    try {
      ents = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of ents) {
      if (counter.n >= SCAN_FILE_CAP) {
        counter.truncated = true
        return
      }
      const child = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        if (ent.name.startsWith('.') || ent.name === 'node_modules') continue
        stack.push(child)
      } else if (ent.isFile()) {
        let fst
        try {
          fst = await fs.stat(child)
        } catch {
          continue
        }
        files[relPath(cwd, child)] = { m: Math.floor(fst.mtimeMs), s: fst.size }
        counter.n++
      }
    }
  }
}

async function snapshotDocRoots(cwd, docRoots) {
  const files = {}
  const counter = { n: 0, truncated: false }
  for (const root of docRoots || []) await scanRootFiles(path.resolve(cwd, root), cwd, files, counter)
  return { files, truncated: counter.truncated }
}

/** Diff the live scan against the stored snapshot; keep seenAt stable for repeated discoveries. */
function applyDiscovery(state, scan) {
  const prev = (state.docSnapshot && state.docSnapshot.files) || {}
  const found = []
  for (const [p, v] of Object.entries(scan.files)) {
    const old = prev[p]
    if (!old) found.push({ path: p, kind: 'new' })
    else if (old.m !== v.m || old.s !== v.s) found.push({ path: p, kind: 'changed' })
  }
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const was = {}
  for (const d of state.discoveredDocs || []) was[d.path] = d
  state.discoveredDocs = found.map((f) => ({ path: f.path, kind: f.kind, seenAt: (was[f.path] || {}).seenAt || now() }))
}

/**
 * Re-scan doc_roots and refresh state.discoveredDocs. The first call on a pre-v1.3.2
 * workflow only takes the baseline (already-read docs must not flood the notice).
 * Returns true when state changed enough to be worth persisting.
 */
async function discoverDocs(cwd, state) {
  if (!state.docSnapshot) {
    const scan = await snapshotDocRoots(cwd, state.doc_roots)
    state.docSnapshot = { takenAt: now(), files: scan.files, truncated: scan.truncated }
    state.discoveredDocs = []
    return true
  }
  const before = (state.discoveredDocs || []).map((d) => `${d.path}:${d.kind}`).join('|')
  const scan = await snapshotDocRoots(cwd, state.doc_roots)
  applyDiscovery(state, scan)
  return before !== state.discoveredDocs.map((d) => `${d.path}:${d.kind}`).join('|')
}

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

async function verifyEntries(cwd, state) {
  const failed = []
  const unanchored = []
  const unattested = []
  const suspect = []
  const externals = []
  for (const [id, e] of Object.entries(state.entries)) {
    if (e.superseded) continue // v1.4.0: superseded entries leave the integrity check (kept as history)
    let status = 'unanchored'
    let detail = 'no verbatim quote: content is assumed — not allowed'
    const hasQuote = typeof e.source_quote === 'string' && e.source_quote.trim() !== ''
    if ((e.source_kind || 'doc') === 'external') {
      const ref = typeof e.source_ref === 'string' ? e.source_ref.trim() : ''
      const isUrl = /^https?:\/\//i.test(ref)
      if (!ref) {
        status = 'failed'
        detail = 'external entry without source_ref (URL or absolute path): source is assumed — not allowed'
      } else if (!hasQuote) {
        status = 'failed'
        detail = 'external entry without verbatim source_quote: content is assumed — not allowed'
      } else if (e.attest && e.attest.verdict === 'trusted') {
        status = 'ok'
        detail = `external source vouched by human (trusted): ${ref}`
      } else if (isUrl) {
        status = 'ok'
        detail = `external URL declared (${ref}); quote recorded — verify by eye, then attest verdict "trusted"`
        externals.push(id)
      } else {
        try {
          const text = await fs.readFile(ref, 'utf8')
          if (normSpace(text).includes(normSpace(e.source_quote))) {
            status = 'ok'
            detail = 'external file readable, quote found verbatim — source trustworthiness: attest verdict "trusted" after review'
            externals.push(id)
          } else {
            status = 'failed'
            detail = `quote not found in external file ${ref}`
          }
        } catch (err) {
          status = 'failed'
          detail = `external file unreadable: ${err.code || err.message}`
        }
      }
    } else {
      const abs = path.isAbsolute(e.source_file) ? e.source_file : path.resolve(cwd, e.source_file)
      try {
        const text = await fs.readFile(abs, 'utf8')
        if (hasQuote) {
          const hay = normSpace(text)
          const needle = normSpace(e.source_quote)
          const at = hay.indexOf(needle)
          if (at >= 0) {
            let lineNo
            try {
              const flex = new RegExp(needle.split(' ').slice(0, 8).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'))
              const m = flex.exec(text)
              if (m) lineNo = text.slice(0, m.index).split('\n').length
            } catch {}
            status = 'ok'
            detail = `quote found verbatim${lineNo ? ` near line ${lineNo}` : ''}`
          } else {
            status = 'failed'
            detail = 'quote not found in file (file changed or quote inexact)'
          }
        } else if (e.source_line) {
          status = 'failed'
          detail = 'line anchor without verbatim quote: content is not source-backed (assumed)'
        }
      } catch (err) {
        status = 'failed'
        detail = `source file unreadable: ${err.code || err.message}`
      }
    }
    e.verify = { status, detail, at: now() }
    if (status === 'failed') failed.push(id)
    else if (status === 'unanchored') unanchored.push(id)
    if (!e.attest) unattested.push(id)
    else if (!['ok', 'trusted'].includes(e.attest.verdict)) suspect.push(id)
  }
  const problems = { failed, unanchored, unattested, suspect, externals }
  const passed = failed.length === 0 && unanchored.length === 0 && unattested.length === 0 && suspect.length === 0 && externals.length === 0
  return { passed, problems }
}

// ---------------------------------------------------------------------------
// agent role presets (emit_presets)
// ---------------------------------------------------------------------------

function roleSlug(role) {
  const s = String(role).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return s || 'role'
}

/** advisory overlap: string-equal or one scope is a path prefix of the other */
function scopeOverlap(a, b) {
  const na = String(a).replace(/\/+$/, '')
  const nb = String(b).replace(/\/+$/, '')
  return na === nb || na.startsWith(nb + '/') || nb.startsWith(na + '/')
}

// ---------------------------------------------------------------------------
// team task drafts (emit_tasks) — v3.1 "Team bridge"
// ---------------------------------------------------------------------------

function taskSlug(subject) {
  const s = String(subject).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return s || 'task'
}

/** collision-suffixed slug (same convention as preset slugs: -2, -3, …); registers it in `used` */
function uniqueSlug(base, used) {
  let s = base
  let k = 2
  while (used.has(s)) s = `${base}-${k++}`
  used.add(s)
  return s
}

/**
 * PLAN.md phase markers (DESIGN §4.7): bold-only `**…**` lines under a heading
 * whose text contains "Fasi"/"Phases", plus `###` headings anywhere.
 */
function planPhaseMarkers(planText) {
  const out = []
  let inSection = false
  let fence = false
  for (const line of String(planText).split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence
      continue
    }
    if (fence) continue
    const h = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (h) {
      const lvl = h[1].length
      const text = h[2].replace(/\*\*/g, '').trim()
      if (lvl === 3) out.push(text)
      if (lvl <= 2) inSection = /fasi|phases/i.test(text)
      continue
    }
    if (!inSection) continue
    const b = /^\s*\*\*([^*]+)\*\*:?\s*$/.exec(line)
    if (b) out.push(b[1].trim())
  }
  return [...new Set(out.filter((s) => s !== ''))]
}

/** first cycle path [a, b, …, a] in a blocked_by graph (self-reference included), else null */
function findBlockedCycle(deps) {
  const mark = new Map() // id -> 1 on recursion stack, 2 fully explored
  const stack = []
  let found = null
  const visit = (id) => {
    if (found) return
    const m = mark.get(id)
    if (m === 1) {
      found = [...stack.slice(stack.indexOf(id)), id]
      return
    }
    if (m === 2) return
    mark.set(id, 1)
    stack.push(id)
    for (const d of deps.get(id) || []) {
      visit(d)
      if (found) return
    }
    stack.pop()
    mark.set(id, 2)
  }
  for (const id of deps.keys()) {
    visit(id)
    if (found) return found
  }
  return null
}

/** TASKS.md rendering (DESIGN §6) — the state.json "tasks" block stays authoritative */
function tasksDoc(state) {
  const t = state.tasks
  let md =
    '# Task drafts\n\n' +
    '<!-- machine consumers: state.json "tasks" block is authoritative -->\n\n' +
    'Each item maps 1:1 to a team_task_create call (subject/description/blocked_by/write_scopes).\n'
  if (t && t.status === 'skipped') return `${md}\n_Skipped: ${t.skipReason}_\n`
  for (const it of (t && t.items) || []) {
    md += `\n## ${it.subject}\n\n- **role**: ${it.role} · **plan phase**: ${it.plan_phase}\n`
    md += `- **write_scopes**: ${it.write_scopes.length ? it.write_scopes.map((s) => '`' + s + '`').join(', ') : '—'}\n`
    md += `- **blocked_by**: ${it.blocked_by.length ? it.blocked_by.join(', ') : 'none'}\n\n${it.description}\n`
  }
  return md
}

/** write_plan pointer value (DESIGN §7) */
function tasksPointer(state) {
  const t = state.tasks
  if (!t) return 'pending'
  return t.status === 'emitted' ? `emitted ${(t.items || []).length}` : 'skipped'
}

// ---------------------------------------------------------------------------
// v1.4.0 (issue #17): review notes — shared mutation core (tool + route parity)
// ---------------------------------------------------------------------------

/** Mutates `state` in place for note add/address/supersede/restore; returns
 *  { ok, ...payload, touchesMatrix } — the caller persists. `list` is read-only. */
function noteMutate(state, action, payload) {
  switch (action) {
    case 'add': {
      const n = payload.note
      if (!n || typeof n !== 'object') return { ok: false, error: 'note add requires note: {target, type, body}.' }
      const terr = noteTargetError(state, n.target)
      if (terr) return { ok: false, error: terr }
      if (!NOTE_TYPES.includes(n.type))
        return { ok: false, error: `note.type must be one of ${NOTE_TYPES.join(', ')} (a QUESTION is the gates' job, not a note).` }
      const body = typeof n.body === 'string' ? n.body.trim() : ''
      if (body === '') return { ok: false, error: 'note.body is required (the statement itself).' }
      if (body.length > NOTE_BODY_MAX) return { ok: false, error: `note.body exceeds ${NOTE_BODY_MAX} characters.` }
      const rec = { id: nextNoteId(state), target: String(n.target).trim(), type: n.type, body, author: 'human', at: now(), status: 'open' }
      state.notes.push(rec)
      return { ok: true, note: rec, touchesMatrix: rec.type === 'FACT' }
    }
    case 'address': {
      if (!validNoteId(payload.id)) return { ok: false, error: 'note address requires id: a NOTE… id.' }
      const rec = state.notes.find((x) => x.id === payload.id)
      if (!rec) return { ok: false, error: `Unknown note id ${payload.id}.` }
      if (rec.status !== 'open') return { ok: false, error: `Note ${payload.id} is already ${rec.status}.` }
      rec.status = 'addressed'
      rec.addressedAt = now()
      return { ok: true, note: rec, touchesMatrix: rec.type === 'FACT' }
    }
    case 'supersede': {
      const sp = payload.supersede
      if (!sp || !validNoteId(sp.fact) || !validId(sp.entry))
        return { ok: false, error: 'note supersede requires supersede: {fact: NOTE…, entry: U…|N…, winner: "fact"|"entry"}.' }
      if (sp.winner !== 'fact' && sp.winner !== 'entry')
        return { ok: false, error: 'supersede.winner must be "fact" (the fact replaces the entry) or "entry" (the fact is dropped).' }
      const note = state.notes.find((x) => x.id === sp.fact)
      if (!note) return { ok: false, error: `Unknown note id ${sp.fact}.` }
      if (note.type !== 'FACT') return { ok: false, error: `Note ${sp.fact} is a ${note.type} note: only FACT notes can supersede entries.` }
      const entry = state.entries[sp.entry]
      if (!entry) return { ok: false, error: `Unknown entry id ${sp.entry}.` }
      if (entry.superseded) return { ok: false, error: `Entry ${sp.entry} is already superseded (by ${entry.superseded.by}).` }
      const key = pairKey(sp.fact, sp.entry)
      const v = state.consistency.verdicts[key]
      if (!v || v.verdict !== 'conflict')
        return { ok: false, error: `Supersession requires a recorded conflict verdict on ${key} — run crosscheck first, then ask the user.` }
      const sup = {
        id: nextSupId(state),
        kind: sp.winner === 'fact' ? 'entry→fact' : 'fact→entry',
        fromId: sp.winner === 'fact' ? sp.entry : sp.fact,
        toId: sp.winner === 'fact' ? sp.fact : sp.entry,
        at: now(),
      }
      if (sp.winner === 'fact') {
        entry.superseded = { by: sp.fact, sup: sup.id, at: sup.at }
        entry.updatedAt = now()
        note.status = 'addressed'
        note.addressedAt = now()
      } else {
        note.status = 'superseded'
      }
      state.supersedions.push(sup)
      return { ok: true, supersession: sup, touchesMatrix: true }
    }
    case 'restore': {
      if (!validSupId(payload.id)) return { ok: false, error: 'note restore requires id: a SUP… supersession id.' }
      const idx = state.supersedions.findIndex((s) => s.id === payload.id)
      if (idx === -1) return { ok: false, error: `Unknown supersession id ${payload.id}.` }
      const sup = state.supersedions[idx]
      state.supersedions.splice(idx, 1)
      if (state.entries[sup.fromId]) {
        delete state.entries[sup.fromId].superseded
        state.entries[sup.fromId].updatedAt = now()
      }
      const loserNote = state.notes.find((x) => x.id === sup.fromId)
      if (loserNote) loserNote.status = 'open'
      // the winning FACT note is withdrawn with the supersession (issue #17 restore semantics)
      if (validNoteId(sup.toId)) state.notes = state.notes.filter((x) => x.id !== sup.toId)
      return { ok: true, restored: sup, touchesMatrix: true }
    }
    default:
      return { ok: false, error: 'note_action must be add|list|address|restore|supersede.' }
  }
}

/** Persist a noteMutate result: matrix bookkeeping + state.json + index.md.
 *  Supersede/restore change the index basis: verification goes stale, presets/tasks take
 *  the staleness chain, and the stage parks where the recomputed consistency says so. */
async function persistNoteMutation(dirAbs, state, res) {
  const out = {}
  if (res.touchesMatrix) {
    const sup = res.supersession || res.restored
    if (sup) {
      clearConsistencyFor(state, sup.fromId)
      clearConsistencyFor(state, sup.toId)
      state.verification.status = 'stale'
      presetsStale(state)
      const cl = consistencyLayout(state)
      out.consistency = state.consistency.status
      out.pairs = cl.pairs.length
      await renderConsistency(dirAbs, state)
      out.stage = state.stage = out.consistency === 'pending' ? 'consistency' : 'indexing'
    } else {
      clearConsistencyFor(state, res.note.id)
      const cl = consistencyLayout(state)
      out.consistency = state.consistency.status
      out.pairs = cl.pairs.length
      await renderConsistency(dirAbs, state)
      if (res.note.type === 'FACT' && (out.consistency === 'passed' || out.consistency === 'n/a') && state.stage === 'consistency') {
        if (state.gates.gaps.status === 'answered') afterGapsAnswered(state)
        else {
          state.stage = 'gaps'
          state.gates.gaps.status = 'open'
        }
        out.stage = state.stage
      }
    }
  } else if (res.note && res.note.type === 'FACT') {
    // fresh FACT at a verified index: its F×U pairs are missing → consistency demotes to pending
    const cl = consistencyLayout(state)
    out.consistency = recomputeConsistency(state)
    out.pairs = cl.pairs.length
    await renderConsistency(dirAbs, state)
    if (out.consistency === 'pending' && state.verification.status === 'passed') {
      state.stage = 'consistency'
      out.stage = state.stage
    }
  }
  state.updatedAt = now()
  await writeJson(path.join(dirAbs, 'state.json'), state)
  await renderIndex(dirAbs, state)
  return out
}

// ---------------------------------------------------------------------------
// tool implementation
// ---------------------------------------------------------------------------

async function runDocflow(ctx, exec, args) {
  const action = args.action
  const { cwd, dir, state } = await loadState(ctx, exec)
  const dirAbs = path.join(cwd, dir)

  if (action !== 'start' && action !== 'status' && action !== 'reset' && !state)
    return fail('No workflow started in this workspace.', 'Call action=start with objective and doc_roots first. Use action=status to inspect, or start() to begin.')

  if (state) state.updatedAt = now()
  if (state && migrateState(state)) await writeJson(path.join(dirAbs, 'state.json'), state)

  switch (action) {
    case 'start': {
      if (state) return fail('A workflow already exists in this workspace.', 'Use action=status to inspect it, or action=reset (confirm="delete") to remove it and start over.')
      if (typeof args.objective !== 'string' || args.objective.trim() === '') return fail('start requires a non-empty objective.', 'Ask the user for the objective first (ask_user_question) if it is not obvious from the conversation.')
      if (!Array.isArray(args.doc_roots) || args.doc_roots.length === 0) return fail('start requires doc_roots: the directories/files to read.')
      const dirName = safeDirName(args.dir)
      const startAbs = path.join(cwd, dirName)
      const st = freshState(args.objective.trim(), args.doc_roots, dirName)
      await fs.mkdir(startAbs, { recursive: true })
      await fs.writeFile(
        path.join(startAbs, 'objective.md'),
        `# Objective\n\n${st.objective}\n\nDocument roots:\n${st.doc_roots.map((d) => `- ${d}`).join('\n')}\n\nStarted: ${st.createdAt}\n`,
        'utf8',
      )
      for (const gd of Object.values(GATE_DOCS)) await fs.writeFile(path.join(startAbs, gd.file), gd.header, 'utf8')
      // v1.3.2 (issue #11): baseline manifest — everything under doc_roots at start is "already known".
      const baseScan = await snapshotDocRoots(cwd, st.doc_roots)
      st.docSnapshot = { takenAt: now(), files: baseScan.files, truncated: baseScan.truncated }
      await writeJson(path.join(startAbs, 'state.json'), st)
      await renderIndex(startAbs, st)
      return { ok: true, stage: st.stage, folder: startAbs, next: guidanceFor(st) }
    }

    case 'status':
      if (!state)
        return {
          ok: true,
          stage: 'no-workflow',
          next: 'Call action=start with objective (as defined by the user) and doc_roots (documents/directories to read). If the objective is not clear from the conversation, ask the user first.',
        }
      // v1.3.2 (issue #11): on-demand auto-discovery — every status call diffs doc_roots
      // against the last snapshot and keeps notifying until the files are ingested.
      if (await discoverDocs(cwd, state)) {
        await writeJson(path.join(dirAbs, 'state.json'), state)
        await renderIndex(dirAbs, state)
      }
      return statusPayload(state, dirAbs)

    case 'reset': {
      if (args.confirm !== 'delete') return fail('reset requires confirm="delete" — it removes the workflow folder and all its files.', 'Re-issue with confirm="delete" only if the user asked to discard this workflow.')
      await fs.rm(dirAbs, { recursive: true, force: true })
      return { ok: true, removed: dirAbs }
    }

    case 'gate_ask': {
      const phase = args.phase
      if (phase !== 'understanding' && phase !== 'gaps' && phase !== 'interview') return fail('gate_ask requires phase=understanding|gaps|interview.')
      if (!Array.isArray(args.questions) || args.questions.length === 0) return fail('gate_ask requires questions: [{question, why?}].')
      if ((phase === 'gaps' || phase === 'interview') && !overallVerified(state)) return fail(`The ${phase} gate opens only after verify (integrity) passes AND the consistency matrix is complete.`, 'Record entries, attest, run verify, then close the crosscheck with action=crosscheck; then ask the gate questions.')
      const g = state.gates[phase]
      g.status = 'pending'
      g.asked = true
      g.askedAt = now()
      const gd = GATE_DOCS[phase]
      const file = path.join(dirAbs, gd.file)
      await ensureMd(file, gd.header)
      let md = `\n## Asked ${now()}\n\n`
      for (const q of args.questions) md += `- **Q**: ${q.question}${q.why ? `\n  - _why_: ${q.why}` : ''}\n`
      await appendMd(file, md)
      await writeJson(path.join(dirAbs, 'state.json'), state)
      return { ok: true, phase, logged: args.questions.length, next: `Now ask these questions to the user with ask_user_question, then record the answers with gate_answer phase=${phase}.` }
    }

    case 'gate_answer': {
      const phase = args.phase
      if (phase !== 'understanding' && phase !== 'gaps' && phase !== 'interview') return fail('gate_answer requires phase=understanding|gaps|interview.')
      if (!Array.isArray(args.answers) || args.answers.length === 0) return fail('gate_answer requires answers: [{question, answer}] as the user replied.')
      const g = state.gates[phase]
      if (g.status === 'locked') return fail(`The ${phase} gate is locked.`, phase === 'gaps' || phase === 'interview' ? 'Run verify successfully first.' : undefined)
      const iv = phase === 'interview' ? args.interview : undefined
      if (phase === 'interview') {
        if (!iv || typeof iv !== 'object')
          return fail('gate_answer phase=interview requires the interview payload {answer_only?, delivery?, roles?} as confirmed by the user.', 'Either answer_only: true (analysis-only objective), or delivery: a non-empty array of "code"/"docs" plus roles: a non-empty array of role name strings.')
        if (iv.answer_only !== true) {
          const okDelivery = Array.isArray(iv.delivery) && iv.delivery.length > 0 && iv.delivery.every((d) => d === 'code' || d === 'docs')
          const okRoles = Array.isArray(iv.roles) && iv.roles.length > 0 && iv.roles.every((r) => typeof r === 'string' && r.trim() !== '')
          if (!okDelivery || !okRoles) return fail('The interview payload needs delivery: a non-empty array of "code"|"docs" AND roles: a non-empty array of role names — or answer_only: true for an analysis-only objective.')
        }
      }
      g.status = 'answered'
      g.asked = true
      g.answered = true
      g.answeredAt = now()
      if (phase === 'understanding') g.reconfirm = false
      const gd = GATE_DOCS[phase]
      const file = path.join(dirAbs, gd.file)
      await ensureMd(file, gd.header)
      let md = `\n## Answers ${now()}\n\n`
      for (const a of args.answers) md += `- **Q**: ${a.question}\n  - **A**: ${a.answer}\n`
      if (iv)
        md += `- **Interview result**: ${iv.answer_only === true ? 'answer-only (analysis, no execution roles)' : `delivery=${iv.delivery.join('+')}; roles=${iv.roles.map((r) => r.trim()).join(', ')}`}\n`
      await appendMd(file, md)
      if (phase === 'interview') {
        presetsStale(state)
        const answerOnly = iv.answer_only === true
        state.interview = {
          answerOnly,
          delivery: answerOnly ? [] : iv.delivery.slice(),
          roles: answerOnly ? [] : iv.roles.map((r) => r.trim()),
          answeredAt: now(),
        }
        g.reconfirm = false
        if (answerOnly) {
          state.presets = { status: 'skipped', skipReason: 'interview: delivery=answer-only, no execution roles', skippedAt: now() }
          state.stage = 'plan'
        } else {
          state.stage = 'presets'
        }
      }
      if (phase === 'gaps' && overallVerified(state)) afterGapsAnswered(state)
      await writeJson(path.join(dirAbs, 'state.json'), state)
      await renderIndex(dirAbs, state)
      return { ok: true, phase, stage: state.stage, next: guidanceFor(state) }
    }

    case 'add_entries': {
      if (!Array.isArray(args.entries) || args.entries.length === 0) return fail('add_entries requires entries: [{useful, title, content, source_file, source_line?, source_quote?, relevance?}].')
      const ug = state.gates.understanding
      if (ug.status !== 'answered') return fail('Record entries only after the understanding gate is answered.', 'Ask the user the understanding questions (gate_ask/gate_answer phase=understanding) first.')
      if (ug.reconfirm) return fail('New documents were ingested: reconfirm understanding with the user before recording more entries.', 'gate_ask + gate_answer phase=understanding.')
      const added = []
      for (const raw of args.entries) {
        if (typeof raw.title !== 'string' || typeof raw.content !== 'string')
          return fail('Each entry requires title and content.')
        const kind = raw.source_kind === 'external' ? 'external' : 'doc'
        if (typeof raw.source_quote !== 'string' || raw.source_quote.trim() === '')
          return fail(`Entry "${raw.title}": source_quote (verbatim) is MANDATORY — information without a written source is not admissible.`)
        if (kind === 'doc' && typeof raw.source_file !== 'string')
          return fail(`Entry "${raw.title}": source_kind "doc" requires source_file (project file path).`)
        if (kind === 'external' && (typeof raw.source_ref !== 'string' || raw.source_ref.trim() === ''))
          return fail(`Entry "${raw.title}": source_kind "external" requires source_ref (URL or absolute path of the external written source).`)
        const id = nextId(state, raw.useful ? 'U' : 'N')
        state.entries[id] = {
          useful: !!raw.useful,
          title: raw.title,
          content: raw.content,
          source_kind: kind,
          source_file: kind === 'doc' ? raw.source_file : undefined,
          source_line: kind === 'doc' && Number.isFinite(raw.source_line) ? raw.source_line : undefined,
          source_ref: kind === 'external' ? raw.source_ref.trim() : undefined,
          source_quote: raw.source_quote,
          relevance: raw.relevance,
          addedAt: now(),
        }
        added.push(id)
      }
      state.stage = 'indexing'
      delete state.readingScope // v1.3.3: leaving reading ends any selective re-read scope
      if (state.verification.status === 'passed') state.verification.status = 'stale'
      presetsStale(state)
      await writeJson(path.join(dirAbs, 'state.json'), state)
      await renderIndex(dirAbs, state)
      return { ok: true, added, stage: state.stage, next: guidanceFor(state) }
    }

    case 'update_entry': {
      if (!validId(args.id)) return fail('update_entry requires a valid id (e.g. U3).')
      const e = state.entries[args.id]
      if (!e) return fail(`Unknown entry id ${args.id}.`)
      for (const k of ['title', 'content', 'relevance', 'source_file', 'source_quote', 'source_ref', 'source_kind'])
        if (typeof args.fields?.[k] === 'string') e[k] = args.fields[k]
      if (typeof args.fields?.source_line === 'number') e.source_line = args.fields.source_line
      if (typeof args.fields?.useful === 'boolean') e.useful = args.fields.useful
      e.updatedAt = now()
      e.attest = undefined
      e.verify = undefined
      state.verification.status = 'stale'
      presetsStale(state)
      clearConsistencyFor(state, args.id)
      await writeJson(path.join(dirAbs, 'state.json'), state)
      await renderIndex(dirAbs, state)
      return { ok: true, id: args.id, note: 'Entry updated: attestation and verification were cleared for it.', next: guidanceFor(state) }
    }

    case 'remove_entry': {
      if (!validId(args.id)) return fail('remove_entry requires a valid id (e.g. U3).')
      if (!state.entries[args.id]) return fail(`Unknown entry id ${args.id}.`)
      delete state.entries[args.id]
      state.verification.status = 'stale'
      presetsStale(state)
      clearConsistencyFor(state, args.id)
      await writeJson(path.join(dirAbs, 'state.json'), state)
      await renderIndex(dirAbs, state)
      return { ok: true, removed: args.id }
    }

    case 'attest': {
      if (args.verdict !== 'ok' && args.verdict !== 'suspect' && args.verdict !== 'trusted') return fail('attest requires verdict ok|suspect|trusted (trusted = human vouch for an external URL source).')
      const ids = Array.isArray(args.ids) && args.ids.length ? args.ids : ['ALL']
      const targets = ids[0] === 'ALL' ? Object.keys(state.entries) : ids
      if (targets.length === 0) return fail('No entries to attest yet.')
      for (const id of targets) {
        const e = state.entries[id]
        if (!e) return fail(`Unknown entry id ${id}.`)
        e.attest = { verdict: args.verdict, note: args.attest_note !== undefined ? args.attest_note : args.note, at: now() }
      }
      state.verification.status = 'stale'
      presetsStale(state)
      await writeJson(path.join(dirAbs, 'state.json'), state)
      await renderIndex(dirAbs, state)
      return { ok: true, attested: targets.length, verdict: args.verdict, next: 'Now run verify: INTEGRITY (sources readable + quotes verbatim). If it passes, close the CONSISTENCY matrix with action=crosscheck.' }
    }

    case 'verify': {
      if (Object.keys(state.entries).length === 0) return fail('Nothing to verify: record entries first.')
      const { passed, problems } = await verifyEntries(cwd, state)
      state.verification = {
        status: passed ? 'passed' : 'failed',
        lastRun: now(),
        failed: problems.failed,
        unanchored: problems.unanchored,
        unattested: problems.unattested,
        suspect: problems.suspect,
        externals: problems.externals,
      }
      let report = `# Integrity report — ${state.verification.lastRun}\n\nResult: **${passed ? 'PASSED' : 'FAILED'}**\n\n`
      if (problems.failed.length) report += `Failed anchors / assumed content (re-read and fix): ${problems.failed.join(', ')}\n\n`
      if (problems.unanchored.length) report += `Unanchored entries (no verbatim quote — NOT admissible): ${problems.unanchored.join(', ')}\n\n`
      if (problems.unattested.length) report += `Not yet attested for trustworthiness: ${problems.unattested.join(', ')}\n\n`
      if (problems.suspect.length) report += `Attested as suspect: ${problems.suspect.join(', ')}\n\n`
      if (problems.externals.length) report += `External sources awaiting human vouch (review the source, then attest verdict "trusted" for these ids): ${problems.externals.join(', ')}\n\n`
      await fs.writeFile(path.join(dirAbs, 'verification.md'), report, 'utf8')
      let consistency = state.consistency.status
      let pendingCleared = 0
      if (passed) {
        // v1.3.5 (issue #15): verification passing is what materially closes the
        // ingest round — every pending document has been read, its entries
        // recorded and re-anchored. Before this the list had no consumption
        // point and ingested files sat in "New documents pending" forever.
        if (Array.isArray(state.pendingDocs) && state.pendingDocs.length) {
          pendingCleared = state.pendingDocs.length
          state.pendingDocs = []
        }
        consistency = recomputeConsistency(state)
        await renderConsistency(dirAbs, state)
        if (consistency === 'passed' || consistency === 'n/a') {
          if (state.gates.gaps.status === 'answered') afterGapsAnswered(state)
          else {
            state.stage = 'gaps'
            state.gates.gaps.status = 'open'
          }
        } else {
          state.stage = 'consistency'
        }
      } else {
        state.stage = 'recheck'
      }
      await writeJson(path.join(dirAbs, 'state.json'), state)
      await renderIndex(dirAbs, state)
      return {
        ok: passed,
        passed,
        stage: state.stage,
        problems,
        consistency,
        verified: overallVerified(state),
        ...(problems.externals.length
          ? { hint: 'External sources block VERIFIED until a human vouches for them: ask the user to review each listed source, then attest verdict "trusted" for those ids, then verify again.' }
          : {}),
        report: path.join(dirAbs, 'verification.md'),
        ...(pendingCleared ? { pending_cleared: `${pendingCleared} pending document(s) acknowledged — integrity passed on the re-verified index` } : {}),
        next: guidanceFor(state),
      }
    }

    case 'crosscheck': {
      if (state.verification.status !== 'passed') return fail('The consistency matrix opens only after verify (integrity) passes.', guidanceFor(state).join(' '))
      if (!Array.isArray(args.verdicts) || args.verdicts.length === 0) return fail('crosscheck requires verdicts: [{a, b, verdict: consistent|conflict, note?}].')
      const layout = consistencyLayout(state)
      const validPairs = new Set(layout.pairs.map(([a, b]) => pairKey(a, b)))
      const members = matrixMemberSet(state)
      const stored = []
      for (const v of args.verdicts) {
        const known = (x) => (validId(x) && state.entries[x]) || validNoteId(x)
        if (!known(v.a) || !known(v.b)) return fail(`crosscheck verdict references unknown matrix member: ${v.a} / ${v.b}.`)
        if (!members.has(v.a) || !members.has(v.b))
          return fail('Only useful non-superseded entries and open FACT notes take part in the consistency matrix.')
        if (v.a === v.b) return fail('A pair needs two distinct members.')
        if (v.verdict !== 'consistent' && v.verdict !== 'conflict') return fail('Each verdict must be "consistent" or "conflict".')
        const k = pairKey(v.a, v.b)
        if (!validPairs.has(k)) return fail(`crosscheck verdict ${k} is not a pair in the current matrix (pairs: ${[...validPairs].join(', ') || 'none'}).`)
        state.consistency.verdicts[k] = { verdict: v.verdict, note: typeof v.note === 'string' ? v.note : undefined, at: now() }
        stored.push(k)
      }
      const cs = recomputeConsistency(state)
      await renderConsistency(dirAbs, state)
      if (cs === 'passed' || cs === 'n/a') {
        if (state.gates.gaps.status === 'answered') afterGapsAnswered(state)
        else {
          state.stage = 'gaps'
          state.gates.gaps.status = 'open'
        }
      } else {
        state.stage = 'consistency'
      }
      await writeJson(path.join(dirAbs, 'state.json'), state)
      await renderIndex(dirAbs, state)
      const cl = consistencyLayout(state)
      return {
        ok: cs === 'passed' || cs === 'n/a',
        consistency: cs,
        stored,
        missing: cl.missing,
        conflicts: cl.conflicts,
        stage: state.stage,
        verified: overallVerified(state),
        review: path.join(dirAbs, 'consistency.md'),
        next: guidanceFor(state),
      }
    }

    case 'emit_presets': {
      if (!overallVerified(state)) return fail('emit_presets opens only after verify (integrity) passes AND the consistency matrix is complete.', guidanceFor(state).join(' '))
      if (state.gates.interview.status !== 'answered') return fail('Run the interview gate first: gate_ask + gate_answer phase=interview with the roles + delivery confirmed by the user.', 'The interview gate proposes which agent roles the objective needs; it opens once verification + consistency pass.')
      if (state.interview.answerOnly) return fail('Answer-only objective: presets are skipped by design.', 'No execution roles were confirmed — proceed to write_plan.')
      if (!Array.isArray(args.cards) || args.cards.length === 0) return fail('emit_presets requires cards: [{role, why, source_entries, prompt_body, write_scope?}] — one card per confirmed role.')
      const cards = []
      const slugs = new Set()
      for (const raw of args.cards) {
        const role = typeof raw.role === 'string' ? raw.role.trim() : ''
        if (role === '') return fail('Each card needs a non-empty role (as confirmed in the interview).')
        if (typeof raw.why !== 'string' || raw.why.trim() === '') return fail(`Card "${role}": why is required — justify why this role exists.`)
        if (typeof raw.prompt_body !== 'string' || raw.prompt_body.trim() === '') return fail(`Card "${role}": prompt_body is required — the role's operative instructions.`)
        if (!Array.isArray(raw.source_entries) || raw.source_entries.length === 0)
          return fail(`Card "${role}": source_entries is required and non-empty — the existence of a role must be traceable to verified index entries.`)
        for (const sid of raw.source_entries) {
          if (!validId(sid) || !state.entries[sid]) return fail(`Card "${role}": source_entries references unknown entry ${sid}.`)
          if (!state.entries[sid].useful) return fail(`Card "${role}": source_entries must cite USEFUL index entries — ${sid} was filtered as not useful.`)
        }
        let slug = roleSlug(role)
        if (slugs.has(slug)) {
          let k = 2
          while (slugs.has(`${slug}-${k}`)) k++
          slug = `${slug}-${k}`
        }
        slugs.add(slug)
        const writeScope = Array.isArray(raw.write_scope) ? raw.write_scope.filter((s) => typeof s === 'string' && s.trim() !== '') : []
        cards.push({
          role,
          why: raw.why.trim(),
          source_entries: [...new Set(raw.source_entries)],
          prompt_body: raw.prompt_body,
          ...(writeScope.length ? { write_scope: writeScope } : {}),
          file: `agents/${slug}.md`,
        })
      }
      const agentsDir = path.join(dirAbs, 'agents')
      await fs.rm(agentsDir, { recursive: true, force: true })
      await fs.mkdir(agentsDir, { recursive: true })
      const files = []
      for (const c of cards) {
        let md = '---\n'
        md += `role: ${c.role}\n`
        md += `delivery: ${(state.interview.delivery || []).join(', ')}\n`
        md += 'source_entries:\n'
        for (const sid of c.source_entries) md += `  - ${sid}\n`
        if (c.write_scope) {
          md += 'write_scope:\n'
          for (const s of c.write_scope) md += `  - ${s}\n`
        }
        md += `---\n\n${c.prompt_body.trim()}\n`
        const abs = path.join(dirAbs, c.file)
        await fs.writeFile(abs, md, 'utf8')
        files.push(abs)
      }
      const cell = (v) => {
        const s = Array.isArray(v) ? v.join(', ') : v === null || v === undefined ? '' : String(v)
        const t = s.replace(/\|/g, '/').replace(/\n/g, ' ').trim()
        return t === '' ? '—' : t
      }
      let idxDoc = `# Agent role presets — ${now()}\n\n`
      idxDoc += 'Role cards generated from the confirmed interview, each justified by cited verified index entries.\n\n'
      idxDoc += '| role | why | source entries | delivery | write scope | file |\n| --- | --- | --- | --- | --- | --- |\n'
      for (const c of cards) idxDoc += `| ${cell(c.role)} | ${cell(c.why)} | ${cell(c.source_entries)} | ${cell(state.interview.delivery || [])} | ${cell(c.write_scope || [])} | ${cell(c.file)} |\n`
      await fs.writeFile(path.join(dirAbs, 'PRESETS.md'), idxDoc, 'utf8')
      const warnings = []
      const flagged = new Set()
      for (let i = 0; i < cards.length; i++) {
        for (let j = i + 1; j < cards.length; j++) {
          const a = cards[i].write_scope || []
          const b = cards[j].write_scope || []
          if (!a.length || !b.length) continue
          if (!a.some((sa) => b.some((sb) => scopeOverlap(sa, sb)))) continue
          const key = `${cards[i].role}|${cards[j].role}`
          if (flagged.has(key)) continue
          flagged.add(key)
          warnings.push(`write_scope overlap: ${cards[i].role} ↔ ${cards[j].role}`)
        }
      }
      state.presets = { status: 'emitted', emittedAt: now(), cards }
      state.stage = 'plan'
      await writeJson(path.join(dirAbs, 'state.json'), state)
      await renderIndex(dirAbs, state)
      return {
        ok: true,
        stage: 'plan',
        emitted: cards.length,
        files,
        presets_index: path.join(dirAbs, 'PRESETS.md'),
        ...(warnings.length ? { warnings } : {}),
        next: guidanceFor(state),
      }
    }

    case 'emit_tasks': {
      if (state.stage !== 'tasks') return fail(`emit_tasks is only allowed at stage "tasks" (current: ${state.stage}).`, guidanceFor(state).join(' '))
      const skipReason = typeof args.skip_reason === 'string' ? args.skip_reason.trim() : ''
      const rawTasks = Array.isArray(args.tasks) ? args.tasks : []
      if (rawTasks.length === 0 && !skipReason)
        return fail('emit_tasks requires a non-empty tasks array — an empty batch is admissible only with skip_reason.', 'Draft one task per unit of work (subject, description, role, plan_phase), or call emit_tasks with tasks=[] and skip_reason when no drafts make sense.')
      if (rawTasks.length > 0 && state.presets.status !== 'emitted')
        return fail(`emit_tasks needs emitted presets: task roles come from the emitted cards (current presets status: ${state.presets.status}).`, 'Re-emit the role cards and re-run write_plan first — or call emit_tasks with tasks=[] and skip_reason: a skipped-presets flow must skip the task drafts too.')
      if (rawTasks.length === 0) {
        // explicit skip (DESIGN §5): mirrors the presets skip semantics
        state.tasks = { status: 'skipped', skippedAt: now(), skipReason }
        state.stage = 'done'
        const skipFile = path.join(dirAbs, 'TASKS.md')
        await fs.writeFile(skipFile, tasksDoc(state), 'utf8')
        await writeJson(path.join(dirAbs, 'state.json'), state)
        await renderIndex(dirAbs, state)
        return { ok: true, stage: 'done', skipped: true, tasks_file: skipFile, next: guidanceFor(state) }
      }
      const cards = state.presets.cards || []
      const cardByRole = new Map(cards.map((c) => [c.role, c]))
      const drafts = []
      const usedIds = new Set()
      for (const raw of rawTasks) {
        const subject = typeof raw.subject === 'string' ? raw.subject.trim() : ''
        if (subject === '') return fail('Each task needs a non-empty subject.')
        const description = typeof raw.description === 'string' ? raw.description.trim() : ''
        if (description === '') return fail(`Task "${subject}": description is required — it maps 1:1 to the team_task body.`)
        const planPhase = typeof raw.plan_phase === 'string' ? raw.plan_phase.trim() : ''
        if (planPhase === '') return fail(`Task "${subject}": plan_phase is required — tag the task with a PLAN.md phase.`)
        const role = typeof raw.role === 'string' ? raw.role.trim() : ''
        if (!cardByRole.has(role))
          return fail(`Task "${subject}": unknown role "${role}". Valid roles from the emitted cards: ${cards.map((c) => c.role).join(', ')}.`)
        const id = uniqueSlug(taskSlug(subject), usedIds)
        let writeScopes
        if (Array.isArray(raw.write_scopes)) {
          writeScopes = raw.write_scopes.map((s) => String(s).trim())
          if (writeScopes.some((s) => s === '')) return fail(`Task "${subject}": write_scopes entries must be non-empty strings.`)
        } else {
          // absent -> inherit the card's write_scope verbatim (may be [])
          writeScopes = (cardByRole.get(role).write_scope || []).slice()
        }
        const blockedBy = Array.isArray(raw.blocked_by) ? [...new Set(raw.blocked_by.map((b) => String(b).trim()))] : []
        drafts.push({ id, subject, description, role, plan_phase: planPhase, write_scopes: writeScopes, blocked_by: blockedBy })
      }
      const ids = new Set(drafts.map((d) => d.id))
      for (const d of drafts) {
        for (const b of d.blocked_by) {
          if (!ids.has(b))
            return fail(`Task "${d.subject}": blocked_by references "${b}", which is not an id in this batch. Valid ids: ${[...ids].join(', ')}.`)
        }
      }
      const cycle = findBlockedCycle(new Map(drafts.map((d) => [d.id, d.blocked_by])))
      if (cycle)
        return fail(`blocked_by cycle: ${cycle.join(' → ')} — references must stay acyclic (self-references included).`, 'Reorder the drafts: blocked_by may only point at other tasks in this batch without closing a loop.')
      // soft coverage warnings (DESIGN §4.7): never blocking
      const warnings = []
      let markers = []
      try {
        markers = planPhaseMarkers(await fs.readFile(path.join(dirAbs, 'PLAN.md'), 'utf8'))
      } catch {}
      if (markers.length === 0) {
        warnings.push('coverage: PLAN.md phase markers not found')
      } else {
        const norm = (s) => normSpace(s).toLowerCase()
        const referenced = new Set(drafts.map((d) => norm(d.plan_phase)))
        for (const m of markers) if (!referenced.has(norm(m))) warnings.push(`coverage: plan phase "${m}" has no task`)
      }
      state.tasks = { status: 'emitted', emittedAt: now(), items: drafts, warnings }
      state.stage = 'done'
      const tasksFile = path.join(dirAbs, 'TASKS.md')
      await fs.writeFile(tasksFile, tasksDoc(state), 'utf8')
      await writeJson(path.join(dirAbs, 'state.json'), state)
      await renderIndex(dirAbs, state)
      return {
        ok: true,
        stage: 'done',
        emitted: drafts.length,
        tasks_file: tasksFile,
        ...(warnings.length ? { warnings } : {}),
        next: guidanceFor(state),
      }
    }

    case 'reflow': {
      // v1.3.1 (§1–§2): re-run a step at or upstream of the current stage, invalidating
      // downstream artifacts. Never touched: objective, doc_roots, createdAt, entries,
      // gate history files — invalidation is expressed only through the staleness machinery.
      if (typeof args.to_stage !== 'string' || REFLOW_ORDER.indexOf(args.to_stage) === -1)
        return fail(`reflow requires to_stage: one of ${REFLOW_ORDER.join(', ')}.`, 'reflow re-runs the named step — the current stage or an earlier one.')
      if (args.paths !== undefined && args.to_stage !== 'reading')
        return fail('reflow paths are only accepted with to_stage=reading — the selective re-read scope exists only for the reading step.', 'Drop paths, or reflow to_stage=reading with paths=[the files to re-read].')
      const target = REFLOW_ORDER.indexOf(args.to_stage)
      const pos = stagePos(state.stage)
      if (target > pos)
        return fail(
          `Cannot reflow to "${args.to_stage}" from stage "${state.stage}" — reflow never jumps forward. Legal targets from "${state.stage}": ${REFLOW_ORDER.slice(0, pos + 1).join(', ')}.`,
          'Pick the current or an earlier step; advancing stays gated by the normal rules.',
        )
      const presetsWas = state.presets?.status
      const tasksWasStale = !!state.tasks?.stale
      const kept = ['objective + doc_roots', 'entries (all preserved — invalidation of derived state happens through the existing staleness machinery, never silently)', 'gate history files (questions-*.md)']
      const invalidated = []
      const staleChain = () => {
        if (presetsWas === 'emitted' && state.presets?.status === 'stale') invalidated.push('emitted role cards marked stale (re-emit or re-confirm needed)')
        if (!tasksWasStale && state.tasks?.stale) invalidated.push('task drafts marked stale (re-emit after upstream re-run)')
      }
      switch (args.to_stage) {
        case 'reading': {
          state.stage = 'reading'
          kept.push('verification, consistency, presets, plan and tasks all kept — a re-read alone invalidates nothing; entry edits then trigger the normal staleness machinery')
          // v1.3.3 (issue #12): optional user-picked scope — re-read only these files;
          // everything else keeps its verification state untouched.
          if (Array.isArray(args.paths) && args.paths.length) {
            const picked = []
            const missing = []
            for (const p of args.paths) {
              if (typeof p !== 'string' || !p.trim()) return fail('reflow paths must be non-empty file paths.', 'Pass workspace-relative paths of existing files (the panel checklist offers exactly those), or omit paths for a full re-read.')
              try {
                const fst = await fs.stat(path.resolve(cwd, p))
                if (!fst.isFile()) missing.push(p)
                else picked.push(String(p).split(path.sep).join('/'))
              } catch { missing.push(p) }
            }
            if (missing.length) return fail(`reflow paths: not readable files: ${missing.join(', ')}.`)
            state.readingScope = { paths: [...new Set(picked)].sort(), setAt: now() }
            kept.push(`selective re-read scope set: ${state.readingScope.paths.length} file(s) — files outside the list keep their verification state`)
          } else {
            if (state.readingScope) invalidated.push('previous selective re-read scope cleared — reading is full again')
            delete state.readingScope
          }
          break
        }
        case 'indexing':
          state.verification = { status: 'unverified', lastRun: undefined, failed: [], unanchored: [], unattested: [], suspect: [], externals: [] }
          state.consistency.verdicts = {}
          recomputeConsistency(state)
          presetsStale(state)
          state.stage = 'indexing' // held even when recompute yields passed/n/a: the user is re-running extraction, no automatic advance
          invalidated.push('integrity verification reset to unverified (re-score and re-verify after re-extraction)', 'consistency verdicts cleared (every pair must be re-reviewed after verify)')
          staleChain()
          break
        case 'consistency': {
          state.consistency.verdicts = {}
          const cs = recomputeConsistency(state)
          presetsStale(state)
          kept.push(`verification kept as-is (status: ${state.verification.status})`)
          invalidated.push('consistency verdicts cleared (missing pairs -> pending; re-run crosscheck)')
          if (cs === 'passed' || cs === 'n/a') {
            // zero-verdict pass (0-1 useful entries): replicate the verify-pass routing, do not park on consistency
            if (state.gates.gaps?.status === 'answered') afterGapsAnswered(state)
            else {
              state.stage = 'gaps'
              state.gates.gaps.status = 'open'
            }
            invalidated.push(`consistency recompute = ${cs}: routed past consistency by the verify-pass rules`)
          } else {
            state.stage = 'consistency'
          }
          staleChain()
          break
        }
        case 'gaps':
          state.gates.gaps = { ...state.gates.gaps, status: 'open', reconfirm: true }
          state.gates.interview.status = 'open'
          state.gates.interview.reconfirm = true
          presetsStale(state)
          state.stage = 'gaps'
          invalidated.push('gaps gate reopened for re-confirmation (past answers kept as history)', 'interview gate reopened for re-confirmation', 'the confirmed role set is re-required (re-answering the interview overwrites presets/tasks)')
          staleChain()
          break
        case 'interview':
          state.gates.interview.status = 'open'
          state.gates.interview.reconfirm = true
          presetsStale(state)
          state.stage = 'interview'
          kept.push('interview record kept — re-answering overwrites it and triggers the normal presetsStale inside gate_answer')
          invalidated.push('interview gate reopened for re-confirmation')
          staleChain()
          break
        case 'presets':
          state.presets = { status: 'pending' } // full reset — deliberately different from presetsStale (see §2 note)
          if (state.tasks?.status === 'emitted') state.tasks.stale = true
          state.stage = 'presets'
          kept.push('interview record + gate answers', 'agents/ + PRESETS.md files stay on disk as reference')
          invalidated.push('role cards reset to pending: write_plan is blocked until presets are re-emitted')
          if (!tasksWasStale && state.tasks?.stale) invalidated.push('task drafts marked stale (re-emit after the cards)')
          break
        case 'plan':
          state.plan = {}
          if (state.tasks?.status === 'emitted') state.tasks.stale = true
          state.stage = 'plan'
          kept.push('presets untouched')
          invalidated.push('plan block cleared (write_plan re-stamps NOTES.md/PLAN.md; files stay as reference)')
          if (!tasksWasStale && state.tasks?.stale) invalidated.push('task drafts marked stale (re-emit after the plan)')
          break
        case 'tasks':
          delete state.tasks // status then synthesizes {status:'pending'} (v3.1 §1); the TASKS.md file stays as reference
          state.stage = 'tasks'
          kept.push('presets + plan untouched', 'TASKS.md file stays on disk as reference')
          invalidated.push('task drafts block removed — re-run emit_tasks to regenerate TASKS.md')
          break
      }
      if (args.to_stage !== 'reading' && state.readingScope) {
        delete state.readingScope
        invalidated.push('selective re-read scope cleared (the scope only exists for the reading step)')
      }
      state.updatedAt = now()
      await writeJson(path.join(dirAbs, 'state.json'), state)
      await renderIndex(dirAbs, state)
      return { ok: true, reflowed_to: args.to_stage, stage: state.stage, kept, invalidated, next: guidanceFor(state) }
    }
    case 'ingest': {
      if (!Array.isArray(args.paths) || args.paths.length === 0) return fail('ingest requires paths: new or changed documents.')
      state.pendingDocs = [...new Set([...(state.pendingDocs || []), ...args.paths])]
      // v1.3.2 (issue #11): the ingest acknowledges the listed files — they become part of
      // the snapshot and leave the discovered list; other discoveries keep notifying.
      if (state.docSnapshot) {
        const norm = (p) => String(p).split(path.sep).join('/')
        const ingested = args.paths.map(norm)
        const under = (p) => ingested.some((ip) => p === ip || p.startsWith(ip + '/'))
        const scan = await snapshotDocRoots(cwd, state.doc_roots)
        for (const [p, v] of Object.entries(scan.files)) if (under(p)) state.docSnapshot.files[p] = v
        for (const p of ingested) {
          const abs = path.resolve(cwd, p)
          try {
            const fst = await fs.stat(abs)
            if (fst.isFile()) state.docSnapshot.files[norm(p)] = { m: Math.floor(fst.mtimeMs), s: fst.size }
          } catch {}
        }
        state.docSnapshot.takenAt = now()
        state.discoveredDocs = (state.discoveredDocs || []).filter((d) => !under(d.path))
      }
      state.stage = 'reading'
      if (state.readingScope) delete state.readingScope // v1.3.3: new documents widen the reading — a stale pick must not suppress them
      state.verification.status = 'unverified'
      state.gates.understanding.reconfirm = state.gates.understanding.status === 'answered'
      state.gates.interview.reconfirm = state.gates.interview.status === 'answered'
      presetsStale(state)
      await writeJson(path.join(dirAbs, 'state.json'), state)
      await renderIndex(dirAbs, state)
      return { ok: true, pending: state.pendingDocs, stage: state.stage, next: guidanceFor(state) }
    }

    case 'write_plan': {
      if (state.stage !== 'plan') return fail(`write_plan is only allowed at stage "plan" (current: ${state.stage}).`, guidanceFor(state).join(' '))
      if (typeof args.notes_md !== 'string' || typeof args.plan_md !== 'string') return fail('write_plan requires notes_md and plan_md (markdown strings).')
      await fs.writeFile(path.join(dirAbs, 'NOTES.md'), `# Notes\n\n${args.notes_md}\n`, 'utf8')
      let planDoc = `# Plan to reach the objective\n\nObjective: ${state.objective}\n\n${args.plan_md}\n`
      if (state.presets.status === 'emitted') {
        planDoc += `\n## Delivery & team (generated)\n\nDelivery: ${(state.interview.delivery || []).join(', ') || 'answer-only'}\n\n`
        for (const c of state.presets.cards) planDoc += `- **${c.role}** — role card: ${c.file}\n`
        planDoc += `- Task drafts: TASKS.md (${tasksPointer(state)})\n`
      }
      await fs.writeFile(path.join(dirAbs, 'PLAN.md'), planDoc, 'utf8')
      state.plan = { writtenAt: now(), notes: 'NOTES.md', plan: 'PLAN.md' }
      state.stage = state.presets.status === 'emitted' ? 'tasks' : 'done'
      await writeJson(path.join(dirAbs, 'state.json'), state)
      await renderIndex(dirAbs, state)
      return { ok: true, stage: state.stage, notes: path.join(dirAbs, 'NOTES.md'), plan: path.join(dirAbs, 'PLAN.md'), next: guidanceFor(state) }
    }

    case 'note': {
      // v1.4.0 (issue #17): typed review notes — add/list/address/restore/supersede
      const sub = typeof args.note_action === 'string' ? args.note_action : 'add'
      if (sub === 'list')
        return { ok: true, notes: state.notes || [], supersedions: state.supersedions || [], consistency: state.consistency.status, stage: state.stage, next: guidanceFor(state) }
      const res = noteMutate(state, sub, { note: args.note, id: args.id, supersede: args.supersede })
      if (!res.ok) return fail(res.error, guidanceFor(state).join(' '))
      const { touchesMatrix, ...payload } = res
      const extra = await persistNoteMutation(dirAbs, state, res)
      return { ok: true, ...payload, ...extra, next: guidanceFor(state) }
    }

    default:
      return fail(`Unknown action ${action}.`, 'Actions: status, start, gate_ask, gate_answer, add_entries, update_entry, remove_entry, attest, verify, crosscheck, emit_presets, emit_tasks, reflow, ingest, write_plan, note, supersede, reset.')
  }
}

// ---------------------------------------------------------------------------
// tool definition
// ---------------------------------------------------------------------------

function makeTool(ctx) {
  return {
    name: 'docflow',
  description:
    'Document-driven workflow engine for project work: turn project documents into a source-verified index and a plan. ' +
    'Stage machine: start(objective, doc_roots) -> read docs -> understanding gate (ask the user via ask_user_question, then gate_ask/gate_answer phase=understanding) -> add_entries (useful/not-useful filtered info; every entry MUST carry a verbatim source_quote plus source_kind "doc" (project source_file) or "external" (source_ref URL/path) — assumed content is rejected) -> attest(ok|suspect; trusted for external sources after human review) trustworthiness -> verify = INTEGRITY check (source readable + quote found verbatim; unvouched external sources keep it from passing; failures send you back to re-read and fix) -> CONSISTENCY phase: crosscheck records one verdict per pair of useful entries (consistent|conflict); conflicts block the workflow until the entries are corrected and re-reviewed -> gaps gate (ask the user what information is missing to reach the objective, phase=gaps) -> interview gate (phase=interview: propose the agent roles + delivery type code/docs/answer-only, the user confirms via gate_answer with the interview payload) -> emit_presets writes source-backed agent role cards under agents/ + PRESETS.md (answer-only skips presets explicitly) -> write_plan(notes_md, plan_md) -> emit_tasks (TEAM BRIDGE, only when presets were emitted): team task drafts rendered to TASKS.md, each 1:1 mappable to team_task_create (subject/description/role/plan_phase/write_scopes/blocked_by), or an explicit skip via tasks=[] + skip_reason -> reflow(to_stage, paths?): re-run any step at or upstream of the current stage, invalidating downstream artifacts (entries and gates history are never silently dropped); with to_stage=reading an optional paths list narrows the re-read to the user-picked files (selective re-read scope, reported as reading_scope in status). ' +
    'New documents arrive via ingest and re-enter the loop. status auto-discovers files under doc_roots that are new or changed since the last ingest (diffs an mtime/size manifest, on demand — no background polling) and keeps surfacing them in "discovered" + next guidance until you acknowledge with ingest; pre-ingest discovery never enters the flow by itself. status returns the current stage, gate/verification/consistency state and the exact next steps — follow its "next" guidance. ' +
    'REVIEW NOTES (v1.4.0): action=note records the user\'s typed notes on the workflow — note_action add with note {target, type: FACT|SUGGESTION|GUIDANCE|CONSTRAINT, body} (target = entry id U…/N…, emitted role name, or plan/notes/objective), list, address (id), restore (SUP… id), supersede (supersede {fact, entry, winner}). FACT notes are human-sourced: they need no quote, they join the consistency matrix as pairs against every useful entry, and a conflict with an entry is resolved by asking the user then recording the answer with supersede (winner fact|entry); restore inverts a supersession and withdraws the winning fact. The right-sidebar panel posts the same operations to POST /api/docflow/notes. ' +
    'The workflow state lives in a .doc-workflow/ folder in the session workspace (objective.md, index.md, questions-*.md, verification.md, consistency.md, agents/<role>.md, PRESETS.md, NOTES.md, PLAN.md, TASKS.md). Use this tool whenever asked to analyze project documents toward an objective, build/update index.md, verify source reliability or logical coherence, or write notes/plan from documentation.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'start', 'gate_ask', 'gate_answer', 'add_entries', 'update_entry', 'remove_entry', 'attest', 'verify', 'crosscheck', 'emit_presets', 'emit_tasks', 'reflow', 'ingest', 'write_plan', 'note', 'reset'],
      },
      objective: { type: 'string', description: 'start: the work objective as defined by the user.' },
      doc_roots: { type: 'array', items: { type: 'string' }, description: 'start: documents/directories to read.' },
      dir: { type: 'string', description: 'start: optional state folder name (default ".doc-workflow").' },
      phase: { type: 'string', enum: ['understanding', 'gaps', 'interview'], description: 'gate_ask/gate_answer.' },
      questions: { type: 'array', items: { type: 'object', properties: { question: { type: 'string' }, why: { type: 'string' } }, required: ['question'] } },
      answers: { type: 'array', items: { type: 'object', properties: { question: { type: 'string' }, answer: { type: 'string' } }, required: ['question', 'answer'] } },
      interview: {
        type: 'object',
        properties: {
          answer_only: { type: 'boolean', description: 'true when the objective is analysis only: no execution roles, presets skipped by design.' },
          delivery: { type: 'array', items: { type: 'string', enum: ['code', 'docs'] }, description: 'what the team will deliver: "code", "docs", or both.' },
          roles: { type: 'array', items: { type: 'string' }, description: 'agent role names confirmed by the user (one card each in emit_presets).' },
        },
        description: 'gate_answer phase=interview: the confirmed interview result — either answer_only: true, or a non-empty delivery array plus a non-empty roles array.',
      },
      cards: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            role: { type: 'string', description: 'role name as confirmed in the interview.' },
            why: { type: 'string', description: 'why this role exists for the objective — justification, not flavor text.' },
            source_entries: { type: 'array', items: { type: 'string' }, description: 'index entry ids (U…) that make the role necessary; must be useful, verified entries.' },
            prompt_body: { type: 'string', description: 'the operative instructions put in the role card (markdown).' },
            write_scope: { type: 'array', items: { type: 'string' }, description: 'optional paths this role expects to modify; overlaps are reported as warnings.' },
          },
          required: ['role', 'why', 'source_entries', 'prompt_body'],
        },
        description: 'emit_presets: one source-backed agent role card per confirmed role.',
      },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            subject: { type: 'string', description: 'task title; the id is slug(subject) with -2/-3 collision suffixes.' },
            description: { type: 'string', description: 'the team_task body — kept verbatim in TASKS.md and in the state items.' },
            role: { type: 'string', description: 'exact role name from the emitted presets cards.' },
            plan_phase: { type: 'string', description: 'the PLAN.md phase this task belongs to (bold **…** phase or ### heading).' },
            write_scopes: { type: 'array', items: { type: 'string' }, description: 'optional; when absent the role card write_scope is inherited verbatim.' },
            blocked_by: { type: 'array', items: { type: 'string' }, description: 'ids of other tasks in this batch; self-references and cycles are rejected.' },
          },
          required: ['subject', 'description', 'role', 'plan_phase'],
        },
        description: 'emit_tasks: one draft per unit of work; the array may be empty only together with skip_reason.',
      },
      skip_reason: { type: 'string', description: 'emit_tasks: explicit skip when no task drafts make sense (mirrors the presets skip semantics).' },
      to_stage: { type: 'string', enum: [...REFLOW_ORDER], description: 'reflow: the step to re-run from; must be the current or an earlier step' },
      entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            useful: { type: 'boolean' },
            title: { type: 'string' },
            content: { type: 'string', description: 'the filtered information, stated compactly.' },
            source_kind: { type: 'string', enum: ['doc', 'external'], description: 'doc = project file (source_file); external = written source outside the docs (source_ref: URL or absolute path).' },
            source_file: { type: 'string', description: 'internal source: project file path (path[:line]).' },
            source_line: { type: 'number' },
            source_ref: { type: 'string', description: 'external source: URL or absolute path where the quote was taken from.' },
            source_quote: { type: 'string', description: 'MANDATORY verbatim quote from the written source — content without a source is rejected.' },
            relevance: { type: 'string', description: 'why it matters for the objective.' },
          },
          required: ['useful', 'title', 'content', 'source_kind', 'source_quote'],
        },
        description: 'add_entries: batch of filtered findings (keep batching; 1 call per reading session).',
      },
      id: { type: 'string', description: 'update_entry/remove_entry: entry id like U3 or N1. note address/restore: NOTE…/SUP… id.' },
      note_action: { type: 'string', enum: ['add', 'list', 'address', 'restore', 'supersede'], description: 'note: sub-action (default add).' },
      note: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'note add: target — an index entry id (U…/N…), an emitted preset role name, or an artifact: plan | notes | objective.' },
          type: { type: 'string', enum: [...NOTE_TYPES], description: 'note add: FACT (a human-sourced statement, joins the consistency matrix against every useful entry) | SUGGESTION | GUIDANCE | CONSTRAINT.' },
          body: { type: 'string', description: `note add: the statement itself (max ${NOTE_BODY_MAX} characters).` },
        },
        description: 'note add: the note to record {target, type, body}.',
      },
      supersede: {
        type: 'object',
        properties: {
          fact: { type: 'string', description: 'FACT note id (NOTE…).' },
          entry: { type: 'string', description: 'entry id (U…/N…) the fact conflicts with.' },
          winner: { type: 'string', enum: ['fact', 'entry'], description: '"fact" = the fact replaces the entry; "entry" = the fact is dropped.' },
        },
        required: ['fact', 'entry', 'winner'],
        description: 'note supersede: records the user answer to a FACT-vs-entry conflict (requires the conflict verdict from crosscheck).',
      },
      fields: { type: 'object', description: 'update_entry: fields to replace (title, content, useful, source_kind, source_file, source_line, source_ref, source_quote, relevance).' },
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            a: { type: 'string', description: 'first entry id (e.g. U2).' },
            b: { type: 'string', description: 'second entry id.' },
            verdict: { type: 'string', enum: ['consistent', 'conflict'] },
            note: { type: 'string', description: 'why (mandatory in practice for conflicts: what contradicts and how it was resolved).' },
          },
          required: ['a', 'b', 'verdict'],
        },
        description: 'crosscheck: logical-consistency verdict per pair of useful entries; full coverage is required.',
      },
      paths: { type: 'array', items: { type: 'string' }, description: 'ingest: new/changed documents. reflow (only with to_stage=reading): the files the user picked to re-read — the others keep their verification state; omit or empty restores the full reading.' },
      verdict: { type: 'string', enum: ['ok', 'suspect', 'trusted'], description: 'attest: your trustworthiness judgment. trusted = explicit human vouch required to clear an external (URL/path) source.' },
      ids: { type: 'array', items: { type: 'string' }, description: 'attest: entry ids or ["ALL"].' },
      attest_note: { type: 'string', description: 'attest: why this verdict (plain string; v1.4.0 renamed from note — `note` is now the review-note object).' },
      notes_md: { type: 'string', description: 'write_plan: notes content (markdown).' },
      plan_md: { type: 'string', description: 'write_plan: step-by-step plan to reach the objective (markdown).' },
      confirm: { type: 'string', description: 'reset only: "delete".' },
    },
    required: ['action'],
  },
  output: {
    schema: { type: 'object' },
    render(args, value) {
      return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    },
  },
  isConcurrencySafe() {
    return false
  },
  presentCall(args) {
    return { card: 'generic', kind: 'other', title: `docflow · ${args && args.action ? args.action : ''}` }
  },
  async execute(args, exec) {
    const out = await runDocflow(ctx, exec, args || {})
    // the harness rejects results that are not lossless JSON; round-trip drops
    // any undefined-valued keys left by partial payloads
    return JSON.parse(JSON.stringify(out))
  },
  }
}

const PROMPT_SECTION = {
  name: 'doc-workflow',
  order: 600,
  text:
    '## Document workflow (docflow)\n' +
    'When a task means understanding or planning work from local project documents (analyze docs toward an objective, build index.md, verify information trustworthiness, write notes/plan), drive the flow with the `docflow` tool instead of ad-hoc notes. ' +
    'It enforces the loop: objective -> read -> ask the user the understanding questions (ask_user_question) -> filter info into useful/not-useful entries, each source-backed with a verbatim quote (internal doc file or declared external source — never assumed) -> attest + verify INTEGRITY (re-read failures) -> CONSISTENCY: cross-check every pair of useful entries with crosscheck verdicts and resolve conflicts -> ask the user about missing information -> interview gate: propose the agent roles + delivery type (code/docs/answer-only), the user confirms, then emit_presets writes the source-backed role cards (agents/*.md + PRESETS.md) -> notes + plan -> when presets were emitted, emit_tasks drafts the team tasks from the plan (TASKS.md, 1:1 mappable to team_task_create) or records an explicit skip. ' +
    'Whenever docflow returns "next" guidance, follow it literally.',
}

// ---------------------------------------------------------------------------
// v1.3.4 (issue #14): panel-lifetime watcher
// ---------------------------------------------------------------------------
// While a Docflow panel is mounted it renews a lease on its state file about
// every 7 s (the panel's existing poll tick). The first heartbeat of a lease
// runs ONE reconcile diff through discoverDocs — the same diff `status` runs,
// so changes that landed while the panel was closed surface at once — then
// fs.watch on each doc_root debounces 500 ms onto that same diff whenever a
// write lands. No checksums: events only replace "ask for status" as the
// trigger; the mtime+size manifest stays the source of truth. A lease whose
// last heartbeat is older than ~20 s (panel closed, navigated away, host dead)
// releases its watchers, so nothing polls when nobody is looking. `status`
// keeps reconciling exactly as before — the headless path is unchanged.
// ---------------------------------------------------------------------------

const LEASE_TTL_MS = 20_000
const LEASE_SWEEP_MS = 5_000
const LEASE_DEBOUNCE_MS = 500

/** @type {Map<string, {watchers: any[], lastBeat: number, deb: any, sweep: any, busy: boolean, pending: boolean}>} */
const leases = new Map()

/** v1.4.0 (issue #17): per-state-file async mutex. The lease reconcile and the
 *  notes route both do read-modify-write on state.json; serializing them per
 *  path guarantees a note-add and a concurrent reconcile never lose a write. */
const stateLocks = new Map()

function withStateLock(statePath, fn) {
  const prev = stateLocks.get(statePath) || Promise.resolve()
  const run = prev.then(() => fn(), () => fn())
  const guarded = run.then(
    () => undefined,
    () => undefined,
  )
  stateLocks.set(statePath, guarded)
  guarded.then(() => {
    if (stateLocks.get(statePath) === guarded) stateLocks.delete(statePath)
  })
  return run
}

function isDocflowState(state) {
  return !!state && state.kind === 'docflow' && Array.isArray(state.doc_roots)
}

/** Fresh read of state, one discovery diff, persist + re-render only if it changed. */
async function leaseReconcile(statePath) {
  return withStateLock(statePath, async () => {
    const state = await readJson(statePath)
    if (!isDocflowState(state)) return false
    const cwd = path.dirname(path.dirname(statePath))
    if (!(await discoverDocs(cwd, state))) return false
    state.updatedAt = now()
    await writeJson(statePath, state)
    await renderIndex(path.dirname(statePath), state)
    return true
  })
}

function leaseNote(statePath) {
  const lease = leases.get(statePath)
  if (!lease) return
  if (lease.deb) clearTimeout(lease.deb)
  lease.deb = setTimeout(() => {
    lease.deb = null
    if (lease.busy) {
      lease.pending = true
      return
    }
    lease.busy = true
    leaseReconcile(statePath)
      .catch(() => {})
      .then(() => {
        lease.busy = false
        if (lease.pending) {
          lease.pending = false
          leaseNote(statePath)
        }
      })
  }, LEASE_DEBOUNCE_MS)
  if (lease.deb.unref) lease.deb.unref()
}

async function leaseArm(statePath, lease) {
  const state = await readJson(statePath)
  if (!isDocflowState(state)) return false
  const cwd = path.dirname(path.dirname(statePath))
  for (const rootRel of state.doc_roots) {
    const abs = path.resolve(cwd, rootRel)
    let st = null
    try {
      st = await fs.stat(abs)
    } catch {}
    if (!st || !st.isDirectory()) continue // file roots and missing roots: status still reconciles them on demand
    try {
      const w = fsWatch(abs, { recursive: true }, () => leaseNote(statePath))
      w.on('error', () => {})
      lease.watchers.push(w)
    } catch {}
  }
  if (lease.watchers.length === 0) {
    // No watchable dir root: fall back to watching the workspace root dir so
    // first-time file creation inside a not-yet-created doc dir still wakes up.
    try {
      const w = fsWatch(cwd, { recursive: true }, () => leaseNote(statePath))
      w.on('error', () => {})
      lease.watchers.push(w)
    } catch {}
  }
  return true
}

/** Renew (or take) the lease for one workflow state file. Resolves after the
 *  first-heartbeat reconcile, so callers/tests can await the catch-up diff. */
async function leaseHeartbeat(statePath) {
  let lease = leases.get(statePath)
  let first = false
  if (!lease) {
    lease = { watchers: [], lastBeat: Date.now(), deb: null, sweep: null, busy: false, pending: false }
    leases.set(statePath, lease)
    first = true
    if (!(await leaseArm(statePath, lease))) {
      leaseRelease(statePath)
      return false
    }
  }
  lease.lastBeat = Date.now()
  if (!lease.sweep) {
    lease.sweep = setInterval(() => {
      const l = leases.get(statePath)
      if (l && Date.now() - l.lastBeat > LEASE_TTL_MS) leaseRelease(statePath)
    }, LEASE_SWEEP_MS)
    if (lease.sweep.unref) lease.sweep.unref()
  }
  if (first) await leaseReconcile(statePath).catch(() => {})
  return true
}

function leaseRelease(statePath) {
  const lease = leases.get(statePath)
  if (!lease) return false
  if (lease.sweep) clearInterval(lease.sweep)
  if (lease.deb) clearTimeout(lease.deb)
  for (const w of lease.watchers) {
    try {
      w.close()
    } catch {}
  }
  lease.watchers.length = 0
  leases.delete(statePath)
  return true
}

function leaseCount() {
  return leases.size
}

function leaseReleaseAll() {
  for (const p of [...leases.keys()]) leaseRelease(p)
}

/** Test/exported surface — e2e drives the lease machinery headlessly (no HTTP). */
export const leaseApi = { heartbeat: leaseHeartbeat, release: leaseRelease, count: leaseCount, releaseAll: leaseReleaseAll, reconcile: leaseReconcile }

/**
 * v1.4.0 (issue #17): notes mutation for one state file, under the state lock:
 * fresh read, validate, mutate, persist (state.json + index.md + consistency.md).
 * Returns {status, body} — the route shape; exported as notesApi for headless tests.
 */
async function notesHandle(statePath, body) {
  const action = body && typeof body.action === 'string' ? body.action : 'add'
  if (!['add', 'list', 'address', 'supersede', 'restore'].includes(action))
    return { status: 400, body: { ok: false, error: 'notes action must be add|list|address|supersede|restore.' } }
  return withStateLock(statePath, async () => {
    const state = await readJson(statePath)
    if (!isDocflowState(state)) return { status: 404, body: { ok: false, error: 'not a docflow state file' } }
    if (!Array.isArray(state.notes)) state.notes = []
    if (!Array.isArray(state.supersedions)) state.supersedions = []
    if (action === 'list')
      return {
        status: 200,
        body: { ok: true, notes: state.notes, supersedions: state.supersedions, consistency: state.consistency.status, stage: state.stage, next: guidanceFor(state) },
      }
    const res = noteMutate(state, action, { note: body.note, id: body.id, supersede: body.supersede })
    if (!res.ok) return { status: 400, body: { ok: false, error: res.error } }
    const { touchesMatrix, ...payload } = res
    const extra = await persistNoteMutation(path.dirname(statePath), state, res)
    return { status: 200, body: { ok: true, ...payload, ...extra, next: guidanceFor(state) } }
  })
}

/** Test/exported surface for the notes channel (route-free). */
export const notesApi = { handle: notesHandle }

// --- loopback trust fence (same semantics the workbench plugin uses) --------

function isLoopbackRequest(req) {
  const address = req.socket && req.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = req.headers && req.headers.host
  if (typeof host !== 'string') return false
  let url
  try {
    url = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]') return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === url.host
  } catch {
    return false
  }
}

function leaseRespond(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req, maxBytes = 16 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) return undefined
    chunks.push(chunk)
  }
  if (chunks.length === 0) return undefined
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * POST /api/docflow/lease  body {sessionId, file}
 * `file` is the workspace-relative state path the panel is watching (e.g.
 * '.doc-workflow/state.json'); the session's working directory anchors it, so
 * a caller can never point the watcher at an arbitrary path.
 */
function makeLeaseRoute(ctx) {
  return {
    method: 'POST',
    path: '/api/docflow/lease',
    handler: async (req, res) => {
      try {
        if (!isLoopbackRequest(req)) return leaseRespond(res, 403, { ok: false, error: 'loopback only' })
        const body = await readJsonBody(req)
        if (!body || typeof body.sessionId !== 'string' || typeof body.file !== 'string')
          return leaseRespond(res, 400, { ok: false, error: 'lease requires {sessionId, file}' })
        const session = ctx.sessions.get(body.sessionId)
        const wd = ctx.workingDirectory
        const dir = session ? wd.get(session) : wd.defaultDirectory
        if (!dir) return leaseRespond(res, 404, { ok: false, error: 'unknown session' })
        const rel = path.normalize(body.file)
        if (path.isAbsolute(rel) || rel.startsWith('..') || !rel.endsWith('state.json'))
          return leaseRespond(res, 400, { ok: false, error: 'file must be a workspace-relative <dir>/state.json path' })
        const statePath = path.resolve(dir, rel)
        if (!statePath.startsWith(path.resolve(dir) + path.sep)) return leaseRespond(res, 400, { ok: false, error: 'outside workspace' })
        const ok = await leaseHeartbeat(statePath)
        return leaseRespond(res, ok ? 200 : 404, { ok })
      } catch {
        return leaseRespond(res, 500, { ok: false, error: 'lease failed' })
      }
    },
  }
}

/**
 * POST /api/docflow/notes  body {sessionId, file, action?, note?, id?, supersede?}
 * v1.4.0 (issue #17): panel-native note writes. Same session/file anchoring and
 * loopback fence as the lease route; action add|list|address|supersede|restore.
 */
function makeNotesRoute(ctx) {
  return {
    method: 'POST',
    path: '/api/docflow/notes',
    handler: async (req, res) => {
      try {
        if (!isLoopbackRequest(req)) return leaseRespond(res, 403, { ok: false, error: 'loopback only' })
        const body = await readJsonBody(req)
        if (!body || typeof body.sessionId !== 'string' || typeof body.file !== 'string')
          return leaseRespond(res, 400, { ok: false, error: 'notes requires {sessionId, file, …}' })
        const session = ctx.sessions.get(body.sessionId)
        const wd = ctx.workingDirectory
        const dir = session ? wd.get(session) : wd.defaultDirectory
        if (!dir) return leaseRespond(res, 404, { ok: false, error: 'unknown session' })
        const rel = path.normalize(body.file)
        if (path.isAbsolute(rel) || rel.startsWith('..') || !rel.endsWith('state.json'))
          return leaseRespond(res, 400, { ok: false, error: 'file must be a workspace-relative <dir>/state.json path' })
        const statePath = path.resolve(dir, rel)
        if (!statePath.startsWith(path.resolve(dir) + path.sep)) return leaseRespond(res, 400, { ok: false, error: 'outside workspace' })
        const out = await notesHandle(statePath, body)
        return leaseRespond(res, out.status, out.body)
      } catch {
        return leaseRespond(res, 500, { ok: false, error: 'notes failed' })
      }
    },
  }
}

export function apply(ctx) {
  return ctx.effect(() => {
    const offTool = ctx.tools.register(makeTool(ctx))
    const offPrompt = ctx.systemPrompt.section(PROMPT_SECTION)
    // v1.3.4: the lease route needs webServer, which is an OPTIONAL host
    // service (CLI harnesses may not provide it) — lazy ctx.inject with a
    // callback never fires when the service is absent, exactly like the
    // dsh-plugin hub routes. Do NOT add webServer to the required inject list.
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (host) => {
        host.effect(() => {
          const offRoute = host.webServer.register(makeLeaseRoute(ctx))
          // v1.4.0 (issue #17): panel-native note writes ride the same fence
          const offNotesRoute = host.webServer.register(makeNotesRoute(ctx))
          return () => {
            offNotesRoute()
            offRoute()
            leaseReleaseAll()
          }
        }, 'docflow: panel lease + notes routes')
      })
    }
    return () => {
      offTool()
      offPrompt()
      leaseReleaseAll()
    }
  })
}
