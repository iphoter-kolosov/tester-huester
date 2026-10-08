// Коды аутентификатора: base32, контрольные значения RFC 4226, окно ±1 шаг, формат otpauth-ссылки.
// Run: npx tsx apps/web/lib/totp.test.ts
import assert from 'node:assert/strict'
import { base32Decode, base32Encode, hotp, matchStep, otpauthUri, generateSecret, stepAt } from './totp.ts'

let passed = 0
function t(name: string, fn: () => void): void {
  fn()
  passed++
  console.log(`ok - ${name}`)
}

// Контрольный секрет RFC 4226 (приложение D): "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'))

t('base32 туда и обратно, без дополнения; мусор и регистр в ручном вводе не мешают', () => {
  assert.equal(RFC_SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
  assert.equal(base32Decode(RFC_SECRET).toString(), '12345678901234567890')
  assert.equal(base32Decode('gezd gnbv-gy3t').toString(), '1234567')
  assert.match(generateSecret(), /^[A-Z2-7]{32}$/)
})

t('hotp совпадает с контрольными значениями RFC 4226', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => hotp(RFC_SECRET, i)), ['755224', '287082', '359152', '969429', '338314'])
})

t('matchStep: текущий и соседние шаги проходят, два шага назад — нет; пробел внутри кода допустим, мусор — нет', () => {
  const now = 1_700_000_000_000
  const step = stepAt(now)
  assert.equal(matchStep(RFC_SECRET, hotp(RFC_SECRET, step), now), step)
  assert.equal(matchStep(RFC_SECRET, hotp(RFC_SECRET, step - 1), now), step - 1)
  assert.equal(matchStep(RFC_SECRET, hotp(RFC_SECRET, step + 1), now), step + 1)
  assert.equal(matchStep(RFC_SECRET, hotp(RFC_SECRET, step - 2), now), null)
  const c = hotp(RFC_SECRET, step)
  assert.equal(matchStep(RFC_SECRET, `${c.slice(0, 3)} ${c.slice(3)}`, now), step)
  assert.equal(matchStep(RFC_SECRET, '12345', now), null)
  assert.equal(matchStep(RFC_SECRET, 'abcdef', now), null)
})

t('otpauth-ссылка в формате, который понимают приложения', () => {
  assert.equal(
    otpauthUri('tester-huester', 'qa.ihor.work', 'ABC234'),
    'otpauth://totp/tester-huester%3Aqa.ihor.work?secret=ABC234&issuer=tester-huester&algorithm=SHA1&digits=6&period=30',
  )
})

console.log(`\n${passed} passed`)
