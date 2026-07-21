import crypto from 'node:crypto'
import { cookies } from 'next/headers'

// Dashboard auth: a single shared password (env DASH_PASSWORD) guards the human-facing views + the PATCH
// status endpoint. We don't store sessions — the signed cookie IS the proof of knowing the password. The
// cookie value is `v1.<issuedAt>.<hmac>` where hmac = HMAC-SHA256(DASH_PASSWORD, "v1.<issuedAt>"); an
// attacker can't forge it without the password, and tampering with issuedAt breaks the signature.
export const AUTH_COOKIE = 'th_auth'
const MAX_AGE_SEC = 60 * 60 * 24 * 30 // 30 days
const VERSION = 'v1'

function password(): string | null {
  const p = process.env.DASH_PASSWORD
  return p && p.length > 0 ? p : null
}

/** Whether a password gate is configured at all. When false, the dashboard is open (dev convenience). */
export function isAuthConfigured(): boolean {
  return password() !== null
}

let warned = false
function warnOpen(): void {
  if (warned) return
  warned = true
  console.warn('[auth] DASH_PASSWORD is not set — dashboard + PATCH are UNGATED. Set it for any shared/prod deploy.')
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

/** Constant-time check of a submitted password against DASH_PASSWORD. */
export function checkPassword(input: string): boolean {
  const p = password()
  if (!p) return false
  return timingSafeEqual(input, p)
}

function sign(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex')
}

/** Mint a fresh signed cookie value. Caller must have already verified the password. */
export function makeAuthCookieValue(): string {
  const p = password()
  if (!p) throw new Error('cannot mint auth cookie without DASH_PASSWORD')
  const payload = `${VERSION}.${Date.now()}`
  return `${payload}.${sign(payload, p)}`
}

/** Verify a cookie value: signature valid AND not older than MAX_AGE. */
export function verifyAuthCookie(value: string | undefined): boolean {
  const p = password()
  if (!p || !value) return false
  const i = value.lastIndexOf('.')
  if (i <= 0) return false
  const payload = value.slice(0, i)
  const sig = value.slice(i + 1)
  if (!timingSafeEqual(sig, sign(payload, p))) return false
  const parts = payload.split('.')
  if (parts[0] !== VERSION) return false
  const issued = Number(parts[1])
  if (!Number.isFinite(issued)) return false
  return Date.now() - issued <= MAX_AGE_SEC * 1000
}

/**
 * The gate used by server components / route handlers. Returns true when access is allowed:
 *  - no password configured → open (dev), logs a one-time warning
 *  - password configured → requires a valid th_auth cookie
 */
export async function isAuthed(): Promise<boolean> {
  if (!isAuthConfigured()) {
    warnOpen()
    return true
  }
  const jar = await cookies()
  return verifyAuthCookie(jar.get(AUTH_COOKIE)?.value)
}

export const cookieMaxAge = MAX_AGE_SEC
