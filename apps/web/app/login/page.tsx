import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { AUTH_COOKIE, checkCredential, cookieMaxAge, isAuthConfigured, isAuthed, isTotpConfigured, makeAuthCookieValue } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// Server action: validate the password, mint a signed cookie, land on the dashboard. Wrong password bounces
// back with ?e=1. Kept as an inline action so there's no extra client bundle.
async function login(formData: FormData) {
  'use server'
  const pw = String(formData.get('password') || '')
  if (!checkCredential(pw)) {
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
  const totp = isTotpConfigured()
  return (
    <main className="wrap" style={{ maxWidth: 380 }}>
      <div className="h" style={{ marginTop: 40 }}>
        <span className="h1">🔒 tester-huester</span>
      </div>
      <form action={login} className="login">
        <label className="loginlbl" htmlFor="password">{totp ? 'Код из приложения' : 'Пароль'}</label>
        <input
          id="password"
          name="password"
          type={totp ? 'text' : 'password'}
          inputMode={totp ? 'numeric' : undefined}
          autoFocus
          autoComplete={totp ? 'one-time-code' : 'current-password'}
          className="logininput"
          placeholder={totp ? '123 456' : '••••••••'}
        />
        {e ? <div className="loginerr">{totp ? 'Код не подошёл — проверьте время в телефоне и попробуйте следующий.' : 'Неверный пароль.'}</div> : null}
        <button type="submit" className="loginbtn">Войти</button>
      </form>
      <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 16 }}>
        Агентам и расширению вход не нужен — паролем закрыта только панель.
      </p>
    </main>
  )
}
