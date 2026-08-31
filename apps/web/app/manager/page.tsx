import Link from 'next/link'
import { redirect } from 'next/navigation'
import { repo, type AgentProfile, type Report } from '@th/db'
import Shell from '@/components/shell/Shell'
import CopyId from '@/components/CopyId'
import AgentChip from '@/components/ui/AgentChip'
import EmptyState from '@/components/ui/EmptyState'
import SectionHeader from '@/components/ui/SectionHeader'
import StatusPill from '@/components/ui/StatusPill'
import TicketRow from '@/components/ui/TicketRow'
import { ROUTE_TICKETS } from '@/components/shell/nav'
import { isAuthed } from '@/lib/auth'
import { LIVENESS_HINT, LIVENESS_LABEL, liveness } from '@/lib/liveness'
import { agoLong, exact } from '@/lib/time'
import { cx } from '@/lib/cx'
import { collectManager, type ManagerRow } from '@/lib/managerView'
import ConfirmAssign from './ConfirmAssign'
import NudgeButton, { type NudgeKind } from './NudgeButton'
import BulkAssign, { type BulkItem } from './BulkAssign'
import s from './manager.module.css'

export const dynamic = 'force-dynamic'

// МЕНЕДЖЕР — раскладка доски в РЕЖИМЕ СОВЕТНИКА: менеджер читает всю доску и кладёт «кому что», владелец
// смотрит и подтверждает. Это то, что позволяет перестать адресовать тикеты руками по одному.
//
// Три раздела и ровно они: «предлагаю раздать» (менеджер нашёл дом — один клик, и адресовано), «застряло,
// подтолкнуть» (напомнить, не будя сессию) и «тебе решать» (эскалации — единственное, что доходит до
// владельца; всё ясное менеджер уже разложил). Ничто не применяется без его подтверждения: автономный
// режим выключен, и об этом сказано в шапке.

/** Сколько строк показывает раздел, прежде чем отправить остального читать на доску. */
const SECTION_LIMIT = 40

export default async function Manager() {
  if (!(await isAuthed())) redirect('/login')

  const now = Date.now()
  const view = await collectManager(now)

  const projName = new Map(repo.listProjects().map((p) => [p.id, p.name] as const))
  const nameOf = (projectId: string): string => projName.get(projectId) ?? 'проект'

  // Первая строка тикета вокруг готовой строки: за что его хватать и откуда он.
  const meta = (r: Report) => (
    <>
      <CopyId id={r.shortId} />
      <span className={s.tag}>{nameOf(r.projectId)}</span>
      <span title={exact(r.createdAt)}>{agoLong(r.createdAt, now)}</span>
    </>
  )

  // Предложенный исполнитель: кто это, его роль и ответ на «отвечал ли сегодня» — одним взглядом.
  const suggestedBlock = (a: AgentProfile) => {
    const live = liveness(a.lastSeen, now)
    return (
      <span className={s.suggested}>
        <span className={s.suggestlbl}>кому</span>
        <AgentChip handle={a.handle} title={a.title} role={a.role} showRole lastSeen={a.lastSeen} retired={!a.active} plain />
        <span className={cx(s.live, s[`live_${live}`])} title={LIVENESS_HINT[live]}>{LIVENESS_LABEL[live]}</span>
      </span>
    )
  }

  // Строка, у которой пропал тикет (исчез между планом и отрисовкой) — показываем честно, а не прячем.
  const gone = (row: ManagerRow) => (
    <div className={s.gone} key={row.proposal.ticketId}>
      Тикет «{row.proposal.shortId}» исчез с доски, пока строился план. {row.proposal.reason}
    </div>
  )

  const confidentItems: BulkItem[] = view.confident.flatMap((row) =>
    row.report && row.suggested
      ? [{
          id: row.report.id,
          shortId: row.report.shortId,
          agentHandle: row.suggested.handle,
          agentName: row.suggested.title || row.suggested.handle,
          note: row.report.note,
        }]
      : [],
  )

  const nothing =
    view.assigns.length === 0 && view.nudges.length === 0 && view.escalations.length === 0

  return (
    <Shell active="manager">
      <main className="wrap">
        <SectionHeader
          lead
          plain
          title="Менеджер"
          hint="Раскладка доски: кому что раздать, что подтолкнуть и что оставить вам"
          actions={<Link className={s.open} href={ROUTE_TICKETS}>вся доска →</Link>}
        />

        {/* Режим советника — сказано прямо, чтобы владелец знал: без него ничто не действует. */}
        <div className={s.mode}>
          <span className={s.modedot} aria-hidden />
          <span className={s.modetxt}>
            <b>Режим советника.</b> Менеджер предлагает — решаете вы. Автономный режим выключен: ни одно
            назначение не применяется, пока вы не нажмёте «Подтвердить».
          </span>
        </div>

        {view.truncated ? (
          <p className={s.warn}>
            Тикетов больше, чем экран берёт за один заход, — план построен по ЧАСТИ доски. Это предел
            выборки, а не потолок доски: раздайте разобранное и откройте снова.
          </p>
        ) : null}

        {nothing ? (
          <EmptyState
            title="Доска разложена"
            hint="Нечего раздавать, ничего не застряло, решать вам нечего. Каждый живой тикет либо у кого-то в работе, либо ждёт своей очереди на доске."
            actions={<Link className={s.action} href={ROUTE_TICKETS}>Открыть доску</Link>}
          />
        ) : null}

        {/* ── ПРЕДЛАГАЮ РАЗДАТЬ ──────────────────────────────────────────────────────────────────────── */}
        {view.assigns.length > 0 ? (
          <section className={s.section}>
            <SectionHeader
              title="Предлагаю раздать"
              count={view.assigns.length}
              countTone="neutral"
              countTitle="Столько тикетов менеджер нашёл кому передать"
              hint="один клик — и тикет адресован; API проверит передачу"
            />

            {confidentItems.length > 0 ? (
              <div className={s.bulkwrap}>
                <BulkAssign items={confidentItems} />
                <span className={s.bulkhint}>
                  {confidentItems.length} из {view.assigns.length} — уверенные назначения (по одному живому
                  исполнителю доски или однозначному совпадению по теме). Неоднозначные не входят.
                </span>
              </div>
            ) : null}

            {view.assigns.slice(0, SECTION_LIMIT).map((row) => {
              if (!row.report) return gone(row)
              const r = row.report
              return (
                <div className={s.item} key={r.id}>
                  <TicketRow
                    href={`/r/${r.id}`}
                    screenshotUrl={r.screenshotUrl}
                    title={r.note || 'без заметки'}
                    meta={meta(r)}
                    who={row.suggested ? suggestedBlock(row.suggested) : null}
                    aside={
                      row.suggested ? (
                        <ConfirmAssign
                          id={r.id}
                          shortId={r.shortId}
                          agentHandle={row.suggested.handle}
                          agentName={row.suggested.title || row.suggested.handle}
                        />
                      ) : (
                        // assign без разрешимого адресата — исполнитель успел выйти из состава. Не назначаем вслепую.
                        <Link className={s.open} href={`/r/${r.id}`}>исполнитель вне состава — открыть тикет →</Link>
                      )
                    }
                  >
                    <p className={cx(s.reason, row.proposal.confidence === 'low' && s.reason_low)}>
                      {row.proposal.reason}
                      {row.proposal.source === 'llm' ? <span className={s.llmtag} title="Выбор подсказал LLM-помощник — проверьте">подсказка LLM</span> : null}
                    </p>
                  </TicketRow>
                </div>
              )
            })}
            {view.assigns.length > SECTION_LIMIT ? (
              <p className={s.more}>Показаны {SECTION_LIMIT} из {view.assigns.length} — раздайте эти и откройте снова.</p>
            ) : null}
          </section>
        ) : null}

        {/* ── ЗАСТРЯЛО, ПОДТОЛКНУТЬ ──────────────────────────────────────────────────────────────────── */}
        {view.nudges.length > 0 ? (
          <section className={s.section}>
            <SectionHeader
              title="Застряло, подтолкнуть"
              count={view.nudges.length}
              countTone="neutral"
              countTitle="Столько тикетов стоит дольше срока"
              hint="напоминание — пометка в тикете; сессию исполнителя это не будит"
            />
            {view.nudges.slice(0, SECTION_LIMIT).map((row) => {
              if (!row.report) return gone(row)
              const r = row.report
              const kind: NudgeKind = r.status === 'needs_review' ? 'review' : 'taken'
              return (
                <div className={s.item} key={r.id}>
                  <TicketRow
                    href={`/r/${r.id}`}
                    screenshotUrl={r.screenshotUrl}
                    title={r.note || 'без заметки'}
                    meta={meta(r)}
                    who={
                      <span className={s.holdrow}>
                        {row.suggested ? (
                          <span className={s.suggested}>
                            <span className={s.suggestlbl}>{kind === 'review' ? 'принять' : 'держит'}</span>
                            <AgentChip handle={row.suggested.handle} title={row.suggested.title} lastSeen={row.suggested.lastSeen} retired={!row.suggested.active} plain />
                          </span>
                        ) : null}
                        <StatusPill status={r.status} size="sm" />
                      </span>
                    }
                    aside={<NudgeButton id={r.id} shortId={r.shortId} kind={kind} />}
                  >
                    <p className={s.reason}>{row.proposal.reason}</p>
                  </TicketRow>
                </div>
              )
            })}
            {view.nudges.length > SECTION_LIMIT ? (
              <p className={s.more}>Показаны {SECTION_LIMIT} из {view.nudges.length} — самые старые сверху.</p>
            ) : null}
          </section>
        ) : null}

        {/* ── ТЕБЕ РЕШАТЬ ────────────────────────────────────────────────────────────────────────────── */}
        {view.escalations.length > 0 ? (
          <section className={s.section}>
            <SectionHeader
              title="Тебе решать"
              count={view.escalations.length}
              countTone="attention"
              countTitle="Столько решений менеджер не вправе принять сам"
              hint="неоднозначная маршрутизация, коллизии и всё, что решаете только вы"
            />
            {!view.usedLlm ? (
              <p className={s.escnote}>
                LLM-помощник выключен, поэтому неоднозначное менеджер НЕ угадывал — оно честно здесь. Выберите
                исполнителя на тикете, и в следующий раз доска будет разложена полнее.
              </p>
            ) : null}
            {view.escalations.slice(0, SECTION_LIMIT).map((row) => {
              if (!row.report) return gone(row)
              const r = row.report
              return (
                <div className={s.item} key={r.id}>
                  <TicketRow
                    attention
                    href={`/r/${r.id}`}
                    screenshotUrl={r.screenshotUrl}
                    title={r.note || 'без заметки'}
                    meta={meta(r)}
                    who={<StatusPill status={r.status} size="sm" />}
                    aside={<Link className={s.open} href={`/r/${r.id}`}>решить на тикете →</Link>}
                  >
                    <p className={s.reason}>{row.proposal.reason}</p>
                  </TicketRow>
                </div>
              )
            })}
            {view.escalations.length > SECTION_LIMIT ? (
              <p className={s.more}>Показаны {SECTION_LIMIT} из {view.escalations.length}.</p>
            ) : null}
          </section>
        ) : null}

        {/* Оставленное доске — не прячем: владелец должен знать, что план не «потерял» эти тикеты, а осознанно их не тронул. */}
        {view.leaveCount > 0 ? (
          <p className={s.leave}>
            Ещё {view.leaveCount} — оставлено доске: свежие или уже адресованные живому исполнителю. Менеджер
            намеренно их не трогает, чтобы доска успела разобрать их сама.
          </p>
        ) : null}
      </main>
    </Shell>
  )
}
