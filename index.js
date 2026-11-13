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

/** all unordered pairs of useful entries — the logical consistency matrix */
function usefulPairs(state) {
  const ids = Object.keys(state.entries).filter((id) => state.entries[id].useful).sort()
  const pairs = []
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairs.push([ids[i], ids[j]])
  return pairs
}

function pairKey(a, b) {
  return [a, b].sort().join('|')
}

/** mechanical value-mismatch hints for a pair (informational aid, not blocking) */
function pairHints(state, a, b) {
  const fa = factValues(`${state.entries[a].content} ${state.entries[a].source_quote || ''}`)
  const fb = factValues(`${state.entries[b].content} ${state.entries[b].source_quote || ''}`)
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

function consistencyLayout(state) {
  const c = state.consistency
  const pairs = usefulPairs(state)
  const missing = pairs.filter(([a, b]) => !c.verdicts[pairKey(a, b)]).map(([a, b]) => pairKey(a, b))
  const conflicts = pairs
    .filter(([a, b]) => c.verdicts[pairKey(a, b)] && c.verdicts[pairKey(a, b)].verdict === 'conflict')
    .map(([a, b]) => ({ pair: pairKey(a, b), note: c.verdicts[pairKey(a, b)].note }))
  return { pairs, missing, conflicts }
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
    const ea = state.entries[a]
    const eb = state.entries[b]
    md += `## ${a} ↔ ${b}\n\n- **${a}** ${ea.title} (${ea.source_kind || 'doc'}): ${ea.content}\n- **${b}** ${eb.title} (${eb.source_kind || 'doc'}): ${eb.content}\n`
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
  if (state.version === STATE_VERSION && state.consistency && state.gates && state.gates.interview && state.interview && state.presets) return false
  let dirty = false
  if (!state.consistency) {
    state.consistency = { status: 'n/a', verdicts: {}, updatedAt: undefined }
    dirty = true
  }
  for (const e of Object.values(state.entries)) {
    if (!e.source_kind) {
      e.source_kind = 'doc'
      dirty = true
    }
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
    consistency: (() => {
      const cl = consistencyLayout(state)
      return { status: state.consistency.status, pairs: cl.pairs.length, missing: cl.missing, conflicts: cl.conflicts }
    })(),
    pending_docs: state.pendingDocs || [],
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
    pendingDocs: [],
    plan: {},
    createdAt: now(),
    updatedAt: now(),
  }
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
        e.attest = { verdict: args.verdict, note: args.note, at: now() }
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
      if (passed) {
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
        next: guidanceFor(state),
      }
    }

    case 'crosscheck': {
      if (state.verification.status !== 'passed') return fail('The consistency matrix opens only after verify (integrity) passes.', guidanceFor(state).join(' '))
      if (!Array.isArray(args.verdicts) || args.verdicts.length === 0) return fail('crosscheck requires verdicts: [{a, b, verdict: consistent|conflict, note?}].')
      const validPairs = new Set(usefulPairs(state).map(([a, b]) => pairKey(a, b)))
      const stored = []
      for (const v of args.verdicts) {
        if (!validId(v.a) || !validId(v.b) || !state.entries[v.a] || !state.entries[v.b]) return fail(`crosscheck verdict references unknown entry: ${v.a} / ${v.b}.`)
        if (!state.entries[v.a].useful || !state.entries[v.b].useful) return fail('Only useful entries take part in the consistency matrix.')
        if (v.verdict !== 'consistent' && v.verdict !== 'conflict') return fail('Each verdict must be "consistent" or "conflict".')
        const k = pairKey(v.a, v.b)
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

    case 'ingest': {
      if (!Array.isArray(args.paths) || args.paths.length === 0) return fail('ingest requires paths: new or changed documents.')
      state.pendingDocs = [...new Set([...(state.pendingDocs || []), ...args.paths])]
      state.stage = 'reading'
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

    default:
      return fail(`Unknown action ${action}.`, 'Actions: status, start, gate_ask, gate_answer, add_entries, update_entry, remove_entry, attest, verify, crosscheck, emit_presets, emit_tasks, ingest, write_plan, reset.')
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
    'Stage machine: start(objective, doc_roots) -> read docs -> understanding gate (ask the user via ask_user_question, then gate_ask/gate_answer phase=understanding) -> add_entries (useful/not-useful filtered info; every entry MUST carry a verbatim source_quote plus source_kind "doc" (project source_file) or "external" (source_ref URL/path) — assumed content is rejected) -> attest(ok|suspect; trusted for external sources after human review) trustworthiness -> verify = INTEGRITY check (source readable + quote found verbatim; unvouched external sources keep it from passing; failures send you back to re-read and fix) -> CONSISTENCY phase: crosscheck records one verdict per pair of useful entries (consistent|conflict); conflicts block the workflow until the entries are corrected and re-reviewed -> gaps gate (ask the user what information is missing to reach the objective, phase=gaps) -> interview gate (phase=interview: propose the agent roles + delivery type code/docs/answer-only, the user confirms via gate_answer with the interview payload) -> emit_presets writes source-backed agent role cards under agents/ + PRESETS.md (answer-only skips presets explicitly) -> write_plan(notes_md, plan_md) -> emit_tasks (TEAM BRIDGE, only when presets were emitted): team task drafts rendered to TASKS.md, each 1:1 mappable to team_task_create (subject/description/role/plan_phase/write_scopes/blocked_by), or an explicit skip via tasks=[] + skip_reason. ' +
    'New documents arrive via ingest and re-enter the loop. status returns the current stage, gate/verification/consistency state and the exact next steps — follow its "next" guidance. The workflow state lives in a .doc-workflow/ folder in the session workspace (objective.md, index.md, questions-*.md, verification.md, consistency.md, agents/<role>.md, PRESETS.md, NOTES.md, PLAN.md, TASKS.md). Use this tool whenever asked to analyze project documents toward an objective, build/update index.md, verify source reliability or logical coherence, or write notes/plan from documentation.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'start', 'gate_ask', 'gate_answer', 'add_entries', 'update_entry', 'remove_entry', 'attest', 'verify', 'crosscheck', 'emit_presets', 'emit_tasks', 'ingest', 'write_plan', 'reset'],
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
      id: { type: 'string', description: 'update_entry/remove_entry: entry id like U3 or N1.' },
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
      paths: { type: 'array', items: { type: 'string' }, description: 'ingest: new/changed documents.' },
      verdict: { type: 'string', enum: ['ok', 'suspect', 'trusted'], description: 'attest: your trustworthiness judgment. trusted = explicit human vouch required to clear an external (URL/path) source.' },
      ids: { type: 'array', items: { type: 'string' }, description: 'attest: entry ids or ["ALL"].' },
      note: { type: 'string' },
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

export function apply(ctx) {
  return ctx.effect(() => {
    const offTool = ctx.tools.register(makeTool(ctx))
    const offPrompt = ctx.systemPrompt.section(PROMPT_SECTION)
    return () => {
      offTool()
      offPrompt()
    }
  })
}
