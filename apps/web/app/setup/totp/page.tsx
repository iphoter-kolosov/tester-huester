import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import QRCode from 'qrcode'
import { repo } from '@th/db'
import Shell from '@/components/shell/Shell'
import { isAuthed, TOTP_META_KEY } from '@/lib/auth'
import { generateSecret, matchStep, otpauthUri } from '@/lib/totp'

export const dynamic = 'force-dynamic'

// QR рисует библиотека из нашей же ссылки otpauth:// (секрет — только A–Z2–7), чужих данных в SVG нет.
// Вход по коду из приложения — настройка в один экран: QR → навести телефон → ввести код → готово.
// Новый секрет живёт в cookie черновика, пока владелец не подтвердил его кодом: неподтверждённый секрет не включает ничего
// и не ломает текущий вход. Подтверждённый — пишется в базу доски (переживает перезапуски) и сразу работает на /login.
const DRAFT_COOKIE = 'th_totp_draft'
const DRAFT_MAX_AGE = 15 * 60

async function confirm(formData: FormData) {
  'use server'
  if (!(await isAuthed())) redirect('/login')
  const jar = await cookies()
  const draft = jar.get(DRAFT_COOKIE)?.value ?? ''
  const code = String(formData.get('code') || '')
  if (!/^[A-Z2-7]{32}$/.test(draft) || matchStep(draft, code) === null) redirect('/setup/totp?e=1')
  repo.setMeta(TOTP_META_KEY, draft)
  jar.delete(DRAFT_COOKIE)
  redirect('/setup/totp?ok=1')
}

async function restart() {
  'use server'
  if (!(await isAuthed())) redirect('/login')
  ;(await cookies()).delete(DRAFT_COOKIE)
  redirect('/setup/totp?new=1')
}

export default async function TotpSetupPage({ searchParams }: { searchParams: Promise<{ e?: string; ok?: string; new?: string }> }) {
  if (!(await isAuthed())) redirect('/login')
  const { e, ok, new: fresh } = await searchParams
  // Включён — только подтверждённый здесь секрет; заведённый раньше через хаб (без подтверждения) не считается.
  const on = repo.getMeta(TOTP_META_KEY) !== null

  if (ok) {
    return (
      <Shell active="setup">
        <main className="wrap" style={{ maxWidth: 460 }}>
          <h1 className="h1">✅ Вход по коду включён</h1>
          <p>Теперь на странице входа вводите 6 цифр из приложения. Пароль продолжает работать для скриптов.</p>
          <p><a href="/">На доску</a></p>
        </main>
      </Shell>
    )
  }

  if (on && !fresh) {
    return (
      <Shell active="setup">
        <main className="wrap" style={{ maxWidth: 460 }}>
          <h1 className="h1">Вход по коду уже включён</h1>
          <p>Новый телефон или потеряли приложение — заведите код заново; старый перестанет подходить, как только подтвердите новый.</p>
          <form action={restart}><button type="submit" className="loginbtn">Завести заново</button></form>
        </main>
      </Shell>
    )
  }

  // Черновик: тот же секрет при перезагрузке страницы и при ошибке в коде — иначе QR менялся бы под уже сканированным.
  const jar = await cookies()
  let draft = jar.get(DRAFT_COOKIE)?.value ?? ''
  if (!/^[A-Z2-7]{32}$/.test(draft)) {
    draft = generateSecret()
    jar.set(DRAFT_COOKIE, draft, { httpOnly: true, sameSite: 'lax', path: '/setup/totp', maxAge: DRAFT_MAX_AGE, secure: process.env.NODE_ENV === 'production' })
  }
  const uri = otpauthUri('tester-huester', 'qa.ihor.work', draft)
  const svg = await QRCode.toString(uri, { type: 'svg', margin: 1, width: 240 })

  return (
    <Shell active="setup">
      <main className="wrap" style={{ maxWidth: 460 }}>
        <h1 className="h1">Вход по коду из приложения</h1>
        <ol>
          <li>Откройте приложение-аутентификатор на телефоне (Google Authenticator, Aegis, 1Password) → «+» → «Сканировать QR».</li>
          <li>Наведите на код ниже.</li>
          <li>Введите 6 цифр, которые покажет приложение.</li>
        </ol>
        <div style={{ background: '#fff', padding: 12, borderRadius: 12, width: 264 }} dangerouslySetInnerHTML={{ __html: svg }} />
        <details style={{ marginTop: 8 }}>
          <summary>Не сканируется? Ввести вручную</summary>
          <p className="mono" style={{ wordBreak: 'break-all' }}>{draft}</p>
        </details>
        <form action={confirm} className="login" style={{ marginTop: 16 }}>
          <label className="loginlbl" htmlFor="code">Код из приложения</label>
          <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" autoFocus className="logininput" placeholder="123 456" />
          {e ? <div className="loginerr">Код не подошёл — введите следующий из приложения.</div> : null}
          <button type="submit" className="loginbtn">Включить</button>
        </form>
      </main>
    </Shell>
  )
}
