import { NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { resolveAutonomy } from '@th/db'
import { isAuthed } from '@/lib/auth'
import { collectManager, toDigestInput } from '@/lib/managerView'
import { composeDigest } from '@/lib/digest'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The digest as an endpoint — the "could be sent on a schedule" wiring, wired but NOT scheduled. A cron job (or a
// person) fetches this and hands the body to whatever transport carries it; composing the digest wakes no session,
// so this route is safe to call from an unattended context where the poke channel does not exist.
//
// AUTH — two ways in, because a browser and a cron authenticate differently:
//   • the owner's dashboard cookie (isAuthed), for reading it by hand;
//   • a shared secret in env TH_DIGEST_KEY, passed as ?key=, so a scheduled fetch can authenticate without a
//     browser session. If TH_DIGEST_KEY is unset, the key path is closed entirely (no empty-string bypass) and only
//     the cookie works — a scheduled fetch then simply gets 401 until the owner sets the secret on purpose.

/** The env secret a scheduled fetch presents. Unset => the key path is closed; only the owner cookie authenticates. */
const DIGEST_KEY_ENV = 'TH_DIGEST_KEY'

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

/** True only for a present, non-empty configured key that matches the presented one — constant-time, no bypass. */
function keyAuthorized(presented: string): boolean {
  const configured = process.env[DIGEST_KEY_ENV]
  if (!configured || configured.length === 0 || presented.length === 0) return false
  return timingSafeEqual(presented, configured)
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const key = url.searchParams.get('key') ?? ''
  const authorized = keyAuthorized(key) || (await isAuthed())
  if (!authorized) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const now = Date.now()
  const view = await collectManager(now)
  // The digest states the mode it was composed under, so a reader always knows whether the board is acting by itself.
  const digest = composeDigest(toDigestInput(view, resolveAutonomy(), now))

  const format = url.searchParams.get('format') ?? 'json'
  if (format === 'html') return new NextResponse(digest.html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  if (format === 'text') return new NextResponse(digest.text, { headers: { 'content-type': 'text/plain; charset=utf-8' } })
  return NextResponse.json({ ok: true, ...digest })
}
