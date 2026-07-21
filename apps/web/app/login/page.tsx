import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { AUTH_COOKIE, checkPassword, cookieMaxAge, isAuthConfigured, isAuthed, makeAuthCookieValue } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// Server action: validate the password, mint a signed cookie, land on the dashboard. Wrong password bounces
// back with ?e=1. Kept as an inline action so there's no extra client bundle.
async function login(formData: FormData) {
  'use server'
  const pw = String(formData.get('password') || '')
  if (!checkPassword(pw)) {
    redirect('/login?e=1')
  }
  const jar = await cookies()
  jar.set(AUTH_COOKIE, makeAuthCookieValue(), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: cookieMaxAge,
    secure: process.env.NODE_ENV === 'production',
  })
  redirect('/')
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  // No gate configured, or already signed in → nothing to log into.
  if (!isAuthConfigured() || (await isAuthed())) redirect('/')
  const { e } = await searchParams
  return (
    <main className="wrap" style={{ maxWidth: 380 }}>
      <div className="h" style={{ marginTop: 40 }}>
        <span className="h1">🔒 Dashboard</span>
      </div>
      <form action={login} className="login">
        <label className="loginlbl" htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoFocus
          autoComplete="current-password"
          className="logininput"
          placeholder="••••••••"
        />
        {e ? <div className="loginerr">Wrong password.</div> : null}
        <button type="submit" className="loginbtn">Sign in</button>
      </form>
      <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 16 }}>
        Agents and the extension don&apos;t need this — only the human dashboard is gated.
      </p>
    </main>
  )
}
