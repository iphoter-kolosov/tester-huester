'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * The owner's half of a roster entry: what we call this agent and what it is FOR.
 *
 * An agent registers itself by acting, so most entries arrive with a handle and nothing else — and the owner is
 * the only one who knows what each one is meant to do. A role nobody can correct is a role that rots, and every
 * other agent reads it before addressing work, so the correction has to live where the roster is read.
 *
 * The limits come in as props: they are decided in @th/db, and a client component cannot import from there
 * without dragging node:sqlite into the browser bundle (see status.ts for the same constraint).
 */
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

  const onEnter = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      save()
    }
  }

  return (
    <div className="aged">
      <input
        className="agedin agedname"
        value={t}
        maxLength={maxTitle}
        placeholder="Как называем в разговоре"
        disabled={busy}
        onChange={(e) => { setT(e.target.value); setSaved(false) }}
        onKeyDown={onEnter}
      />
      {/* One line, not a textarea: the core strips newlines because the roster renders one line per agent, and a
          box that accepts paragraphs would promise a shape the store does not keep. */}
      {/* A role longer than the field is clipped by the input, so the whole of it is on hover — the owner must be
          able to READ what is written there without clicking into it and scrolling. */}
      <input
        className="agedin agedrole"
        value={r}
        title={r}
        maxLength={maxRole}
        placeholder="Что делает и за что отвечает — это читают другие агенты перед тем, как адресовать работу"
        disabled={busy}
        onChange={(e) => { setR(e.target.value); setSaved(false) }}
        onKeyDown={onEnter}
      />
      <div className="agedfoot">
        <span className="agedhint">{saved && !dirty ? 'Сохранено ✓' : dirty ? 'Не сохранено · Enter' : ''}</span>
        <button className="agedbtn" disabled={!dirty || busy} onClick={save}>Сохранить</button>
        <button className="agedbtn agedretire" disabled={busy} onClick={toggleActive}>
          {active ? 'В отставку' : 'Вернуть в строй'}
        </button>
      </div>
      {err ? <div className="agederr">{err}</div> : null}
    </div>
  )
}
