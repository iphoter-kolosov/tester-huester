'use client'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import CountBadge from '@/components/ui/CountBadge'
import { STATUS_LABEL, STATUS_ORDER } from '@/components/status'
import { BOARD_VIEWS, VIEW_HINT, VIEW_LABEL, VIEW_REVIEW, asBoardView, type ViewCounts } from '@/components/boardViews'
import { cx } from '@/lib/cx'
import { TICKET_TYPES } from './vocab'
import s from './filterbar.module.css'

// Отбор доски. Всё применяется сразу, без кнопки «Применить»: орган переписывает адрес, серверный компонент
// пересчитывает список. Адрес — рабочий инструмент владельца (`?view=review&site=…` у него в закладках),
// поэтому состояние живёт в нём, а не во внутренней памяти экрана.
//
// Две полосы делают разное. Верхняя выбирает КУЧУ (вся доска, очередь на проверку, архив) — это не фильтр,
// это место, где стоишь. Нижняя — условия внутри кучи, одной строкой, и она вслух считает, сколько их
// включено: «доска пустая, потому что три условия» должно читаться, а не выясняться.

export type FilterOption = { value: string; label: string }

export type FilterBarProps = {
  sites: readonly FilterOption[]
  projects: readonly FilterOption[]
  /** Каждый handle, который на этой вкладке что-то поставил, держит или кому что-то адресовано. */
  agents: readonly FilterOption[]
  archivedCount: number
  views: ViewCounts
}

/** Условия отбора внутри кучи. `view`, `arch` и `sort` сюда не входят: это не условия, а место и порядок. */
const FILTER_KEYS = ['q', 'site', 'project', 'agent', 'type', 'status'] as const

/** Страница списка сбрасывается при любой смене отбора: «пусто» на пятой странице нового отбора — это ложь. */
const PAGE_KEY = 'page'

function plural(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'условие'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'условия'
  return 'условий'
}

export default function FilterBar({ sites, projects, agents, archivedCount, views }: FilterBarProps) {
  const router = useRouter()
  const sp = useSearchParams()
  // Переписываем адрес ТОЙ страницы, на которой стоим: зашитый «/» уводил бы доску на первый экран.
  const pathname = usePathname()

  const cur = (k: string): string => sp.get(k) || ''
  const arch = cur('arch') === '1'
  // Читаем через тот же гейт, что и страница: неизвестный ?view= показывает всё, и полоса обязана подсветить
  // «Всё», а не оставить ни одной горящей вкладки.
  const view = asBoardView(cur('view'))
  const oldFirst = cur('sort') === 'old'

  const go = (patch: Record<string, string>): void => {
    const p = new URLSearchParams(sp.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v) p.set(k, v)
      else p.delete(k)
    }
    p.delete(PAGE_KEY)
    router.push(p.toString() ? `${pathname}?${p}` : pathname)
  }

  const activeFilters = FILTER_KEYS.filter((k) => !!cur(k))
  const resetAll = (): void => go(Object.fromEntries([...FILTER_KEYS, 'view', 'sort'].map((k) => [k, ''])))

  // Handle, у которого на этой вкладке ничего нет, всё равно дописывается, когда он же и выбран: список,
  // читающий «Любой агент» при доске, срезанной до одного агента, — единственное, чего фильтр делать не должен.
  const pickedAgent = cur('agent')
  const agentOpts: readonly FilterOption[] =
    pickedAgent && !agents.some((a) => a.value === pickedAgent)
      ? [...agents, { value: pickedAgent, label: `${pickedAgent} (0)` }]
      : agents

  return (
    <div className={s.bar}>
      <div className={s.scopes}>
        <div className={s.tabs}>
          <button className={cx(s.tab, !view && s.tab_on)} onClick={() => go({ view: '' })} title="Все тикеты выбранной кучи">
            Всё
          </button>
          {BOARD_VIEWS.map((v) => (
            <button
              key={v}
              className={cx(s.tab, view === v && s.tab_on, v === VIEW_REVIEW && s.tab_review)}
              title={VIEW_HINT[v]}
              onClick={() => go({ view: v })}
            >
              {VIEW_LABEL[v]}
              {views[v] ? <CountBadge n={views[v]} tone={v === VIEW_REVIEW ? 'attention' : 'neutral'} /> : null}
            </button>
          ))}
        </div>

        <div className={cx(s.tabs, s.tabs_right)}>
          <button className={cx(s.tab, !arch && s.tab_on)} onClick={() => go({ arch: '' })} title="Тикеты на доске">
            Активные
          </button>
          <button className={cx(s.tab, arch && s.tab_on)} onClick={() => go({ arch: '1' })} title="Убранные с доски">
            Архив
            {archivedCount ? <CountBadge n={archivedCount} tone="quiet" /> : null}
          </button>
        </div>
      </div>

      <div className={s.filters}>
        {/* Поиск отправляется по Enter, а не по каждой букве: доска перезапрашивается с сервера, и мигать
            списком на каждом нажатии — худшее, что можно сделать с экраном, по которому ведут глазами. */}
        <form
          className={s.search}
          onSubmit={(e) => {
            e.preventDefault()
            go({ q: String(new FormData(e.currentTarget).get('q') ?? '').trim() })
          }}
        >
          <input
            key={cur('q')}
            name="q"
            className={s.searchin}
            defaultValue={cur('q')}
            placeholder="Поиск: заметка, #id, адрес, агент"
            aria-label="Поиск по тикетам"
            maxLength={120}
          />
        </form>

        <select
          className={cx(s.fc, cur('site') && s.fc_on)}
          value={cur('site')}
          aria-label="Сайт"
          onChange={(e) => go({ site: e.target.value })}
        >
          <option value="">Все сайты</option>
          {sites.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        {projects.length > 1 && (
          <select
            className={cx(s.fc, cur('project') && s.fc_on)}
            value={cur('project')}
            aria-label="Проект"
            onChange={(e) => go({ project: e.target.value })}
          >
            <option value="">Все проекты</option>
            {projects.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        )}

        {agentOpts.length > 0 && (
          <select
            className={cx(s.fc, pickedAgent && s.fc_on)}
            value={pickedAgent}
            aria-label="Агент"
            title="Чья это работа: поставил, адресовано ему или держит"
            onChange={(e) => go({ agent: e.target.value })}
          >
            <option value="">Любой агент</option>
            {agentOpts.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        )}

        <select
          className={cx(s.fc, cur('type') && s.fc_on)}
          value={cur('type')}
          aria-label="Тип"
          onChange={(e) => go({ type: e.target.value })}
        >
          <option value="">Любой тип</option>
          {TICKET_TYPES.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        <select
          className={cx(s.fc, cur('status') && s.fc_on)}
          value={cur('status')}
          aria-label="Статус"
          onChange={(e) => go({ status: e.target.value })}
        >
          <option value="">Любой статус</option>
          {STATUS_ORDER.map((st) => (
            <option key={st} value={st}>{STATUS_LABEL[st]}</option>
          ))}
        </select>

        <button
          className={s.sort}
          onClick={() => go({ sort: oldFirst ? '' : 'old' })}
          title="Порядок списка"
        >
          {oldFirst ? '↑ сначала старые' : '↓ сначала новые'}
        </button>

        {activeFilters.length || view || oldFirst ? (
          <span className={s.state}>
            {activeFilters.length ? (
              <span className={s.staten}>
                {activeFilters.length} {plural(activeFilters.length)}
              </span>
            ) : null}
            <button className={s.reset} onClick={resetAll}>
              сбросить
            </button>
          </span>
        ) : null}
      </div>
    </div>
  )
}
