// Digest composition against hand-built input. Pure — composeDigest takes a plain DigestInput, so no board and no
// database are involved. The assertions check that each section appears when it has rows, that an empty board reads
// as empty (so a scheduler can skip it), that the mode is stated, and that a person-written note cannot inject HTML.
//
// Run: npx tsx apps/web/lib/digest.test.ts
import assert from 'node:assert/strict'
import { composeDigest, type DigestInput, type DigestSection } from './digest.ts'

let passed = 0
function t(name: string, fn: () => void): void {
  fn()
  passed++
  void name
}

const NOW = 1_724_000_000_000

const sec = (over: Partial<DigestSection> = {}): DigestSection => ({
  shortId: 'ab12cd34',
  board: 'shop',
  note: 'корзина теряет позицию',
  reason: 'единственный живой исполнитель доски — передаю ему',
  suggested: 'shop-a',
  ...over,
})

const base = (over: Partial<DigestInput> = {}): DigestInput => ({
  now: NOW,
  autonomy: 'off',
  usedLlm: false,
  assigns: [],
  nudges: [],
  escalations: [],
  leaveCount: 0,
  truncated: false,
  ...over,
})

// ── empty board ──
t('an empty board composes as empty, in both bodies', () => {
  const d = composeDigest(base())
  assert.equal(d.empty, true)
  assert.match(d.subject, /разложена/)
  assert.match(d.text, /Нечего раздавать/)
  assert.match(d.html, /Нечего раздавать/)
})

// ── mode is always stated ──
t('the mode is stated: OFF says advisor, ON says autonomous', () => {
  assert.match(composeDigest(base({ autonomy: 'off' })).text, /советника/)
  assert.match(composeDigest(base({ autonomy: 'on' })).text, /ВКЛЮЧЁН/)
})

// ── sections appear with their rows ──
t('assigns / nudges / escalations each surface with a count', () => {
  const d = composeDigest(base({
    assigns: [sec({ shortId: 'aaa11111' })],
    nudges: [sec({ shortId: 'bbb22222', suggested: 'shop-a' })],
    escalations: [sec({ shortId: 'ccc33333', suggested: undefined })],
  }))
  assert.equal(d.empty, false)
  assert.match(d.text, /ПРЕДЛАГАЮ РАЗДАТЬ \(1\)/)
  assert.match(d.text, /ЗАСТРЯЛО, ПОДТОЛКНУТЬ \(1\)/)
  assert.match(d.text, /ТЕБЕ РЕШАТЬ \(1\)/)
  // The subject leads with the escalation count — the reason to open it.
  assert.match(d.subject, /1.вам решать/)
  // Each shortId shows up.
  for (const id of ['aaa11111', 'bbb22222', 'ccc33333']) assert.match(d.text, new RegExp(id))
})

// ── suggested agent shown where present, absent on escalations ──
t('a suggested agent is shown for assigns and absent for escalations', () => {
  const d = composeDigest(base({
    assigns: [sec({ shortId: 'aaa11111', suggested: 'shop-a' })],
    escalations: [sec({ shortId: 'ccc33333', suggested: undefined, note: '' })],
  }))
  assert.match(d.text, /→ shop-a/)
  // The escalation line carries no arrow (no addressee).
  const escLine = d.text.split('\n').find((l) => l.includes('ccc33333'))!
  assert.doesNotMatch(escLine, /→/)
})

// ── honesty flags ──
t('the no-LLM note appears only when something was escalated', () => {
  const withEsc = composeDigest(base({ escalations: [sec({ suggested: undefined })], usedLlm: false }))
  assert.match(withEsc.text, /LLM-помощник выключен/)
  const noEsc = composeDigest(base({ assigns: [sec()], usedLlm: false }))
  assert.doesNotMatch(noEsc.text, /LLM-помощник выключен/)
})

t('leaveCount and truncation are surfaced, not hidden', () => {
  const d = composeDigest(base({ assigns: [sec()], leaveCount: 7, truncated: true }))
  assert.match(d.text, /Ещё 7 оставлено доске/)
  assert.match(d.text, /ЧАСТИ доски/)
  assert.match(d.html, /по ЧАСТИ доски/)
})

// ── HTML safety ──
t('a note with markup is escaped in the HTML body', () => {
  const d = composeDigest(base({ assigns: [sec({ note: '<script>alert(1)</script> & "x"' })] }))
  assert.doesNotMatch(d.html, /<script>alert/)
  assert.match(d.html, /&lt;script&gt;/)
  assert.match(d.html, /&amp;/)
})

// ── long note is clipped ──
t('a long note is clipped with an ellipsis', () => {
  const long = 'ж'.repeat(400)
  const d = composeDigest(base({ assigns: [sec({ note: long })] }))
  assert.match(d.text, /…/)
  assert.ok(!d.text.includes(long), 'the full 400-char note is not carried verbatim')
})

console.log(`digest.test.ts: ${passed} passed`)
