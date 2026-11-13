/** Headless E2E for the docflow tool — imports the real module with a stub ctx. */
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert'
import { apply } from '../index.js'

const ROOT = process.cwd()
const WS = path.join(ROOT, 'ws')
const WS2 = path.join(ROOT, 'ws-migrate')
const WS3 = path.join(ROOT, 'ws-migrate2')
const WS4 = path.join(ROOT, 'ws-answer')
const WS5 = path.join(ROOT, 'ws-tasks')
const WS6 = path.join(ROOT, 'ws-tasks2')
const WS7 = path.join(ROOT, 'ws-migrate3')

// --- lossless-JSON guard (mirrors the harness validation) ---
function scanLossless(v, where) {
  if (v === undefined) throw new Error(`lossless: undefined value at ${where}`)
  if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`lossless: non-finite number at ${where}`)
  if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') throw new Error(`lossless: ${typeof v} at ${where}`)
  if (Array.isArray(v)) v.forEach((x, i) => scanLossless(x, `${where}[${i}]`))
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) throw new Error(`lossless: undefined key "${k}" at ${where}`)
      scanLossless(x, `${where}.${k}`)
    }
  }
}

// --- stub ctx factory ---
function stubTool(defaultDirectory) {
  let tool
  const disposers = []
  apply({
    effect: (fn) => { const c = fn(); disposers.push(typeof c === 'function' ? c : () => {}); return c },
    tools: { register: (t) => { tool = t; return () => {} } },
    systemPrompt: { section: () => () => {} },
    sessions: { get: () => undefined },
    workingDirectory: { defaultDirectory },
  })
  return { tool, disposers }
}

const { tool, disposers } = stubTool(WS)
const results = []
let n = 0
function record(id, cond, note) {
  results.push(`${cond ? 'PASS' : 'FAIL'} #${id} — ${note}`)
  if (!cond) { console.log(results.join('\n')); process.exit(1) }
}
async function call(args) {
  const out = await tool.execute(args, {})
  scanLossless(out, 'result')
  return out
}
async function callOn(t, args) {
  const out = await t.execute(args, {})
  scanLossless(out, 'result')
  return out
}

// synthetic, fully-verified v3 state parked at stage "tasks" (v3.1 fixtures)
function v3State(overrides) {
  return {
    kind: 'docflow', version: 3, dir: '.doc-workflow', objective: 'o', doc_roots: ['docs'], stage: 'tasks',
    gates: {
      understanding: { status: 'answered', asked: true, answered: true },
      gaps: { status: 'answered', asked: true, answered: true },
      interview: { status: 'answered', asked: true, answered: true },
    },
    interview: { answerOnly: false, delivery: ['code'], roles: ['Migrator'], answeredAt: 'x' },
    presets: { status: 'emitted', emittedAt: 'x', cards: [{ role: 'Migrator', why: 'w', source_entries: ['U1'], prompt_body: 'p', file: 'agents/migrator.md' }] },
    verification: { status: 'passed', lastRun: 'x', failed: [], unanchored: [], unattested: [], suspect: [], externals: [] },
    consistency: { status: 'passed', verdicts: {}, updatedAt: 'x' },
    entries: { U1: { useful: true, title: 't', content: 'c', source_kind: 'doc', source_file: 'docs/api.md', source_quote: 'The billing team confirmed that Billing API v2 goes live on 2026-03-01.', addedAt: 'x' } },
    pendingDocs: [], plan: { writtenAt: 'x', notes: 'NOTES.md', plan: 'PLAN.md' },
    createdAt: 'x', updatedAt: 'x',
    ...overrides,
  }
}

// fresh workspace
await fs.rm(WS, { recursive: true, force: true })
await fs.rm(WS2, { recursive: true, force: true })
await fs.rm(WS3, { recursive: true, force: true })
await fs.rm(WS4, { recursive: true, force: true })
await fs.rm(WS5, { recursive: true, force: true })
await fs.rm(WS6, { recursive: true, force: true })
await fs.rm(WS7, { recursive: true, force: true })
await fs.cp(path.join(ROOT, 'docs'), path.join(WS, 'docs'), { recursive: true })
assert(tool && tool.name === 'docflow', 'tool registered')

// 1. status before start
let r = await call({ action: 'status' })
record(1, r.ok && r.stage === 'no-workflow', 'status no-workflow')

// 2. start
r = await call({ action: 'start', objective: 'Decide whether the billing API v2 migration is feasible and schedule the cutover', doc_roots: ['docs'] })
record(2, r.ok && r.stage === 'reading', 'start -> reading')

// 3. add_entries pre-gate rejected
r = await call({ action: 'add_entries', entries: [{ useful: true, title: 'x', content: 'y', source_kind: 'doc', source_file: 'docs/api.md', source_quote: 'z' }] })
record(3, r.ok === false && /understanding gate/.test(r.error), 'pre-gate rejection: ' + r.error)

// 4. gates
r = await call({ action: 'gate_ask', phase: 'understanding', questions: [{ question: 'Q1 scope?', why: 'w' }, { question: 'Q2 date?', why: 'w2' }] })
assert(r.ok)
r = await call({ action: 'gate_answer', phase: 'understanding', answers: [{ question: 'Q1 scope?', answer: 'technical only' }, { question: 'Q2 date?', answer: 'no date fixed yet' }] })
record(4, r.ok && r.stage === 'reading', 'gate answered')
{
  const st = JSON.parse(await fs.readFile(path.join(WS, '.doc-workflow/state.json'), 'utf8'))
  record('4b', st.gates.understanding.asked === true && st.gates.understanding.answered === true && st.gates.understanding.status === 'answered', 'persisted flags')
}

// 4c. entry WITHOUT verbatim quote is rejected outright (no assumed content)
r = await call({ action: 'add_entries', entries: [{ useful: true, title: 'assumed', content: 'something I believe', source_kind: 'doc', source_file: 'docs/api.md' }] })
record('4c', r.ok === false && /source_quote/.test(r.error), 'assumed content rejected at add: ' + r.error)

// 5. add_entries batch (one bogus quote)
r = await call({ action: 'add_entries', entries: [
  { useful: true, title: 'v2 GA date', content: 'Billing API v2 goes live 2026-03-01', source_kind: 'doc', source_file: 'docs/api.md', source_line: 3, source_quote: 'The billing team confirmed that Billing API v2 goes live on 2026-03-01.', relevance: 'deadline' },
  { useful: true, title: 'BOGUS', content: 'invented claim', source_kind: 'doc', source_file: 'docs/api.md', source_quote: 'This sentence definitely does not appear anywhere in the documents.', relevance: 'negative test' },
  { useful: false, title: 'coffee machine', content: 'irrelevant retro chatter', source_kind: 'doc', source_file: 'docs/meeting.md', source_quote: 'People talked about the coffee machine being broken again.', relevance: 'noise' },
] })
record(5, r.ok && JSON.stringify(r.added) === '["U1","U2","N1"]', 'added U1,U2,N1')

// 6. attest + integrity fails on U2 (blue loop)
r = await call({ action: 'attest', verdict: 'ok', ids: ['ALL'] })
assert(r.ok)
r = await call({ action: 'verify' })
record(6, r.ok === false && r.passed === false && r.problems.failed.includes('U2') && r.stage === 'recheck', 'integrity failed on U2, stage recheck')

// 6b. crosscheck locked before integrity passes
r = await call({ action: 'crosscheck', verdicts: [{ a: 'U1', b: 'U2', verdict: 'consistent' }] })
record('6b', r.ok === false && /integrity/.test(r.error), 'crosscheck locked pre-integrity: ' + r.error)

// 7. fix U2 -> integrity passes -> CONSISTENCY phase opens (pending)
r = await call({ action: 'update_entry', id: 'U2', fields: { title: 'idempotency key', content: 'POST /v2/invoices requires an idempotency key header', source_quote: 'The endpoint `POST /v2/invoices` replaces `POST /v1/invoices` and requires an idempotency key header.' } })
assert(r.ok)
r = await call({ action: 'attest', verdict: 'ok', ids: ['U2'] })
assert(r.ok)
r = await call({ action: 'verify' })
record(7, r.passed === true && r.stage === 'consistency' && r.consistency === 'pending', 'integrity passed -> consistency phase, stage ' + r.stage)

// 7b. gaps gate still locked while the matrix is incomplete
r = await call({ action: 'gate_ask', phase: 'gaps', questions: [{ question: 'nope?', why: '' }] })
record('7b', r.ok === false && /consistency/.test(r.error), 'gaps locked until consistency complete: ' + r.error)

// 7c. crosscheck the only pair -> consistency passed -> gaps
r = await call({ action: 'crosscheck', verdicts: [{ a: 'U1', b: 'U2', verdict: 'consistent', note: 'GA date and idempotency requirement are independent facts, no contradiction' }] })
record('7c', r.ok && r.consistency === 'passed' && r.stage === 'gaps' && r.verified === true, 'crosscheck complete -> gaps')

// 8. index.md + verification.md + consistency.md content
{
  const idx = await fs.readFile(path.join(WS, '.doc-workflow/index.md'), 'utf8')
  const ver = await fs.readFile(path.join(WS, '.doc-workflow/verification.md'), 'utf8')
  const con = await fs.readFile(path.join(WS, '.doc-workflow/consistency.md'), 'utf8')
  record(8, idx.includes('## Useful information') && idx.includes('Integrity**: ok') && idx.includes('Source** (doc):') && /PASSED/.test(ver) && /CONSISTENT/.test(con), 'index + integrity + consistency rendered')
}

// 9. ingest -> reconfirm gate required for entries
r = await call({ action: 'ingest', paths: ['docs/new.md'] })
record('9a', r.ok && r.stage === 'reading' && JSON.stringify(r.pending) === '["docs/new.md"]', 'ingest pending')
r = await call({ action: 'add_entries', entries: [{ useful: true, title: 'x', content: 'y', source_kind: 'doc', source_file: 'docs/new.md', source_quote: 'z' }] })
record('9b', r.ok === false && /reconfirm/i.test(r.error), 'entries blocked pre-reconfirm: ' + r.error)
await call({ action: 'gate_ask', phase: 'understanding', questions: [{ question: 'Hard constraints?', why: '' }] })
r = await call({ action: 'gate_answer', phase: 'understanding', answers: [{ question: 'Hard constraints?', answer: 'yes' }] })
record('9c', r.ok, 'reconfirm gate answered')

// 10. add U3 from new.md; integrity ok; new pairs reopen the matrix
r = await call({ action: 'add_entries', entries: [{ useful: true, title: 'month-end batch', content: 'cutover must avoid the last 2 business days of the month', source_kind: 'doc', source_file: 'docs/new.md', source_quote: 'The cutover window for the billing migration must avoid month-end: invoices batch job runs on the last 2 business days of each month.', relevance: 'scheduling' }] })
record('10a', r.ok && r.added[0] === 'U3', 'U3 added')
await call({ action: 'attest', verdict: 'ok', ids: ['U3'] })
r = await call({ action: 'verify' })
record('10b', r.passed === true && r.stage === 'consistency' && r.consistency === 'pending', 'integrity passed again; matrix incomplete (new pairs missing)')

// 10c. record a CONFLICT on U2|U3 -> blocked
r = await call({ action: 'crosscheck', verdicts: [
  { a: 'U1', b: 'U3', verdict: 'consistent', note: 'GA date does not constrain the month-end window' },
  { a: 'U2', b: 'U3', verdict: 'conflict', note: 'api.md says cutover is free-form; new.md forbids month-end — dates clash' },
] })
record('10c', r.ok === false && r.consistency === 'conflict' && r.stage === 'consistency' && r.conflicts.length === 1, 'conflict recorded -> blocked')

// 10d. fix the conflicting entry (verdict auto-invalidated), re-review -> passed
r = await call({ action: 'update_entry', id: 'U3', fields: { content: 'cutover must avoid the last 2 business days of the month (confirmed constraint, api.md does not forbid it)' } })
assert(r.ok)
await call({ action: 'attest', verdict: 'ok', ids: ['U3'] })
r = await call({ action: 'verify' })
assert(r.passed === true, 'integrity re-passed after U3 fix')
r = await call({ action: 'crosscheck', verdicts: [
  { a: 'U1', b: 'U3', verdict: 'consistent', note: 'GA date does not constrain the month-end window' },
  { a: 'U2', b: 'U3', verdict: 'consistent', note: 'constraint refined: no actual contradiction with the idempotency requirement' },
] })
record('10d', r.ok && r.consistency === 'passed' && r.stage === 'gaps', 'conflict resolved -> gaps')

// 10e. external source entry: needs ref + quote; URL verified as "declared"
r = await call({ action: 'add_entries', entries: [{ useful: true, title: 'v1 sunset comms', content: 'v1 is retired 6 months after v2 GA per the internal newsletter', source_kind: 'external', source_ref: 'https://intranet.example.com/billing/newsletter-42', source_quote: 'Billing API v1 will be retired six months after the v2 general availability date.' }] })
record('10e', r.ok && r.added[0] === 'U4', 'external entry U4 added')
r = await call({ action: 'add_entries', entries: [{ useful: true, title: 'ext-bad', content: 'no ref', source_kind: 'external', source_quote: 'whatever' }] })
record('10e2', r.ok === false && /source_ref/.test(r.error), 'external without ref rejected')
await call({ action: 'attest', verdict: 'ok', ids: ['U4'] })
r = await call({ action: 'verify' })
record('10e3', r.passed === false && r.problems.externals.includes('U4') && r.stage === 'recheck' && /trusted/.test(r.hint || ''), 'un-vouched external URL blocks VERIFIED')
r = await call({ action: 'attest', verdict: 'trusted', ids: ['U4'], note: 'user reviewed the newsletter on 2026-11-13' })
assert(r.ok)
r = await call({ action: 'verify' })
record('10e4', r.passed === true && r.problems.externals.length === 0 && r.stage === 'consistency', 'trusted vouch clears the block; matrix reopened')
r = await call({ action: 'crosscheck', verdicts: [
  { a: 'U1', b: 'U4', verdict: 'consistent', note: 'sunset is relative to GA, compatible' },
  { a: 'U2', b: 'U4', verdict: 'consistent', note: 'orthogonal facts' },
  { a: 'U3', b: 'U4', verdict: 'consistent', note: 'orthogonal facts' },
] })
record('10f', r.ok && r.stage === 'gaps', 'matrix closed again -> gaps')

// 11. gaps gate -> interview gate -> presets -> plan
r = await call({ action: 'write_plan', notes_md: 'x', plan_md: 'y' })
record('11a', r.ok === false && /stage/.test(r.error), 'write_plan locked before gaps answered')
await call({ action: 'gate_ask', phase: 'gaps', questions: [{ question: 'Volume threshold to block cutover?', why: '' }] })
r = await call({ action: 'gate_answer', phase: 'gaps', answers: [{ question: 'Volume threshold to block cutover?', answer: 'unknown, monitor' }] })
record('11b', r.ok && r.stage === 'interview', 'gaps answered -> interview')

// 11b2. v3.1: emit_tasks outside the tasks stage is rejected (§4.1)
r = await call({ action: 'emit_tasks', tasks: [{ subject: 'nope', description: 'd', role: 'Migrator', plan_phase: 'P' }] })
record('11b2', r.ok === false && /only allowed at stage/.test(r.error) && /"tasks"/.test(r.error), 'emit_tasks rejected outside tasks stage: ' + r.error)

// 11c0. emit_presets before the interview gate is answered -> locked
r = await call({ action: 'emit_presets', cards: [{ role: 'Migrator', why: 'w', source_entries: ['U1'], prompt_body: 'p' }] })
record('11c0', r.ok === false && /interview/i.test(r.error), 'emit_presets pre-interview locked: ' + r.error)

// 11c1. gate_answer phase=interview WITHOUT payload -> fail
r = await call({ action: 'gate_answer', phase: 'interview', answers: [{ question: 'Roles?', answer: 'yes' }] })
record('11c1', r.ok === false && /interview payload/.test(r.error), 'interview answer needs payload: ' + r.error)

// 11c2. invalid payload (empty roles) -> fail, gate untouched
r = await call({ action: 'gate_answer', phase: 'interview', answers: [{ question: 'Roles?', answer: 'x' }], interview: { delivery: ['code'], roles: [] } })
record('11c2', r.ok === false && /delivery/.test(r.error), 'invalid interview payload rejected: ' + r.error)

// interview gate asked + answered with payload -> stage presets
r = await call({ action: 'gate_ask', phase: 'interview', questions: [{ question: 'Confirm roles migrator + reviewer, delivery code?', why: 'presets' }] })
assert(r.ok, 'interview gate asked')
r = await call({ action: 'gate_answer', phase: 'interview', answers: [{ question: 'Confirm roles migrator + reviewer, delivery code?', answer: 'yes, code only' }], interview: { delivery: ['code'], roles: ['migrator', 'reviewer'] } })
record('11c3', r.ok && r.stage === 'presets', 'interview answered -> presets')

// 11c5. card citing an unknown entry -> fail
r = await call({ action: 'emit_presets', cards: [{ role: 'Migrator', why: 'w', source_entries: ['U9'], prompt_body: 'p' }] })
record('11c5', r.ok === false && /U9/.test(r.error), 'card citing unknown entry rejected: ' + r.error)

// 11c6. card citing a non-useful entry -> fail
r = await call({ action: 'emit_presets', cards: [{ role: 'Migrator', why: 'w', source_entries: ['N1'], prompt_body: 'p' }] })
record('11c6', r.ok === false && /useful/.test(r.error), 'card citing non-useful entry rejected: ' + r.error)

// 11c7. good cards, overlapping write_scope -> emitted with advisory warning -> plan
const cardsA = [
  { role: 'Migrator', why: 'schema + data migration scripts for v1->v2 must be written and sequenced before cutover', source_entries: ['U1', 'U3'], prompt_body: 'You own the v1->v2 invoice migration. Respect the month-end freeze: no cutover tasks during the last 2 business days of any month. Produce reversible migrations.', write_scope: ['src/migrations/'] },
  { role: 'Reviewer', why: 'every migration must be reviewed against the idempotency key requirement before merge', source_entries: ['U2'], prompt_body: 'Review migrations and callers for the required idempotency key header on POST /v2/invoices. Block merges that miss it.', write_scope: ['src/migrations/'] },
]
r = await call({ action: 'emit_presets', cards: cardsA })
record('11c7', r.ok && r.stage === 'plan' && r.emitted === 2 && Array.isArray(r.warnings) && r.warnings.includes('write_scope overlap: Migrator ↔ Reviewer'), 'cards emitted with overlap warning -> plan')

// 11c8. artifacts on disk
{
  const pre = await fs.readFile(path.join(WS, '.doc-workflow/PRESETS.md'), 'utf8')
  const mig = await fs.readFile(path.join(WS, '.doc-workflow/agents/migrator.md'), 'utf8')
  record('11c8', pre.includes('agents/migrator.md') && mig.includes('role: Migrator') && mig.includes('source_entries:') && mig.includes('  - U1') && mig.includes('month-end freeze'), 'PRESETS.md + agents/migrator.md on disk')
}

r = await call({ action: 'write_plan', notes_md: '# Notes\n\nv2 GA 2026-03-01; idempotency key; avoid month-end; v1 +6mo.', plan_md: '# Plan\n\n1. Wire idempotency keys\n2. Schedule early March\n3. Alert v1 >100rps' })
record('11c', r.ok && r.stage === 'tasks', 'write_plan with emitted presets -> tasks stage (v3.1 §1; was done)')

// 12. final status (must be lossless — scanLossless already enforced) + generated team section
r = await call({ action: 'status' })
record(12, r.ok && r.stage === 'tasks' && r.entries.useful === 4 && r.entries.not_useful === 1 && r.verified === true && r.consistency.status === 'passed' && r.plan && r.plan.notes.endsWith('NOTES.md') && r.interview.status === 'answered' && r.interview.answer_only === false && JSON.stringify(r.interview.delivery) === '["code"]' && r.interview.roles.length === 2 && r.presets.status === 'emitted' && r.presets.cards.length === 2 && r.tasks.status === 'pending' && r.tasks.count === 0, 'status clean: tasks stage, 4U/1N, verified, interview + presets + pending tasks exposed')
{
  const plan = await fs.readFile(path.join(WS, '.doc-workflow/PLAN.md'), 'utf8')
  record('12b', plan.includes('## Delivery & team (generated)') && plan.includes('agents/migrator.md'), 'PLAN.md carries the generated delivery & team section')
  record('12b2', plan.includes('Task drafts: TASKS.md (pending)'), 'PLAN.md gains the task-drafts pointer, pending at first write (§7)')
}

// 12t. v3.1 emit_tasks — hard validations at the tasks stage (§4)
r = await call({ action: 'emit_tasks', tasks: [{ subject: 'Wire keys', description: 'd', role: 'Scribe', plan_phase: 'P' }] })
record('12t1', r.ok === false && /Scribe/.test(r.error) && /Migrator, Reviewer/.test(r.error), 'unknown role rejected listing valid card roles: ' + r.error)
r = await call({ action: 'emit_tasks', tasks: [{ subject: '   ', description: 'd', role: 'Migrator', plan_phase: 'P' }] })
record('12t2', r.ok === false && /non-empty subject/.test(r.error), 'empty subject rejected: ' + r.error)
r = await call({ action: 'emit_tasks', tasks: [
  { subject: 'Alpha', description: 'd', role: 'Migrator', plan_phase: 'P', blocked_by: ['beta'] },
  { subject: 'Beta', description: 'd', role: 'Reviewer', plan_phase: 'P', blocked_by: ['gamma'] },
  { subject: 'Gamma', description: 'd', role: 'Reviewer', plan_phase: 'P', blocked_by: ['alpha'] },
] })
record('12t3', r.ok === false && r.error.includes('alpha → beta → gamma → alpha'), 'blocked_by cycle rejected with the cycle path: ' + r.error)
r = await call({ action: 'emit_tasks', tasks: [{ subject: 'Solo', description: 'd', role: 'Migrator', plan_phase: 'P', blocked_by: ['solo'] }] })
record('12t4', r.ok === false && r.error.includes('solo → solo'), 'self-block rejected with the cycle path: ' + r.error)
r = await call({ action: 'emit_tasks', tasks: [{ subject: 'Solo', description: 'd', role: 'Migrator', plan_phase: 'P', blocked_by: ['nope-9'] }] })
record('12t5', r.ok === false && /nope-9/.test(r.error), 'blocked_by must reference an id in this batch: ' + r.error)
r = await call({ action: 'emit_tasks', tasks: [] })
record('12t6', r.ok === false && /skip_reason/.test(r.error), 'empty batch rejected without skip_reason: ' + r.error)

// 12t7. happy path -> done, with the no-markers coverage warning (§4.7)
const tasksA = [
  { subject: 'Wire idempotency keys', description: 'Add the idempotency key header to every POST /v2/invoices caller path; block merges that miss it.', role: 'Reviewer', plan_phase: 'Phase 1 — keys' },
  { subject: 'Migration scripts', description: 'Write reversible v1->v2 invoice migrations, sequenced before cutover; respect the month-end freeze.', role: 'Migrator', plan_phase: 'Phase 1 — keys' },
  { subject: 'Cutover runbook', description: 'Document the early-March cutover avoiding the last 2 business days; wire the v1 >100rps alert.', role: 'Migrator', plan_phase: 'Phase 2 — cutover', write_scopes: ['docs/ops/'], blocked_by: ['migration-scripts', 'migration-scripts', 'wire-idempotency-keys'] },
]
r = await call({ action: 'emit_tasks', tasks: tasksA })
record('12t7', r.ok && r.stage === 'done' && r.emitted === 3 && Array.isArray(r.warnings) && r.warnings.includes('coverage: PLAN.md phase markers not found'), 'emit_tasks happy path -> done + no-markers coverage warning')
{
  const tk = await fs.readFile(path.join(WS, '.doc-workflow/TASKS.md'), 'utf8')
  record('12t8', tk.includes('# Task drafts') && tk.includes('machine consumers') && tk.includes('team_task_create') && tk.includes('## Cutover runbook') && tk.includes('- **role**: Migrator · **plan phase**: Phase 2 — cutover') && tk.includes('- **write_scopes**: `docs/ops/`') && tk.includes('- **blocked_by**: migration-scripts, wire-idempotency-keys') && tk.includes('Document the early-March cutover'), 'TASKS.md rendered: header + 1:1 pointer + sections + deduped blocked_by + description')
}
{
  const st = JSON.parse(await fs.readFile(path.join(WS, '.doc-workflow/state.json'), 'utf8'))
  const it = st.tasks.items
  record('12t9', st.tasks.status === 'emitted' && !st.tasks.stale && it.length === 3 && it[0].id === 'wire-idempotency-keys' && it[0].description.startsWith('Add the idempotency key') && JSON.stringify(it[0].write_scopes) === '["src/migrations/"]' && JSON.stringify(it[2].write_scopes) === '["docs/ops/"]' && JSON.stringify(it[2].blocked_by) === '["migration-scripts","wire-idempotency-keys"]' && it.every((x) => x.subject && x.role && x.plan_phase), 'state tasks items complete: description kept, card-inherited + overridden scopes, deduped refs')
}
r = await call({ action: 'status' })
record('12t10', r.tasks.status === 'emitted' && r.tasks.count === 3 && r.tasks.stale === false && r.tasks.warnings.length === 1 && !!r.tasks.emittedAt, 'status tasks block: emitted + count + warnings + emittedAt')

// 12t11. staleness chain (§5): entry update -> presets.stale AND tasks.stale
r = await call({ action: 'update_entry', id: 'U1', fields: { content: 'Billing API v2 goes live 2026-03-01 (double-checked)' } })
assert(r.ok)
r = await call({ action: 'status' })
record('12t11', r.presets.status === 'stale' && r.tasks.status === 'emitted' && r.tasks.stale === true, 'staleness chain: update_entry -> presets.stale + tasks.stale')
// restore integrity so the pre-existing interview-reanswer continuation below still runs
await call({ action: 'attest', verdict: 'ok', ids: ['U1'] })
r = await call({ action: 'verify' })
assert(r.passed === true, 'integrity re-passed after the staleness-chain update')
r = await call({ action: 'crosscheck', verdicts: [
  { a: 'U1', b: 'U2', verdict: 'consistent', note: 'GA date and idempotency requirement are independent facts, no contradiction' },
  { a: 'U1', b: 'U3', verdict: 'consistent', note: 'GA date does not constrain the month-end window' },
  { a: 'U1', b: 'U4', verdict: 'consistent', note: 'sunset is relative to GA, compatible' },
] })
assert(r.consistency === 'passed', 'crosscheck re-closed after the staleness-chain update')

// 12c. re-answer the interview -> emitted presets go stale, stage back to presets
r = await call({ action: 'gate_answer', phase: 'interview', answers: [{ question: 'Roles still migrator + reviewer?', answer: 'add a docs writer, deliver docs too' }], interview: { delivery: ['code', 'docs'], roles: ['migrator', 'reviewer', 'docs-writer'] } })
record('12c', r.ok && r.stage === 'presets', 'interview re-answered -> presets')
r = await call({ action: 'status' })
record('12c2', r.presets.status === 'stale' && r.stage === 'presets', 're-answer marks emitted presets stale')

// 12d. re-emit with 3 cards, no write_scope at all -> plan, no warnings
const cardsB = cardsA.map(({ write_scope, ...c }) => c)
r = await call({ action: 'emit_presets', cards: [...cardsB, { role: 'Docs Writer', why: 'the v1 sunset comms and the GA date must reach internal docs', source_entries: ['U4', 'U1'], prompt_body: 'Update internal docs with the v2 GA date (2026-03-01) and the v1 sunset (GA + 6 months).' }] })
record('12d', r.ok && r.stage === 'plan' && r.emitted === 3 && r.warnings === undefined, 're-emit 3 cards, no scope-overlap warnings -> plan')
r = await call({ action: 'write_plan', notes_md: 'n2', plan_md: 'p2\n\n## Fasi\n\n**Prep (entro 2026-02-20)**\n\n**Migrazione**\n\n**Cutover**\n' })
{
  const plan = await fs.readFile(path.join(WS, '.doc-workflow/PLAN.md'), 'utf8')
  record('12e', r.ok && r.stage === 'tasks' && plan.includes('agents/docs-writer.md'), 're-written PLAN.md lists the new role card, lands on tasks stage (v3.1)')
  record('12e0', plan.includes('Task drafts: TASKS.md (emitted 3)'), 'PLAN.md pointer reflects the emitted task drafts (§7)')
}
// 12e2. re-run emit_tasks from tasks overwrites cleanly: stale cleared, coverage recomputed (§4.7 soft)
r = await call({ action: 'emit_tasks', tasks: [
  { subject: 'Wire idempotency keys', description: 'Add the idempotency key header to every POST /v2/invoices caller path; block merges that miss it.', role: 'Reviewer', plan_phase: 'Prep (entro 2026-02-20)' },
  { subject: 'Migration scripts', description: 'Write reversible v1->v2 invoice migrations, sequenced before cutover; respect the month-end freeze.', role: 'Migrator', plan_phase: 'Migrazione' },
  { subject: 'Sunset comms', description: 'Announce v1 retirement (GA + 6 months) in internal docs once cutover is scheduled.', role: 'Docs Writer', plan_phase: 'Migrazione' },
] })
record('12e2', r.ok && r.stage === 'done' && r.emitted === 3 && Array.isArray(r.warnings) && r.warnings.length === 1 && r.warnings.includes('coverage: plan phase "Cutover" has no task'), 're-emit overwrites, clears stale, soft coverage warning for unreferenced phase')
{
  const st = JSON.parse(await fs.readFile(path.join(WS, '.doc-workflow/state.json'), 'utf8'))
  record('12e3', st.tasks.status === 'emitted' && !st.tasks.stale && st.tasks.items.length === 3, 'state after overwrite: emitted, stale cleared')
}

// 12f. ingest after done -> presets stale + interview reconfirm armed + tasks staleness chain (§5)
r = await call({ action: 'ingest', paths: ['docs/new.md'] })
{
  const st = JSON.parse(await fs.readFile(path.join(WS, '.doc-workflow/state.json'), 'utf8'))
  record('12f', r.ok && r.stage === 'reading' && st.presets.status === 'stale' && st.gates.interview.reconfirm === true && st.tasks.status === 'emitted' && st.tasks.stale === true, 'ingest: presets stale + interview reconfirm + tasks staleness chain')
}

// 13. migration of a v1 state (line-only anchor, verification passed) -> stale + indexing + consistency shell
{
  const { tool: t2, disposers: d2 } = stubTool(WS2)
  await fs.mkdir(path.join(WS2, '.doc-workflow'), { recursive: true })
  const v1 = {
    kind: 'docflow', version: 1, dir: '.doc-workflow', objective: 'old objective', doc_roots: ['docs'], stage: 'gaps',
    gates: { understanding: { status: 'answered', asked: true, answered: true }, gaps: { status: 'open' } },
    verification: { status: 'passed', lastRun: '2026-01-01T00:00:00.000Z', failed: [], unanchored: ['U1'], unattested: [], suspect: [] },
    entries: { U1: { useful: true, title: 't', content: 'c', source_file: 'docs/api.md', source_line: 1, addedAt: 'x' } },
    pendingDocs: [], plan: {}, createdAt: 'x', updatedAt: 'x',
  }
  await fs.writeFile(path.join(WS2, '.doc-workflow/state.json'), JSON.stringify(v1), 'utf8')
  const out = await callOn(t2, { action: 'status' })
  record('13a', out.stage === 'indexing' && out.verification === 'stale' && out.consistency.status === 'n/a', 'v1 state migrated: demoted to indexing/stale')
  const st = JSON.parse(await fs.readFile(path.join(WS2, '.doc-workflow/state.json'), 'utf8'))
  record('13b', st.version === 3 && st.entries.U1.source_kind === 'doc' && st.consistency && st.presets.status === 'none', 'migration persisted (version 3, source_kind doc, presets shell)')
  d2.forEach((d) => d())
}

// 13c-e. migration of a v2 state parked at plan -> demoted to interview, verification preserved
{
  const { tool: t3, disposers: d3 } = stubTool(WS3)
  await fs.mkdir(path.join(WS3, '.doc-workflow'), { recursive: true })
  const v2 = {
    kind: 'docflow', version: 2, dir: '.doc-workflow', objective: 'v2 objective', doc_roots: ['docs'], stage: 'plan',
    gates: { understanding: { status: 'answered', asked: true, answered: true }, gaps: { status: 'answered', asked: true, answered: true } },
    verification: { status: 'passed', lastRun: '2026-01-01T00:00:00.000Z', failed: [], unanchored: [], unattested: [], suspect: [], externals: [] },
    consistency: { status: 'passed', verdicts: {}, updatedAt: '2026-01-01T00:00:00.000Z' },
    entries: {},
    pendingDocs: [], plan: {}, createdAt: 'x', updatedAt: 'x',
  }
  await fs.writeFile(path.join(WS3, '.doc-workflow/state.json'), JSON.stringify(v2), 'utf8')
  const out = await callOn(t3, { action: 'status' })
  const st3 = JSON.parse(await fs.readFile(path.join(WS3, '.doc-workflow/state.json'), 'utf8'))
  record('13c', out.stage === 'interview' && st3.version === 3 && st3.gates.interview.status === 'open' && st3.verification.status === 'passed', 'v2 plan state demoted to interview, v3 persisted, verification kept')
  r = await callOn(t3, { action: 'gate_ask', phase: 'interview', questions: [{ question: 'Roles for the old objective?', why: '' }] })
  assert(r.ok, 'interview ask on migrated folder')
  r = await callOn(t3, { action: 'gate_answer', phase: 'interview', answers: [{ question: 'Roles for the old objective?', answer: 'code, one role' }], interview: { delivery: ['code'], roles: ['coder'] } })
  const ivMd = await fs.readFile(path.join(WS3, '.doc-workflow/questions-interview.md'), 'utf8')
  record('13d', r.ok && r.stage === 'presets' && ivMd.includes('# Interview questions'), 'migrated folder interview flow works, questions-interview.md ensured')
  d3.forEach((d) => d())
}

// 14. answer-only objective (ws-answer): interview skips presets explicitly
{
  const { tool: t4, disposers: d4 } = stubTool(WS4)
  await fs.cp(path.join(ROOT, 'docs'), path.join(WS4, 'docs'), { recursive: true })
  const fast = async (args) => {
    const out = await callOn(t4, args)
    assert(out.ok !== false, `fast-forward step failed: ${JSON.stringify(args)} -> ${JSON.stringify(out)}`)
    return out
  }
  await fast({ action: 'start', objective: 'Answer whether the v2 GA date is at risk from the month-end batch', doc_roots: ['docs'] })
  await fast({ action: 'gate_ask', phase: 'understanding', questions: [{ question: 'Audience?', why: '' }] })
  await fast({ action: 'gate_answer', phase: 'understanding', answers: [{ question: 'Audience?', answer: 'billing leads' }] })
  await fast({ action: 'add_entries', entries: [
    { useful: true, title: 'v2 GA date', content: 'Billing API v2 goes live 2026-03-01', source_kind: 'doc', source_file: 'docs/api.md', source_quote: 'The billing team confirmed that Billing API v2 goes live on 2026-03-01.' },
    { useful: true, title: 'idempotency key', content: 'POST /v2/invoices requires an idempotency key', source_kind: 'doc', source_file: 'docs/api.md', source_quote: 'The endpoint `POST /v2/invoices` replaces `POST /v1/invoices` and requires an idempotency key header.' },
  ] })
  await fast({ action: 'attest', verdict: 'ok', ids: ['ALL'] })
  await fast({ action: 'verify' })
  await fast({ action: 'crosscheck', verdicts: [{ a: 'U1', b: 'U2', verdict: 'consistent', note: 'independent facts' }] })
  await fast({ action: 'gate_ask', phase: 'gaps', questions: [{ question: 'Any risk threshold?', why: '' }] })
  r = await fast({ action: 'gate_answer', phase: 'gaps', answers: [{ question: 'Any risk threshold?', answer: 'no' }] })
  record('14a', r.stage === 'interview', 'answer-only workspace reaches interview stage')
  const rLock = await callOn(t4, { action: 'emit_presets', cards: [{ role: 'X', why: 'w', source_entries: ['U1'], prompt_body: 'p' }] })
  record('14b', rLock.ok === false && /interview/i.test(rLock.error), 'emit_presets locked before interview: ' + rLock.error)
  await fast({ action: 'gate_ask', phase: 'interview', questions: [{ question: 'Is this analysis-only?', why: '' }] })
  r = await fast({ action: 'gate_answer', phase: 'interview', answers: [{ question: 'Is this analysis-only?', answer: 'yes, just the answer' }], interview: { answer_only: true } })
  record('14c', r.ok && r.stage === 'plan', 'answer-only interview -> plan (no presets stage)')
  r = await callOn(t4, { action: 'status' })
  record('14d', r.interview.answer_only === true && r.presets.status === 'skipped' && r.presets.skip_reason === 'interview: delivery=answer-only, no execution roles', 'status: answer_only + presets skipped with exact reason')
  const rAO = await callOn(t4, { action: 'emit_presets', cards: [{ role: 'X', why: 'w', source_entries: ['U1'], prompt_body: 'p' }] })
  record('14e', rAO.ok === false && /answer-only/i.test(rAO.error), 'emit_presets rejected for answer-only objective')
  r = await fast({ action: 'write_plan', notes_md: 'n', plan_md: 'v2 GA (2026-03-01) does not collide with month-end if scheduled before the last 2 business days.' })
  {
    const plan = await fs.readFile(path.join(WS4, '.doc-workflow/PLAN.md'), 'utf8')
    record('14f', r.ok && r.stage === 'done' && !plan.includes('Delivery & team'), 'answer-only plan written WITHOUT the generated team section')
  }
  r = await callOn(t4, { action: 'status' })
  record('14g', r.stage === 'done' && r.tasks.status === 'pending' && r.tasks.count === 0 && r.tasks.stale === false && Array.isArray(r.tasks.warnings) && r.tasks.warnings.length === 0, 'answer-only: still lands done, tasks serialized as pending with empty block (§3)')
  d4.forEach((d) => d())
}

// 15. synthetic v3 state at stage tasks: skip path + re-run rejection (WS5)
{
  const { tool: t5, disposers: d5 } = stubTool(WS5)
  await fs.mkdir(path.join(WS5, '.doc-workflow'), { recursive: true })
  await fs.writeFile(path.join(WS5, '.doc-workflow/state.json'), JSON.stringify(v3State()))
  r = await callOn(t5, { action: 'status' })
  record('15a', r.ok && r.stage === 'tasks' && r.tasks.status === 'pending' && r.tasks.count === 0 && r.tasks.stale === false && r.tasks.warnings.length === 0, 'v3 tasks state loads, status reports pending tasks (§3)')
  r = await callOn(t5, { action: 'emit_tasks', tasks: [] })
  record('15b', r.ok === false && /skip_reason/.test(r.error), 'empty batch without skip_reason rejected (WS5)')
  r = await callOn(t5, { action: 'emit_tasks', tasks: [], skip_reason: 'single-owner change, tracked outside the board' })
  record('15c', r.ok && r.stage === 'done' && r.skipped === true, 'emit_tasks skip path with explicit skip_reason -> done')
  {
    const tk = await fs.readFile(path.join(WS5, '.doc-workflow/TASKS.md'), 'utf8')
    record('15d', tk.includes('# Task drafts') && tk.includes('team_task_create') && tk.includes('_Skipped: single-owner change, tracked outside the board_'), 'skipped TASKS.md: header + pointer + _Skipped: reason_ (§6)')
  }
  r = await callOn(t5, { action: 'status' })
  record('15e', r.tasks.status === 'skipped' && r.tasks.skipReason === 'single-owner change, tracked outside the board' && r.tasks.count === 0, 'status tasks skipped + skipReason (camelCase, lead note)')
  r = await callOn(t5, { action: 'emit_tasks', tasks: [{ subject: 'Late task', description: 'd', role: 'Migrator', plan_phase: 'P' }] })
  record('15f', r.ok === false && /only allowed at stage/.test(r.error), 'emit_tasks after skip (stage done) rejected as wrong-stage')
  d5.forEach((d) => d())
}

// 16. presets skipped at tasks stage: role-source rejection + legal skip (WS6)
{
  const { tool: t6, disposers: d6 } = stubTool(WS6)
  await fs.mkdir(path.join(WS6, '.doc-workflow'), { recursive: true })
  await fs.writeFile(path.join(WS6, '.doc-workflow/state.json'), JSON.stringify(v3State({ presets: { status: 'skipped', skipReason: 'answer-only', skippedAt: 'x' } })))
  r = await callOn(t6, { action: 'emit_tasks', tasks: [{ subject: 'Ghost work', description: 'd', role: 'Ghost', plan_phase: 'P' }] })
  record('16a', r.ok === false && /presets/.test(r.error), 'tasks with skipped presets rejected — no role source (§4.2)')
  r = await callOn(t6, { action: 'emit_tasks', tasks: [], skip_reason: 'no roles, nothing to draft' })
  record('16b', r.ok && r.stage === 'done' && r.skipped === true, 'skipped presets -> tasks skipped with skip_reason')
  d6.forEach((d) => d())
}

// 17. legacy v3 state at stage done (no tasks block): accepted as-is, no retro-demotion (WS7)
{
  const { tool: t7, disposers: d7 } = stubTool(WS7)
  await fs.mkdir(path.join(WS7, '.doc-workflow'), { recursive: true })
  await fs.writeFile(path.join(WS7, '.doc-workflow/state.json'), JSON.stringify(v3State({ stage: 'done' })))
  r = await callOn(t7, { action: 'status' })
  record('17a', r.ok && r.stage === 'done' && r.tasks.status === 'pending' && r.tasks.count === 0, 'legacy v3 done without tasks block loads untouched, status synthesizes pending (§1)')
  {
    const st = JSON.parse(await fs.readFile(path.join(WS7, '.doc-workflow/state.json'), 'utf8'))
    record('17b', st.version === 3 && st.stage === 'done' && st.tasks === undefined, 'no retro-write: persisted state keeps version 3, done, no tasks field (§2 additive)')
  }
  d7.forEach((d) => d())
}

console.log(results.join('\n'))
console.log('ALL ' + results.length + ' CHECKS PASSED')
disposers.forEach((d) => d())
