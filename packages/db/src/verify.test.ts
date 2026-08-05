// Contract tests for the "closing a ticket requires evidence" rule. Two of these exist because an adversarial
// review found the defects: an over-long URL used to be silently truncated (storing a broken link as the very
// artefact the contract guarantees), and the local MCP's scope sentinel had a NUL byte in it that made three
// guards unreachable.
import assert from 'node:assert/strict'
import { checkAgentStatusClaim, normalizeVerifyUrl, normalizeSteps, MAX_URL_LEN } from './verify.ts'

let passed = 0
function t(name: string, fn: () => void) {
  fn()
  passed++
  void name
}

// ── normalizeVerifyUrl ────────────────────────────────────────────────────────────────────────────────────
t('accepts an absolute https link', () => {
  assert.equal(normalizeVerifyUrl('https://erental.ihor.work/staff/orders'), 'https://erental.ihor.work/staff/orders')
})
t('accepts http', () => {
  assert.equal(normalizeVerifyUrl('http://localhost:3000/x'), 'http://localhost:3000/x')
})
t('rejects a relative path — it must work when pasted anywhere', () => {
  assert.equal(normalizeVerifyUrl('/staff/orders'), null)
})
t('rejects dangerous schemes — this becomes an <a href> in the owner dashboard', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'vbscript:msgbox', 'file:///etc/passwd', 'ftp://h/x']) {
    assert.equal(normalizeVerifyUrl(bad), null, bad)
  }
})
t('rejects an over-long URL instead of truncating it', () => {
  const long = 'https://app.example.com/orders/5605?token=' + 'a'.repeat(MAX_URL_LEN) + '&view=timeline'
  assert.ok(long.length > MAX_URL_LEN)
  assert.equal(normalizeVerifyUrl(long), null) // a cut link still parses and still renders — that is the danger
})
t('accepts a URL exactly at the limit', () => {
  const base = 'https://e.com/?q='
  const url = base + 'a'.repeat(MAX_URL_LEN - base.length)
  assert.equal(url.length, MAX_URL_LEN)
  assert.equal(normalizeVerifyUrl(url), url)
})
t('non-strings and blanks are null', () => {
  for (const v of [undefined, null, 42, {}, '', '   ']) assert.equal(normalizeVerifyUrl(v), null)
})

// ── normalizeSteps ────────────────────────────────────────────────────────────────────────────────────────
t('keeps non-empty steps, drops blanks, caps the count', () => {
  assert.deepEqual(normalizeSteps(['a', '  ', 'b']), ['a', 'b'])
  assert.equal(normalizeSteps(Array(30).fill('x'))!.length, 12)
  assert.equal(normalizeSteps([]), null)
  assert.equal(normalizeSteps('not an array'), null)
})

// ── the status contract ───────────────────────────────────────────────────────────────────────────────────
const PAGE = 'https://erental.ihor.work/staff/orders'

t('fixed with nothing → comment required', () => {
  const r = checkAgentStatusClaim('fixed', {}, PAGE)
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.err.error, 'comment_required')
})
t('fixed with a comment but no link → verify_url_required, quoting the ticket page', () => {
  const r = checkAgentStatusClaim('fixed', { comment: 'done' }, PAGE)
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.err.error, 'verify_url_required')
  assert.ok(r.ok === false && r.err.message.includes(PAGE), 'the error should hand the agent a concrete link')
})
t('fixed with a REJECTED link → says the link was bad, not that it was missing', () => {
  const r = checkAgentStatusClaim('fixed', { comment: 'done', verifyUrl: 'javascript:alert(1)' }, PAGE)
  assert.equal(r.ok, false)
  // Distinct error: otherwise the agent resends the same broken value forever.
  assert.equal(r.ok === false && r.err.error, 'verify_url_invalid')
})
t('fixed with an over-long link → explains the limit rather than silently cutting', () => {
  const long = 'https://e.com/?t=' + 'a'.repeat(MAX_URL_LEN)
  const r = checkAgentStatusClaim('fixed', { comment: 'done', verifyUrl: long }, PAGE)
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.err.error, 'verify_url_invalid')
  assert.ok(r.ok === false && r.err.message.includes(String(MAX_URL_LEN)))
})
t('fixed done properly → passes and carries the claim', () => {
  const r = checkAgentStatusClaim('fixed', { comment: 'fixed in a1b2c3d', verifyUrl: PAGE, verifySteps: ['open', 'hover'] }, PAGE)
  assert.equal(r.ok, true)
  assert.equal(r.ok === true && r.claim?.verifyUrl, PAGE)
  assert.deepEqual(r.ok === true && r.claim?.verifySteps, ['open', 'hover'])
})
t('wontfix needs a reason but no link', () => {
  assert.equal(checkAgentStatusClaim('wontfix', {}, PAGE).ok, false)
  assert.equal(checkAgentStatusClaim('wontfix', { comment: 'by design' }, PAGE).ok, true)
})
t('triaged/new require nothing — picking a ticket up is not a claim', () => {
  for (const s of ['triaged', 'new']) {
    const r = checkAgentStatusClaim(s, {}, PAGE)
    assert.equal(r.ok, true, s)
    assert.equal(r.ok === true && r.claim, null)
  }
})
t('a ticket with no pageUrl still gets a usable message', () => {
  const r = checkAgentStatusClaim('fixed', { comment: 'done' }, null)
  assert.equal(r.ok, false)
  assert.ok(r.ok === false && r.err.message.includes('verifyUrl'))
})

console.log(`db/verify: all ${passed} tests passed ✓`)
