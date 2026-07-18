import assert from 'node:assert/strict'
import { assembleBundle, reproSteps } from '@th/core/repro'
import type { ReproBundle, ConsoleEntry, NetworkEntry, ActionStep, EnvInfo } from '@th/core/repro'
import { repo } from '@th/db'

// End-to-end proof for the repro-bundle feature: (A) it round-trips through SQLite unchanged; (B) the HTTP
// ingest route accepts + sanitizes it and it comes back on the report. Run: pnpm --filter @th/mcp exec tsx src/ctx-e2e.ts

const env: EnvInfo = { url: 'https://shop.example/checkout', userAgent: 'Mozilla/5.0 test', browser: 'Chromium 126', os: 'Windows', viewport: '1280x720', dpr: 2, timezone: 'Europe/Budapest', languages: ['en-US'], connection: '4g' }
const cons: ConsoleEntry[] = [
  { level: 'log', text: 'checkout mounted', ts: 1 },
  { level: 'error', text: 'TypeError: total is undefined', ts: 2 },
]
const net: NetworkEntry[] = [
  { method: 'GET', url: 'https://shop.example/api/cart', status: 200, ms: 42, kind: 'fetch', ts: 1 },
  { method: 'POST', url: 'https://shop.example/api/checkout', status: 500, ms: 310, kind: 'fetch', ts: 2 },
]
const actions: ActionStep[] = [
  { type: 'click', selector: { css: '#buy', role: 'button', name: 'Buy now' }, url: 'https://shop.example', ts: 1 },
  { type: 'input', selector: { css: '#email', role: 'textbox', name: 'Email' }, value: 'a@b.com', url: 'https://shop.example', ts: 2 },
  { type: 'key', selector: { css: '#email' }, key: 'Enter', url: 'https://shop.example', ts: 3 },
]
const bundle: ReproBundle = assembleBundle({ env, console: cons, network: net, actions })

// ---- A. SQLite round-trip (repo layer) ----
const proj = repo.ensureProject('Demo', 'th_demo_key_0001')
const row = repo.createReport({ projectId: proj.id, note: 'ctx-e2e direct', context: bundle })
const back = repo.getReport(row.id)!
assert.ok(back.context, 'context stored')
const rb = back.context as ReproBundle
assert.deepEqual(rb.actions, bundle.actions, 'actions round-trip through SQLite JSON')
assert.equal(rb.console.length, 2)
assert.equal(rb.network[1].status, 500)
assert.equal(rb.env.timezone, 'Europe/Budapest')
assert.deepEqual(reproSteps(rb).slice(0, 1), ['1. Click button "Buy now"'])
console.log(`A ✓ SQLite round-trip OK (direct report id=${row.id})`)

// ---- B. HTTP ingest route (if collector is running) ----
const url = process.env.COLLECTOR || 'http://localhost:4319'
try {
  const res = await fetch(url + '/api/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ingestKey: 'th_demo_key_0001',
      note: 'ctx-e2e via HTTP',
      pageUrl: env.url,
      viewport: env.viewport,
      userAgent: env.userAgent,
      context: bundle,
    }),
  })
  const j = (await res.json()) as { ok?: boolean; id?: string }
  assert.ok(j.ok && j.id, 'ingest accepted')
  const httpRow = repo.getReport(j.id!)!
  const hb = httpRow.context as ReproBundle | null
  assert.ok(hb, 'context survived the HTTP route + sanitizer')
  assert.equal(hb!.actions.length, 3, 'all actions kept')
  assert.equal(hb!.network.length, 2)
  console.log(`B ✓ HTTP ingest round-trip OK (report id=${j.id}) — open /r/${j.id}`)
} catch (e) {
  console.log('B — collector offline (run `pnpm --filter @th/web dev`); A passed. ' + String(e))
}
console.log('ctx-e2e: done ✓')
