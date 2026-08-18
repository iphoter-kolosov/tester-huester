'use client'
import { useState, type KeyboardEvent } from 'react'
import type { ChangeEvent } from 'react'
import { useRouter } from 'next/navigation'
import Button from '@/components/ui/Button'
import { cx } from '@/lib/cx'
import s from '@/app/agents/roster.module.css'

/**
 * The owner's half of a roster entry: what we call this agent and what it is FOR.
 *
 * An agent registers itself by acting, so most entries arrive with a handle and nothing else — and the owner is
 * the only one who knows what each one is meant to do. A role nobody can correct is a role that rots, and every
 * other agent reads it before addressing work, so the correction has to live where the roster is read.
 *
 * The two fields ARE the card's heading and its sentence, not a form bolted underneath: the roster has to read
 * like a page of descriptions, and a page that also happens to be editable beats a page of input boxes.
 *
 * The limits come in as props: they are decided in @th/db, and a client component cannot import from there
 * without dragging node:sqlite into the browser bundle (see status.ts for the same constraint).
 */

const NAME_PLACEHOLDER = 'Без имени — впишите, как называете его в разговоре'
const ROLE_PLACEHOLDER = 'Что делает и за что отвечает — это читают перед тем, как отдать сюда работу'

// Поле роли растёт под текст, а не прокручивается: роль длиной до 600 знаков (предел ядра) обязана быть
// видна целиком, иначе её никто не перечитывает и она тихо устаревает. Числа — под ширину --measure.
const ROLE_CHARS_PER_ROW = 88
const ROLE_MIN_ROWS = 2
const ROLE_MAX_ROWS = 8

export default function AgentEditor({
  handle,
  title,
  role,
  active,
  maxTitle,
  maxRole,
}: {
  handle: string
  title: string
  role: string
  active: boolean
  maxTitle: number
  maxRole: number
}) {
  const router = useRouter()
  const [t, setT] = useState<string>(title)
  const [r, setR] = useState<string>(role)
  const [busy, setBusy] = useState<boolean>(false)
  const [err, setErr] = useState<string>('')
  const [saved, setSaved] = useState<boolean>(false)
  // Props come back changed after the refresh, so a saved edit stops being dirty without any local bookkeeping.
  const dirty = t !== title || r !== role

  // A refusal is shown in the server's own words: it names what is wrong and what to do about it.
  const patch = async (body: Record<string, unknown>): Promise<void> => {
    setBusy(true)
    setErr('')
    setSaved(false)
    try {
      const res = await fetch('/api/agents', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle, ...body }),
      })
      const data = (await res.json().catch(() => null)) as { message?: string; error?: string } | null
      if (!res.ok) {
        setErr(data?.message || data?.error || `Сервер ответил ${res.status}`)
        return
      }
      setSaved(true)
      router.refresh()
    } catch (e) {
      setErr(`Запрос не ушёл: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const save = (): Promise<void> | void => (dirty && !busy ? patch({ title: t, role: r }) : undefined)

  // Retiring is not deleting: the entry stays readable, so old threads still explain who that voice was — it just
  // stops being offered as somebody you can hand work to.
  const toggleActive = (): Promise<void> => {
    if (active && !confirm(`Отправить «${title || handle}» в отставку? Тикеты ему больше не адресуются, записи остаются.`)) {
      return Promise.resolve()
    }
    return patch({ active: !active })
  }

  // Enter — сохранить, и в поле роли тоже: ядро всё равно вырезает переводы строк, так что перевод строки
  // здесь был бы обещанием формы, которого хранилище не держит.
  const onEnter = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      save()
    }
  }

  const onRole = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    setR(e.target.value)
    setSaved(false)
  }

  // Подсказка в покое проявляется только под курсором (см. .edhint_idle): на семи карточках подряд она была
  // семью одинаковыми строчками, то есть шумом, а нужна ровно в тот момент, когда рука уже над карточкой.
  const idle = !dirty && !saved
  const hint = saved && !dirty ? 'Сохранено ✓' : dirty ? 'Не сохранено · Enter сохраняет' : 'Имя и роль правятся прямо здесь'

  return (
    <div className={s.ed}>
      <input
        className={cx(s.edin, s.edname)}
        value={t}
        maxLength={maxTitle}
        placeholder={NAME_PLACEHOLDER}
        aria-label={`Имя агента ${handle}`}
        disabled={busy}
        onChange={(e) => { setT(e.target.value); setSaved(false) }}
        onKeyDown={onEnter}
      />
      <span className={s.edlbl}>роль</span>
      {/* Переносится по ширине, но остаётся ОДНОЙ строкой: ядро вырезает переводы строк, а роль — то самое
          предложение, которое владелец читает, решая, чья это задача. Однострочное поле обрезало её на
          середине, и прочесть можно было только наведением — то есть нельзя. */}
      <textarea
        className={cx(s.edin, s.edrole)}
        value={r}
        rows={Math.min(ROLE_MAX_ROWS, Math.max(ROLE_MIN_ROWS, Math.ceil(r.length / ROLE_CHARS_PER_ROW)))}
        maxLength={maxRole}
        placeholder={ROLE_PLACEHOLDER}
        aria-label={`Роль агента ${handle}`}
        disabled={busy}
        onChange={onRole}
        onKeyDown={onEnter}
      />
      <div className={s.edfoot}>
        <span className={cx(s.edhint, idle && s.edhint_idle, dirty && s.edhint_dirty, saved && !dirty && s.edhint_saved)}>
          {hint}
        </span>
        {dirty ? (
          <Button variant="primary" size="sm" disabled={busy} onClick={save}>
            Сохранить
          </Button>
        ) : null}
        <Button variant="quiet" size="sm" disabled={busy} onClick={toggleActive}>
          {active ? 'В отставку' : 'Вернуть в строй'}
        </Button>
      </div>
      {err ? <div className={s.ederr}>{err}</div> : null}
    </div>
  )
}
