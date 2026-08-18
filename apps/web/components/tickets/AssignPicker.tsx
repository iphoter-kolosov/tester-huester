'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import AgentChip from '@/components/ui/AgentChip'
import { ROUTE_AGENTS } from '@/components/shell/nav'
import { cx } from '@/lib/cx'
import { patchReport } from './patch'
import s from './controls.module.css'

// «Кому это можно отдать и кто возьмёт» — вопрос, ради которого экран и переделывался: владелец говорил, что
// не понимает, может ли передать тикет и кто его подхватит. Поэтому передача живёт ПРЯМО В СТРОКЕ доски и в
// шапке тикета, а не на отдельной странице состава, и в списке видно то, по чему решение принимается: имя,
// роль и отвечал ли этот агент сегодня.
//
// Предлагаются только действующие агенты: сервер всё равно откажет по неактивному (assignee_inactive), а
// орган управления, предлагающий заведомо отвергаемый выбор, — это ловушка. Выведенные из состава названы
// отдельной строкой, чтобы «его тут нет» не читалось как «он куда-то делся».

export type AssignableAgent = {
  handle: string
  title: string
  role: string
  active: boolean
  lastSeen: number
}

export type AssignPickerProps = {
  id: string
  /** Текущий адресат — канонический handle или null. */
  assignee: string | null
  roster: readonly AssignableAgent[]
  /** Текущий адресат есть в тикетах, но его нет в составе: имя, а не агент. */
  assigneeUnknown?: boolean
}

const NOBODY = 'не адресован'

export default function AssignPicker({ id, assignee, roster, assigneeUnknown = false }: AssignPickerProps) {
  const router = useRouter()
  const [open, setOpen] = useState<boolean>(false)
  const [busy, setBusy] = useState<boolean>(false)
  const [err, setErr] = useState<string>('')

  // Esc закрывает список — тот же жест, что закрывает любое всплывающее окно панели.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const hand = async (to: string | null): Promise<void> => {
    setBusy(true)
    setErr('')
    const out = await patchReport(id, { assignee: to })
    setBusy(false)
    if (!out.ok) {
      setErr(out.message)
      return
    }
    setOpen(false)
    router.refresh()
  }

  const active = roster.filter((a) => a.active)
  const retired = roster.filter((a) => !a.active)
  const current = roster.find((a) => a.handle === assignee) ?? null

  return (
    <div className={cx(s.assign, open && s.assign_open)}>
      <button
        type="button"
        className={cx(s.assignbtn, !assignee && s.assignbtn_empty)}
        disabled={busy}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={assignee ? `Адресован: ${assignee}. Нажмите, чтобы передать другому` : 'Тикет никому не адресован — нажмите, чтобы передать'}
        onClick={() => setOpen((v) => !v)}
      >
        {assignee ? (
          // Без имени: в колонке шириной в полтора слова оно вытесняет сам handle. Имя и роль читаются в
          // списке ниже и в подсказке — то есть ровно там, где по ним принимают решение.
          <span className={s.assignwho}>
            <AgentChip
              plain
              handle={assignee}
              lastSeen={current ? current.lastSeen : null}
              retired={!!current && !current.active}
              unknown={assigneeUnknown}
            />
          </span>
        ) : (
          NOBODY
        )}
        <span className={s.assigncaret}>▼</span>
      </button>

      {open ? (
        <>
          <div className={s.veil} onClick={() => setOpen(false)} />
          <div className={s.pop} role="dialog" aria-label="Кому передать тикет">
            <div className={s.popttl}>Кому передать</div>

            {active.length === 0 ? (
              <p className={s.popempty}>
                В составе нет ни одного действующего агента — передавать некому. Подключите агента, и он появится здесь.
              </p>
            ) : (
              active.map((a) => (
                <button
                  key={a.handle}
                  type="button"
                  className={cx(s.popopt, a.handle === assignee && s.popopt_on)}
                  disabled={busy}
                  onClick={() => hand(a.handle)}
                >
                  <AgentChip plain handle={a.handle} title={a.title} lastSeen={a.lastSeen} />
                  <span className={cx(s.optrole, !a.role && s.optrole_none)}>
                    {a.role || 'роль не заявлена — сам передать работу дальше он не сможет'}
                  </span>
                </button>
              ))
            )}

            {retired.length ? (
              <p className={s.popoff}>
                Вне службы, работу не принимают: {retired.map((a) => a.handle).join(', ')}
              </p>
            ) : null}

            <div className={s.popsep} />
            <div className={s.popfoot}>
              {assignee ? (
                <button type="button" className={s.popclear} disabled={busy} onClick={() => hand(null)}>
                  снять адресата
                </button>
              ) : null}
              <Link className={s.poplink} href={ROUTE_AGENTS}>
                состав →
              </Link>
            </div>

            {err ? <div className={s.err}>{err}</div> : null}
          </div>
        </>
      ) : null}
    </div>
  )
}
