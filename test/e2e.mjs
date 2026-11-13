/** Headless E2E for the docflow tool — imports the real module with a stub ctx. */
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert'
import { apply } from '../index.js'

const ROOT = process.cwd()
const WS = path.join(ROOT, 'ws')

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

// --- stub ctx ---
let tool
const disposers = []
const off = apply({
  effect: (fn) => { const c = fn(); disposers.push(typeof c === 'function' ? c : () => {}); return c },
  tools: { register: (t) => { tool = t; return () => {} } },
  systemPrompt: { section: () => () => {} },
  sessions: { get: () => undefined },
  workingDirectory: { defaultDirectory: WS },
})

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
await fs.cp(path.join(ROOT, 'docs'), path.join(WS, 'docs'), { recursive: true })
assert(tool && tool.name === 'docflow', 'tool registered')

// 1. status before start
let r = await call({ action: 'status' })
record(1, r.ok && r.stage === 'no-workflow', 'status no-workflow')

// 2. start
r = await call({ action: 'start', objective: 'Decide whether the billing API v2 migration is feasible and schedule the cutover', doc_roots: ['docs'] })
record(2, r.ok && r.stage === 'reading', 'start -> reading')

// 3. add_entries pre-gate rejected
r = await call({ action: 'add_entries', entries: [{ useful: true, title: 'x', content: 'y', source_file: 'docs/api.md' }] })
record(3, r.ok === false && /understanding gate/.test(r.error), 'pre-gate rejection: ' + r.error)

// 4. gates
r = await call({ action: 'gate_ask', phase: 'understanding', questions: [{ question: 'Q1 scope?', why: 'w' }, { question: 'Q2 date?', why: 'w2' }] })
assert(r.ok)
r = await call({ action: 'gate_answer', phase: 'understanding', answers: [{ question: 'Q1 scope?', answer: 'technical only' }, { question: 'Q2 date?', answer: 'no date fixed yet' }] })
record(4, r.ok && r.stage === 'reading', 'gate answered (asked/answered flags set)')
{
  const st = JSON.parse(await fs.readFile(path.join(WS, '.doc-workflow/state.json'), 'utf8'))
  record('4b', st.gates.understanding.asked === true && st.gates.understanding.answered === true && st.gates.understanding.status === 'answered', 'persisted flags: ' + JSON.stringify(st.gates.understanding))
}

// 5. add_entries batch (one bogus quote)
r = await call({ action: 'add_entries', entries: [
  { useful: true, title: 'v2 GA date', content: 'Billing API v2 goes live 2026-03-01', source_file: 'docs/api.md', source_line: 3, source_quote: 'The billing team confirmed that Billing API v2 goes live on 2026-03-01.', relevance: 'deadline' },
  { useful: true, title: 'BOGUS', content: 'invented claim', source_file: 'docs/api.md', source_quote: 'This sentence definitely does not appear anywhere in the documents.', relevance: 'negative test' },
  { useful: false, title: 'coffee machine', content: 'irrelevant retro chatter', source_file: 'docs/meeting.md', source_quote: 'People talked about the coffee machine being broken again.', relevance: 'noise' },
] })
record(5, r.ok && JSON.stringify(r.added) === '["U1","U2","N1"]', 'added U1,U2,N1')

// 6. attest + verify fails on U2 (blue loop)
r = await call({ action: 'attest', verdict: 'ok', ids: ['ALL'] })
assert(r.ok)
r = await call({ action: 'verify' })
record(6, r.ok === false && r.passed === false && r.problems.failed.includes('U2') && r.stage === 'recheck', 'verify failed on U2, stage recheck')

// 7. fix U2 -> verify passes -> gaps
r = await call({ action: 'update_entry', id: 'U2', fields: { title: 'idempotency key', content: 'POST /v2/invoices requires an idempotency key header', source_quote: 'The endpoint `POST /v2/invoices` replaces `POST /v1/invoices` and requires an idempotency key header.' } })
assert(r.ok)
r = await call({ action: 'attest', verdict: 'ok', ids: ['U2'] })
assert(r.ok)
r = await call({ action: 'verify' })
record(7, r.passed === true && r.stage === 'gaps', 'verify passed -> gaps, stage ' + r.stage)

// 8. index.md + verification.md content
{
  const idx = await fs.readFile(path.join(WS, '.doc-workflow/index.md'), 'utf8')
  const ver = await fs.readFile(path.join(WS, '.doc-workflow/verification.md'), 'utf8')
  record('8', idx.includes('## Useful information') && !/_none yet_/.test(idx.split('## Non-useful')[0]) && idx.includes('Integrity**: ok') && idx.includes('Trustworthiness**: ok') && /PASSED/.test(ver), 'index + verification rendered')
}

// 9. ingest -> reconfirm gate required for entries
r = await call({ action: 'ingest', paths: ['docs/new.md'] })
record('9a', r.ok && r.stage === 'reading' && JSON.stringify(r.pending) === '["docs/new.md"]', 'ingest pending')
r = await call({ action: 'add_entries', entries: [{ useful: true, title: 'x', content: 'y', source_file: 'docs/new.md' }] })
record('9b', r.ok === false && /reconfirm/i.test(r.error), 'entries blocked pre-reconfirm: ' + r.error)
await call({ action: 'gate_ask', phase: 'understanding', questions: [{ question: 'Hard constraints?', why: '' }] })
r = await call({ action: 'gate_answer', phase: 'understanding', answers: [{ question: 'Hard constraints?', answer: 'yes' }] })
record('9c', r.ok, 'reconfirm gate answered')

// 10. add entry from new.md, attest, verify
r = await call({ action: 'add_entries', entries: [{ useful: true, title: 'month-end batch', content: 'cutover must avoid the last 2 business days of the month', source_file: 'docs/new.md', source_quote: 'The cutover window for the billing migration must avoid month-end: invoices batch job runs on the last 2 business days of each month.', relevance: 'scheduling' }] })
record('10a', r.ok && r.added[0] === 'U3', 'U3 added')
await call({ action: 'attest', verdict: 'ok', ids: ['U3'] })
r = await call({ action: 'verify' })
record('10b', r.passed === true && r.stage === 'gaps', 'verify passed again -> gaps')

// 11. gaps gate + plan
r = await call({ action: 'write_plan', notes_md: 'x', plan_md: 'y' })
record('11a', r.ok === false && /stage/.test(r.error), 'write_plan locked before gaps answered')
await call({ action: 'gate_ask', phase: 'gaps', questions: [{ question: 'Volume threshold to block cutover?', why: '' }] })
r = await call({ action: 'gate_answer', phase: 'gaps', answers: [{ question: 'Volume threshold to block cutover?', answer: 'unknown, monitor' }] })
record('11b', r.ok && r.stage === 'plan', 'gaps answered -> plan')
r = await call({ action: 'write_plan', notes_md: '# Notes\n\nv2 GA 2026-03-01; idempotency key; avoid month-end.', plan_md: '# Plan\n\n1. Wire idempotency keys\n2. Schedule early March\n3. Alert v1 >100rps' })
record('11c', r.ok && r.stage === 'done', 'write_plan -> done')

// 12. final status (must be lossless — scanLossless already enforced)
r = await call({ action: 'status' })
record(12, r.ok && r.stage === 'done' && r.entries.useful === 3 && r.entries.not_useful === 1 && r.plan && r.plan.notes.endsWith('NOTES.md'), 'final status clean: stage done, 3U/1N, plan paths')

console.log(results.join('\n'))
console.log('ALL ' + results.length + ' CHECKS PASSED')
disposers.forEach((d) => d())
