// The autonomy gate against injected readers. resolveAutonomy takes its getMeta and env as parameters, so the whole
// truth table is checked with no database and no real process.env: the default is OFF, absence is OFF, garbage is
// OFF, and only an explicit "on" — env override winning over the stored row — is ON.
//
// Run: npx tsx packages/db/src/autonomy.test.ts
import assert from 'node:assert/strict'
import { resolveAutonomy, AUTONOMY_KEY, AUTONOMY_ON, AUTONOMY_ENV } from './autonomy.ts'

let passed = 0
function t(name: string, fn: () => void): void {
  fn()
  passed++
  void name
}

const store = (v: string | null) => (key: string) => (key === AUTONOMY_KEY ? v : null)
const noEnv: Record<string, string | undefined> = {}

// ── the hard default ──
t('nothing set anywhere => OFF', () => {
  assert.equal(resolveAutonomy(store(null), noEnv), 'off')
})

t('a garbage stored value => OFF (no silent on)', () => {
  assert.equal(resolveAutonomy(store('yes-please'), noEnv), 'off')
  assert.equal(resolveAutonomy(store(''), noEnv), 'off')
  assert.equal(resolveAutonomy(store('ON '), noEnv), 'off') // exact 'on' only for the stored row
})

// ── the stored row turns it on ──
t('stored row exactly "on" => ON', () => {
  assert.equal(resolveAutonomy(store(AUTONOMY_ON), noEnv), 'on')
})

// ── env override wins both ways ──
t('env override ON beats a stored off', () => {
  for (const v of ['on', '1', 'true', 'yes', 'ON', ' Yes ']) {
    assert.equal(resolveAutonomy(store(null), { [AUTONOMY_ENV]: v }), 'on', `env=${v}`)
  }
})

t('env override present-but-not-ON beats a stored ON (explicit ops OFF)', () => {
  assert.equal(resolveAutonomy(store(AUTONOMY_ON), { [AUTONOMY_ENV]: 'off' }), 'off')
  assert.equal(resolveAutonomy(store(AUTONOMY_ON), { [AUTONOMY_ENV]: '0' }), 'off')
})

t('a blank/whitespace env override is treated as unset, so the stored row decides', () => {
  assert.equal(resolveAutonomy(store(AUTONOMY_ON), { [AUTONOMY_ENV]: '   ' }), 'on')
  assert.equal(resolveAutonomy(store(null), { [AUTONOMY_ENV]: '' }), 'off')
})

console.log(`autonomy.test.ts: ${passed} passed`)
