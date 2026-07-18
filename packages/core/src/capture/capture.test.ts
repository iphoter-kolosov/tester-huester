import assert from 'node:assert/strict'
import { Ring } from './ring'
import { maskInputValue, scrubTokens, redactUrl, redactHeaders, isSensitiveField, MASK } from './redact'
import { bestSelector } from './selector'
import { formatArgs, patchConsole } from './console-buffer'
import { wrapFetchXhr } from './network-buffer'
import { toStep } from './actions'
import { assembleBundle, reproSteps, CAPS } from './bundle'
import type { ConsoleEntry, NetworkEntry, ActionStep, ActionEventLike } from './index'

// ---- off-DOM fake element (finder() throws off-DOM → selector falls back to CSS, candidates still read) ----
function fakeEl(tag: string, attrs: Record<string, string> = {}, opts: { text?: string; value?: string } = {}): any {
  return {
    tagName: tag.toUpperCase(),
    getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
    hasAttribute: (k: string) => k in attrs,
    textContent: opts.text ?? '',
    value: opts.value,
    type: attrs.type,
  }
}
const fixedNow = () => 1_000

// ---- 1. Ring is a bounded FIFO ----
{
  const r = new Ring<number>(3)
  for (let i = 1; i <= 5; i++) r.push(i)
  assert.deepEqual(r.all(), [3, 4, 5], 'ring keeps last N')
  assert.equal(r.size, 3)
  r.clear()
  assert.equal(r.size, 0)
}

// ---- 2. redaction ----
{
  const pass = fakeEl('input', { type: 'password', name: 'pw' })
  assert.equal(maskInputValue(pass, 'hunter2'), MASK, 'password masked')
  assert.ok(isSensitiveField(fakeEl('input', { name: 'apiKey' })), 'name heuristic')
  assert.ok(isSensitiveField(fakeEl('input', { autocomplete: 'cc-number' })), 'autocomplete heuristic')
  const email = fakeEl('input', { type: 'email', name: 'email' })
  assert.equal(maskInputValue(email, 'a@b.com'), 'a@b.com', 'ordinary value passes through')
  assert.equal(scrubTokens('token eyJabcdefghij12345 end'), `token ${MASK} end`, 'jwt-like scrubbed')
  assert.equal(scrubTokens('Bearer abcdef1234567890 x'), `${MASK} x`, 'bearer scrubbed')
  assert.match(redactUrl('https://x.io/p?token=abc&q=1'), /token=%E2%80%A2/, 'sensitive query masked')
  assert.equal(redactHeaders({ Authorization: 'Bearer x', 'X-Ok': 'v' }).Authorization, MASK, 'auth header masked')
  assert.equal(redactHeaders({ Authorization: 'Bearer x', 'X-Ok': 'v' })['X-Ok'], 'v', 'benign header kept')
}

// ---- 3. selector candidates ----
{
  const btn = fakeEl('button', { 'data-testid': 'save', role: '' }, { text: 'Save changes' })
  const sel = bestSelector(btn)
  assert.equal(typeof sel.css, 'string')
  assert.ok(sel.css.length > 0, 'css present (finder or fallback)')
  assert.equal(sel.role, 'button', 'implicit role for <button>')
  assert.equal(sel.text, 'Save changes')
  assert.equal(sel.testid, 'save')
  const link = fakeEl('a', { href: '/x', 'aria-label': 'Home' })
  const ls = bestSelector(link)
  assert.equal(ls.role, 'link')
  assert.equal(ls.name, 'Home', 'aria-label wins as accessible name')
}

// ---- 4. console formatting + patch tees into ring ----
{
  assert.equal(formatArgs(['a', 1, true]), 'a 1 true')
  assert.equal(formatArgs([{ x: 1 }]), '{"x":1}')
  const circ: any = {}
  circ.self = circ
  assert.ok(formatArgs([circ]).includes('[Circular]'), 'circular handled')
  assert.ok(formatArgs(['leak sk-abcdefghij0123456789']).includes(MASK), 'token scrubbed in console')

  const ring = new Ring<ConsoleEntry>(10)
  const fake: any = {}
  let realCalls = 0
  for (const l of ['log', 'info', 'warn', 'error', 'debug']) fake[l] = () => { realCalls++ }
  const unpatch = patchConsole(ring, fake, undefined, fixedNow)
  fake.log('hello', 42)
  fake.error('boom')
  assert.equal(ring.size, 2, 'console teed into ring')
  assert.equal(ring.all()[0].text, 'hello 42')
  assert.equal(ring.all()[1].level, 'error')
  assert.equal(realCalls, 2, 'original console still called')
  unpatch()
  fake.log('after')
  assert.equal(ring.size, 2, 'unpatch stops capture')
}

// ---- 5. network fetch wrap records status + timing + masks url ----
{
  const ring = new Ring<NetworkEntry>(10)
  let t = 100
  const now = () => (t += 5)
  const win: any = { fetch: async (_i: any, _init: any) => ({ status: 204 }) }
  const unwrap = wrapFetchXhr(ring, win, now)
  await win.fetch('https://api.x/thing?token=zzz', { method: 'POST' })
  assert.equal(ring.size, 1, 'fetch recorded')
  const e = ring.all()[0]
  assert.equal(e.method, 'POST')
  assert.equal(e.status, 204)
  assert.equal(e.kind, 'fetch')
  assert.ok(!e.url.includes('zzz'), 'token value stripped from query')
  assert.ok(e.ms >= 0, 'timing captured')
  // failure path
  const win2: any = { fetch: async () => { throw new Error('offline') } }
  const ring2 = new Ring<NetworkEntry>(10)
  const unwrap2 = wrapFetchXhr(ring2, win2, () => 0)
  await assert.rejects(() => win2.fetch('https://api.x/fail'), /offline/)
  assert.equal(ring2.all()[0].status, 0, 'failed fetch => status 0')
  assert.ok(ring2.all()[0].error?.includes('offline'))
  unwrap()
  unwrap2()
}

// ---- 6. action trail: event => step ----
{
  const click = toStep({ type: 'click', target: fakeEl('button', {}, { text: 'Buy' }) } as ActionEventLike, 'https://x/p', fixedNow)!
  assert.equal(click.type, 'click')
  assert.equal(click.selector.text, 'Buy')
  const typed = toStep({ type: 'input', target: fakeEl('input', { type: 'password', name: 'pw' }, { value: 'secret' }) } as ActionEventLike, 'https://x', fixedNow)!
  assert.equal(typed.type, 'input')
  assert.equal(typed.value, MASK, 'typed secret masked in trail')
  const enter = toStep({ type: 'keydown', target: fakeEl('input', {}), key: 'Enter' } as ActionEventLike, 'https://x', fixedNow)!
  assert.equal(enter.type, 'key')
  assert.equal(enter.key, 'Enter')
  assert.equal(toStep({ type: 'keydown', target: fakeEl('input', {}), key: 'a' } as ActionEventLike, 'https://x', fixedNow), null, 'boring keys ignored')
  assert.equal(toStep({ type: 'mousemove', target: fakeEl('div') } as ActionEventLike, 'https://x', fixedNow), null, 'unknown events ignored')
}

// ---- 7. bundle assembly + caps + repro steps ----
{
  const consoleArr: ConsoleEntry[] = Array.from({ length: 150 }, (_, i) => ({ level: 'log', text: `l${i}`, ts: i }))
  const actions: ActionStep[] = [
    { type: 'click', selector: { css: 'button', role: 'button', name: 'Login' }, url: 'https://x', ts: 1 },
    { type: 'input', selector: { css: '#email', role: 'textbox', name: 'Email' }, value: 'a@b.com', url: 'https://x', ts: 2 },
    { type: 'key', selector: { css: '#email' }, key: 'Enter', url: 'https://x', ts: 3 },
  ]
  const bundle = assembleBundle({
    env: { url: 'https://x', userAgent: 'UA', viewport: '800x600', dpr: 2 },
    console: consoleArr,
    actions,
    now: fixedNow,
  })
  assert.equal(bundle.console.length, CAPS.console, 'console capped')
  assert.equal(bundle.console[0].text, `l${150 - CAPS.console}`, 'kept the most recent console')
  assert.equal(bundle.network.length, 0)
  assert.equal(bundle.capturedAt, 1000)
  const steps = reproSteps(bundle)
  assert.equal(steps[0], '1. Click button "Login"')
  assert.ok(steps[1].startsWith('2. Type "a@b.com" into textbox "Email"'))
  assert.equal(steps[2], '3. Press Enter on "#email"')
}

console.log('core: all capture tests passed ✓')
