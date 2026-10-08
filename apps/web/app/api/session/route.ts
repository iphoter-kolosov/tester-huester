import { NextResponse } from 'next/server'
import { AUTH_COOKIE, checkCredential, cookieMaxAge, isAuthConfigured, makeAuthCookieValue } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Sign in from a script and get back the SAME cookie the login form sets.
//
// It exists because /login is a server action: driving it from a script means forging Next's internal action id,
// which breaks on every build. So the door is the same one, not a second one — this handler and the login page
// call the identical three functions from lib/auth (checkPassword → makeAuthCookieValue → AUTH_COOKIE), so a
// password change or a cookie-format change moves both at once. There is no new secret and no new privilege:
// what you get is the dashboard cookie, and it is worth exactly what knowing DASH_PASSWORD is worth.
//
// The one caller today is scripts/add-agent.mjs, which reads the password from an environment variable so it
// never lands in shell history or in the process list.

/** The env var the script reads the password from — named in the refusals so the caller can fix it in one step. */
const SCRIPT_PASSWORD_ENV = 'TH_DASH_PASSWORD'

export async function POST(req: Request) {
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json(
      { ok: false, error: 'bad_json', message: 'Send a JSON body: {"password": "<the dashboard password>"}.' },
      { status: 400 },
    )
  }

  // An open board has no cookie to mint (makeAuthCookieValue would throw), and pretending to sign somebody in
  // would be a lie the caller only discovers at the next request. Say so instead: `authRequired:false` is the
  // answer a script needs to proceed without a cookie.
  if (!isAuthConfigured()) {
    return NextResponse.json({
      ok: true,
      authRequired: false,
      message: 'This collector has no DASH_PASSWORD set — the dashboard and its API are ungated, so no cookie is needed.',
    })
  }

  // {"code": …} — одноразовый код из приложения (DASH_TOTP_SECRET); та же дверь, что и пароль.
  const password = typeof body.password === 'string' ? body.password : typeof body.code === 'string' ? body.code : ''
  if (!password) {
    return NextResponse.json(
      {
        ok: false,
        error: 'password_required',
        message: `Send {"password": …} — the dashboard password (DASH_PASSWORD on the collector). Scripts should read it from ${SCRIPT_PASSWORD_ENV} rather than take it as an argument, so it stays out of shell history and the process list.`,
      },
      { status: 400 },
    )
  }
  if (!checkCredential(password)) {
    return NextResponse.json(
      {
        ok: false,
        error: 'bad_password',
        message: `Wrong dashboard password. It is DASH_PASSWORD on the collector; a script passes it in ${SCRIPT_PASSWORD_ENV}.`,
      },
      { status: 401 },
    )
  }

  const res = NextResponse.json({ ok: true, authRequired: true, cookie: AUTH_COOKIE, maxAge: cookieMaxAge })
  res.cookies.set(AUTH_COOKIE, makeAuthCookieValue(), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: cookieMaxAge,
    secure: process.env.NODE_ENV === 'production',
  })
  return res
}
