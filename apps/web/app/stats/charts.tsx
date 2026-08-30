import { statusLabel } from '@/components/status'
import { humanDur, type FlowBar, type StatusDwell, type ProjectFlow } from '@/lib/stats'
import s from './stats.module.css'

// Графики экрана «Статистика» — только встроенный SVG, без библиотек. Правило: столбик без шкалы врёт, поэтому
// у каждого графика подписана единица и назван максимум. Цвета — токенами (var(--accent) «заведено»,
// var(--verified) «принято»), чтобы график читался в той же палитре, что и остальная панель.

const FLOW_W = 720
const FLOW_H = 190
const FLOW_PAD_L = 34 // место под подпись оси Y
const FLOW_PAD_B = 20 // место под даты
const FLOW_PAD_T = 8

/** 'YYYY-MM-DD' → 'DD.MM' для подписи оси. */
function dm(day: string): string {
  const [, m, d] = day.split('-')
  return `${d}.${m}`
}

/** Непрерывный ряд из последних `days` UTC-дней — дни без активности ядро не отдаёт, а ось обязана быть сплошной. */
function fillDays(flow: FlowBar[], days: number): FlowBar[] {
  const have = new Map(flow.map((f) => [f.day, f]))
  const out: FlowBar[] = []
  const base = new Date()
  base.setUTCHours(0, 0, 0, 0)
  for (let i = days - 1; i >= 0; i--) {
    const x = new Date(base)
    x.setUTCDate(base.getUTCDate() - i)
    const key = x.toISOString().slice(0, 10)
    out.push(have.get(key) ?? { day: key, created: 0, verified: 0 })
  }
  return out
}

/** Поток во времени: заведено vs принято по дням. Сгруппированные столбики, подписанные оси и названный максимум. */
export function FlowChart({ flow, days }: { flow: FlowBar[]; days: number }) {
  const series = fillDays(flow, days)
  const max = Math.max(1, ...series.map((f) => Math.max(f.created, f.verified)))
  const plotW = FLOW_W - FLOW_PAD_L
  const plotH = FLOW_H - FLOW_PAD_B - FLOW_PAD_T
  const slot = plotW / series.length
  const barW = Math.max(1.5, Math.min(7, slot / 2 - 1))
  const y = (v: number) => FLOW_PAD_T + plotH - (v / max) * plotH
  // Три горизонтальные линии сетки: 0, середина, максимум — на них и висит «столько тикетов в день».
  const grid = [0, Math.round(max / 2), max].filter((v, i, a) => a.indexOf(v) === i)
  // Подписи дат: начало, середина, конец — иначе 30 подписей сливаются в кашу.
  const ticks = [0, Math.floor(series.length / 2), series.length - 1]

  return (
    <figure className={s.chart}>
      <figcaption className={s.chartcap}>
        <span className={s.chartunit}>тикетов в день</span>
        <span className={s.legend}>
          <span className={s.legkey}><i className={s.swatchCreated} /> заведено</span>
          <span className={s.legkey}><i className={s.swatchVerified} /> принято</span>
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${FLOW_W} ${FLOW_H}`} className={s.svg} role="img" preserveAspectRatio="none"
        aria-label={`Поток за ${days} дней: заведено и принято по дням, максимум ${max} в день`}>
        {grid.map((v) => (
          <g key={v}>
            <line x1={FLOW_PAD_L} x2={FLOW_W} y1={y(v)} y2={y(v)} className={s.gridline} />
            <text x={FLOW_PAD_L - 5} y={y(v) + 3} className={s.axisY}>{v}</text>
          </g>
        ))}
        {series.map((f, i) => {
          const cx = FLOW_PAD_L + i * slot + slot / 2
          return (
            <g key={f.day}>
              <rect x={cx - barW - 0.5} y={y(f.created)} width={barW} height={FLOW_PAD_T + plotH - y(f.created)}
                className={s.barCreated}>
                <title>{`${dm(f.day)} · заведено ${f.created}`}</title>
              </rect>
              <rect x={cx + 0.5} y={y(f.verified)} width={barW} height={FLOW_PAD_T + plotH - y(f.verified)}
                className={s.barVerified}>
                <title>{`${dm(f.day)} · принято ${f.verified}`}</title>
              </rect>
            </g>
          )
        })}
        {ticks.map((i) => {
          const bar = series[i]
          return bar ? (
            <text key={i} x={FLOW_PAD_L + i * slot + slot / 2} y={FLOW_H - 6} className={s.axisX}>{dm(bar.day)}</text>
          ) : null
        })}
      </svg>
    </figure>
  )
}

/** Среднее время в статусе: горизонтальные полосы, каждая подписана длительностью и числом переходов. */
export function StatusDwellBars({ dwell }: { dwell: StatusDwell[] }) {
  const max = Math.max(1, ...dwell.map((d) => d.avgMs))
  return (
    <ul className={s.hbars}>
      {dwell.map((d) => (
        <li className={s.hbar} key={d.status}>
          <span className={s.hbarlbl}>{statusLabel(d.status)}</span>
          <span className={s.hbartrack}>
            <span className={s.hbarfill} style={{ width: `${Math.max(2, (d.avgMs / max) * 100)}%` }} />
          </span>
          <span className={s.hbarval} title={`${d.intervals} завершённых переходов`}>
            {humanDur(d.avgMs)} <span className={s.hbarsub}>· {d.intervals}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

/** Разбивка потока по проектам: сколько заведено за окно, из скольких всего. */
export function ProjectBars({ rows, days }: { rows: ProjectFlow[]; days: number }) {
  const max = Math.max(1, ...rows.map((r) => r.filed))
  return (
    <ul className={s.hbars}>
      {rows.map((r) => (
        <li className={s.hbar} key={r.projectId}>
          <span className={s.hbarlbl} title={r.name}>{r.name}</span>
          <span className={s.hbartrack}>
            <span className={s.hbarfill} style={{ width: `${Math.max(2, (r.filed / max) * 100)}%` }} />
          </span>
          <span className={s.hbarval}>
            {r.filed} <span className={s.hbarsub}>за {days} дн · всего {r.total}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}
