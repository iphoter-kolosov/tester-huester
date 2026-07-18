import assert from 'node:assert/strict'
import { repo } from '@th/db'

// Proves the replay pipe: POST a report with rrweb events → collector stores them as a blob → the report
// carries a replay_url → the /api/asset route serves the events back. Run with the collector up:
//   pnpm --filter @th/mcp exec tsx src/replay-e2e.ts

const base = process.env.COLLECTOR || 'http://localhost:4319'

// A minimal rrweb-shaped stream (Meta + FullSnapshot + one incremental). Enough to exercise storage/serve;
// real playback fidelity comes from actual extension captures.
const events = [
  { type: 4, data: { href: 'https://shop.example/checkout', width: 1280, height: 720 }, timestamp: 1 },
  { type: 2, data: { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { top: 0, left: 0 } }, timestamp: 2 },
  { type: 3, data: { source: 2, type: 2, id: 1, x: 10, y: 20 }, timestamp: 900 },
]

const res = await fetch(base + '/api/ingest', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ingestKey: 'th_demo_key_0001', note: 'replay-e2e', pageUrl: 'https://shop.example/checkout', replay: events }),
})
const j = (await res.json()) as { ok?: boolean; id?: string }
assert.ok(j.ok && j.id, 'ingest accepted')

const row = repo.getReport(j.id!)!
assert.ok(row.replayUrl, 'report has a replay_url')
assert.match(row.replayUrl!, /^\/api\/asset\/[a-f0-9-]+\.json$/, 'replay_url points at the asset route')
console.log(`report ${j.id} → replayUrl ${row.replayUrl}`)

// The asset route must serve the events back.
const asset = await fetch(base + row.replayUrl!)
assert.equal(asset.status, 200, 'asset served')
assert.equal(asset.headers.get('content-type'), 'application/json', 'served as json')
const blob = (await asset.json()) as { events?: unknown[] }
assert.equal(blob.events?.length, 3, 'all events round-tripped through the blob')

// Path-traversal guard.
const bad = await fetch(base + '/api/asset/' + encodeURIComponent('../../db.ts'))
assert.ok(bad.status === 400 || bad.status === 404, 'traversal blocked')

console.log(`replay-e2e: done ✓ — open ${base}/r/${j.id}`)
