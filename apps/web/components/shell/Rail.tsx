'use client'

import Link from 'next/link'
import CountBadge from '@/components/ui/CountBadge'
import { cx } from '@/lib/cx'
import { NAV, SETUP, ROUTE_CONNECT, type NavKey } from './nav'
import type { ShellCounts } from '@/lib/shellCounts'
import s from './Shell.module.css'

// Рельса — клиентская только ради одного: подсветить место, где ты сейчас. Счётчики приходят готовыми с
// сервера (см. lib/shellCounts), сюда не ходит ни один запрос.

export type RailProps = {
  active: NavKey
  counts: ShellCounts
}

function countOf(key: NavKey, c: ShellCounts): number | null {
  if (key === 'mine') return c.mine
  if (key === 'tickets') return c.tickets
  if (key === 'agents') return c.agentsLive
  return null
}

function countTitle(key: NavKey, c: ShellCounts): string {
  if (key === 'mine') return c.mine ? `${c.mine} ждут вашего слова` : 'Очередь пуста'
  if (key === 'tickets') return c.truncated ? `Показано ${c.tickets} — выборка упёрлась в потолок` : `${c.tickets} активных тикетов`
  if (key === 'agents') return `${c.agentsLive} на связи из ${c.agentsTotal}`
  return ''
}

export default function Rail({ active, counts }: RailProps) {
  return (
    <nav className={s.rail} aria-label="Разделы панели">
      <Link className={s.brand} href="/">
        <img className={s.brandmark} src="/logo.svg" alt="" width={24} height={24} />
        tester-huester
      </Link>

      <div className={s.group}>
        {NAV.map((item) => {
          const n = countOf(item.key, counts)
          // «Мой ход» светится только пока в очереди что-то есть: постоянно горящий пункт перестают видеть.
          const waiting = item.countTone === 'attention' && !!n
          return (
            <Link
              key={item.key}
              className={cx(s.item, active === item.key && s.on, waiting && s.waiting)}
              href={item.href}
              title={item.hint}
              aria-current={active === item.key ? 'page' : undefined}
            >
              <span className={s.label}>{item.label}</span>
              {n === null ? null : (
                <CountBadge n={n} tone={waiting ? 'attention' : 'neutral'} title={countTitle(item.key, counts)} />
              )}
            </Link>
          )
        })}
      </div>

      <div className={s.tail}>
        <span className={s.groupttl}>Настройка</span>
        <Link
          className={cx(s.item, s.quiet, active === SETUP.key && s.on)}
          href={SETUP.href}
          title={SETUP.hint}
          aria-current={active === SETUP.key ? 'page' : undefined}
        >
          <span className={s.label}>{SETUP.label}</span>
        </Link>
        <Link className={cx(s.item, s.quiet)} href={ROUTE_CONNECT} title="Команда подключения агента к этой доске">
          <span className={s.label}>Подключить агента</span>
        </Link>
        <p className={s.note}>Панель под одного человека — вас. Ключи и проекты лежат в «Настройке», а не на рабочем экране.</p>
      </div>
    </nav>
  )
}
