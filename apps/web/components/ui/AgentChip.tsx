import Link from 'next/link'
import { LIVENESS_HINT, LIVENESS_LABEL, liveness, type Liveness } from '@/lib/liveness'
import { agoLong } from '@/lib/time'
import { cx } from '@/lib/cx'
import s from './ui.module.css'

// Один участник, нарисованный одинаково везде, где встречается handle. Без аватара: у агента нет лица,
// у него есть имя, роль и ответ на вопрос «отвечал ли он сегодня».
//
// Точка живости стоит здесь, а не только в составе, намеренно: «кому отдать» и «кто возьмёт» — один
// вопрос, и разносить его по двум страницам значит заставлять ходить между ними ради каждой передачи.

const DOT_CLASS: Record<Liveness, string | undefined> = {
  live: s.dot_live,
  quiet: s.dot_quiet,
  silent: s.dot_silent,
}

export type AgentChipProps = {
  handle: string
  /** Человеческое имя из состава. Пусто — покажется один handle. */
  title?: string | null
  /** Роль показывается по требованию: в плотной строке она съедает место, в карточке — объясняет, кто это. */
  role?: string | null
  showRole?: boolean
  /** Последний выход на связь. Не передан — точки живости нет (мы её просто не знаем). */
  lastSeen?: number | null
  /** Выведен из состава: записи остаются, работу больше не предлагаем. */
  retired?: boolean
  /** Handle, которого нет в составе: это имя на тикете, а не агент, и притворяться агентом не должно. */
  unknown?: boolean
  /** Без рамки — для мест, где чип стоит внутри готовой строки. */
  plain?: boolean
  href?: string
}

export default function AgentChip({
  handle,
  title,
  role,
  showRole = false,
  lastSeen,
  retired = false,
  unknown = false,
  plain = false,
  href,
}: AgentChipProps) {
  const live: Liveness | null = typeof lastSeen === 'number' ? liveness(lastSeen) : null
  const cls = cx(s.chip, plain && s.chip_plain, retired && s.chip_retired, unknown && s.chip_unknown)
  const hint = unknown
    ? 'Этого имени нет в составе — тикеты на него передавать некому'
    : live
      ? `${LIVENESS_HINT[live]} · ${agoLong(lastSeen!)}`
      : undefined

  const body = (
    <>
      {live ? <span className={cx(s.dot, DOT_CLASS[live])} title={LIVENESS_LABEL[live]} /> : null}
      <span className={s.chiphandle}>{handle}</span>
      {title ? <span className={s.chiptitle}>{title}</span> : null}
      {retired ? <span className={s.chipmark}>вне службы</span> : null}
      {unknown ? <span className={s.chipmark}>не в составе</span> : null}
      {showRole ? (
        <span className={cx(s.chiprole, !role && s.chiprole_none)}>
          {role || 'роль не заявлена'}
        </span>
      ) : null}
    </>
  )

  if (href) {
    return (
      <Link className={cls} href={href} title={hint}>
        {body}
      </Link>
    )
  }
  return (
    <span className={cls} title={hint}>
      {body}
    </span>
  )
}
