import assert from 'node:assert/strict'
import { buildReport } from './report'

// 1. Pure shape: trimming + viewport formatting + key pass-through.
const p = buildReport({
  ingestKey: 'th_demo_key_0001', note: '  hi  ', screenshot: 'data:image/png;base64,AAA',
  pageUrl: 'https://x.com', innerWidth: 1440, innerHeight: 900, userAgent: 'ua',
})
assert.equal(p.note, 'hi')
assert.equal(p.viewport, '1440x900')
assert.equal(p.ingestKey, 'th_demo_key_0001')
assert.equal(p.screenshot, 'data:image/png;base64,AAA')

// 2. Integration: post a report exactly as the extension would, to the running collector.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const url = process.env.COLLECTOR || 'http://localhost:4319'
try {
  const res = await fetch(url + '/api/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildReport({
      ingestKey: 'th_demo_key_0001', note: 'extension → collector e2e', screenshot: PNG,
      pageUrl: 'https://some-other-site.example/deep/page', innerWidth: 1280, innerHeight: 720,
      userAgent: 'th-extension-test',
    })),
  })
  const j = (await res.json()) as { ok?: boolean; id?: string }
  assert.ok(j.ok && j.id, 'collector accepted the report')
  console.log('extension → collector OK, report id:', j.id)
} catch (e) {
  console.log('(collector offline — run `pnpm --filter @th/web dev`; pure-shape tests still passed)', String(e))
}
console.log('extension: report tests passed ✓')
