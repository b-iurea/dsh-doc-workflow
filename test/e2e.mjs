/** Headless E2E for the docflow tool — imports the real module with a stub ctx. */
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert'
import { apply } from '../index.js'

const ROOT = process.cwd()
const WS = path.join(ROOT, 'ws')
const WS2 = path.join(ROOT, 'ws-migrate')

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

// fresh workspace
await fs.rm(WS, { recursive: true, force: true })
await fs.rm(WS2, { recursive: true, force: true })
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

// 11. gaps gate + plan
r = await call({ action: 'write_plan', notes_md: 'x', plan_md: 'y' })
record('11a', r.ok === false && /stage/.test(r.error), 'write_plan locked before gaps answered')
await call({ action: 'gate_ask', phase: 'gaps', questions: [{ question: 'Volume threshold to block cutover?', why: '' }] })
r = await call({ action: 'gate_answer', phase: 'gaps', answers: [{ question: 'Volume threshold to block cutover?', answer: 'unknown, monitor' }] })
record('11b', r.ok && r.stage === 'plan', 'gaps answered -> plan')
r = await call({ action: 'write_plan', notes_md: '# Notes\n\nv2 GA 2026-03-01; idempotency key; avoid month-end; v1 +6mo.', plan_md: '# Plan\n\n1. Wire idempotency keys\n2. Schedule early March\n3. Alert v1 >100rps' })
record('11c', r.ok && r.stage === 'done', 'write_plan -> done')

// 12. final status (must be lossless — scanLossless already enforced)
r = await call({ action: 'status' })
record(12, r.ok && r.stage === 'done' && r.entries.useful === 4 && r.entries.not_useful === 1 && r.verified === true && r.consistency.status === 'passed' && r.plan && r.plan.notes.endsWith('NOTES.md'), 'final status clean: done, 4U/1N, verified, plan paths')

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
  const out = await t2.execute({ action: 'status' }, {})
  record('13a', out.stage === 'indexing' && out.verification === 'stale' && out.consistency.status === 'n/a', 'v1 state migrated: demoted to indexing/stale')
  const st = JSON.parse(await fs.readFile(path.join(WS2, '.doc-workflow/state.json'), 'utf8'))
  record('13b', st.version === 2 && st.entries.U1.source_kind === 'doc' && st.consistency, 'migration persisted (version 2, source_kind doc)')
  d2.forEach((d) => d())
}

console.log(results.join('\n'))
console.log('ALL ' + results.length + ' CHECKS PASSED')
disposers.forEach((d) => d())
