import crypto from 'node:crypto'

// Одноразовые коды из приложения-аутентификатора (RFC 6238, SHA-1, 6 цифр, шаг 30 с) — без зависимостей: алгоритм
// умещается в экран, а ещё один пакет в образе панели — ещё одна точка отказа при сборке на hermes.
// Секрет — base32 без дополнения, как его понимают Google Authenticator, Aegis, 1Password и прочие.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const STEP_SEC = 30
const DIGITS = 6
/** Сколько шагов в каждую сторону принимаем: ±1 покрывает расхождение часов до 30 с, больше — лишняя щель. */
const WINDOW = 1
const SECRET_BYTES = 20

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '')
  const bytes: number[] = []
  let bits = 0
  let value = 0
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

export function generateSecret(): string {
  return base32Encode(crypto.randomBytes(SECRET_BYTES))
}

export function hotp(secret: string, counter: number): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest()
  const offset = h[h.length - 1]! & 0x0f
  const code = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!
  return String(code % 10 ** DIGITS).padStart(DIGITS, '0')
}

export const stepAt = (nowMs: number): number => Math.floor(nowMs / 1000 / STEP_SEC)

/**
 * Какому шагу соответствует код, или null, если ни одному в окне. Шаг нужен вызывающему, чтобы не принять тот же код
 * дважды (повтор перехваченного кода в те же 30 с).
 */
export function matchStep(secret: string, code: string, nowMs = Date.now()): number | null {
  const want = code.replace(/\s+/g, '')
  if (!/^\d{6}$/.test(want)) return null
  const now = stepAt(nowMs)
  for (let d = -WINDOW; d <= WINDOW; d++) {
    const step = now + d
    const a = Buffer.from(hotp(secret, step))
    const b = Buffer.from(want)
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return step
  }
  return null
}

/** Ссылка для приложения: её же кодируют в QR; ввести руками можно сам секрет. */
export function otpauthUri(issuer: string, account: string, secret: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SEC}`
}
