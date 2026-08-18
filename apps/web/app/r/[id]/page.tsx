import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import type { ReproBundle } from '@th/core'
import { repo, STATUS_NEEDS_REVIEW, type AgentProfile } from '@th/db'
import Shell from '@/components/shell/Shell'
import SectionHeader from '@/components/ui/SectionHeader'
import StatusPill from '@/components/ui/StatusPill'
import AgentChip from '@/components/ui/AgentChip'
import CopyId from '@/components/CopyId'
import EditableNote from '@/components/EditableNote'
import CommentThread from '@/components/CommentThread'
import ShotWithEditor from '@/components/ShotWithEditor'
import AttachmentGallery from '@/components/AttachmentGallery'
import WorkReport from '@/components/WorkReport'
import ReproContext from '@/components/ReproContext'
import ReplayPlayer from '@/components/ReplayPlayer'
import VideoPlayer from '@/components/VideoPlayer'
import StatusSelect from '@/components/tickets/StatusSelect'
import AssignPicker, { type AssignableAgent } from '@/components/tickets/AssignPicker'
import ArchiveToggle from '@/components/tickets/ArchiveToggle'
import TicketProperties from '@/components/tickets/TicketProperties'
import VerdictBar from '@/components/tickets/VerdictBar'
import VideoFrames from './VideoFrames'
import { rosterMap } from '@/components/agents'
import { participantsOf } from '@/lib/roster'
import { agoLong, exact } from '@/lib/time'
import { cx } from '@/lib/cx'
import { ROUTE_TICKETS } from '@/components/shell/nav'
import { isAuthed } from '@/lib/auth'
import s from './ticket.module.css'

// Comments written by the owner carry a display name, not an identity, so they are never looked up on the roster.
const AGENT_VOICE = 'agent'

const NO_SITE = '(без сайта)'

export const dynamic = 'force-dynamic'

// СТРАНИЦА ТИКЕТА. Порядок чтения — порядок расследования: что случилось → как это выглядит → как повторить
// → о чём договорились. Всё служебное (свойства, окно, браузер, идентификаторы) вынесено в правую колонку и
// в чтении не участвует; там же стоят два органа, которыми тикет двигают, — статус и передача.

function host(pageUrl: string | null): string {
  if (!pageUrl) return NO_SITE
  try {
    return new URL(pageUrl).host
  } catch {
    return NO_SITE
  }
}

function toAssignable(a: AgentProfile): AssignableAgent {
  return { handle: a.handle, title: a.title, role: a.role, active: a.active, lastSeen: a.lastSeen }
}

export default async function ReportDetail({ params }: { params: Promise<{ id: string }> }) {
  if (!(await isAuthed())) redirect('/login')
  const { id } = await params
  const r = repo.resolveReport(id)
  if (!r) notFound()

  const projects = repo.listProjects()
  const projOpts = projects.map((p) => ({ value: p.id, label: p.name }))
  const projectName = projects.find((p) => p.id === r.projectId)?.name ?? 'проект'
  const comments = repo.listComments(r.id)
  // Pin the newest work report at the top: when a ticket comes back for review, the first thing its reader needs
  // is what was done and where to look — not a scroll through the thread.
  const check = repo.latestVerification(r.id)
  // Every voice on this page in one lookup: the three addressing slots plus whoever spoke in the thread.
  const participants = participantsOf([
    r.creator,
    r.assignee,
    r.takenBy,
    ...comments.filter((c) => c.authorKind === AGENT_VOICE).map((c) => c.author),
  ])
  const roster = rosterMap(participants.agents)
  const addressable = repo.listAgents().map(toAssignable)
  // Точка живости у автора и у исполнителя — тот же ответ, что и в передаче: «этот ещё отвечает или нет».
  const lastSeenOf = new Map(participants.agents.map((a) => [a.handle, a.lastSeen] as const))
  const liveOf = (handle: string): number | null => lastSeenOf.get(handle) ?? null
  const waiting = r.status === STATUS_NEEDS_REVIEW

  return (
    <Shell active="tickets">
      <main className="wrap">
        <Link className={s.back} href={ROUTE_TICKETS}>← все тикеты</Link>

        <div className={s.head}>
          <h1 className={s.h1}>
            Тикет <CopyId id={r.shortId} big />
          </h1>
          <StatusPill status={r.status} />
          {r.archived ? <span className={s.archived}>в архиве</span> : null}
        </div>
        <div className={s.meta}>
          <span className={s.metahost}>{host(r.pageUrl)}</span>
          <span>{projectName}</span>
          <span title={exact(r.createdAt)}>снят {agoLong(r.createdAt)}</span>
          {r.pageUrl ? (
            <a className={s.metalink} href={r.pageUrl} target="_blank" rel="noreferrer">
              открыть страницу ↗
            </a>
          ) : null}
        </div>

        <div className={s.grid}>
          <div className={s.col}>
            {check ? (
              <WorkReport
                author={check.author}
                body={check.body}
                url={check.verifyUrl}
                steps={check.verifySteps}
                evidence={check.evidence}
                at={check.createdAt}
              />
            ) : waiting ? (
              // Handed over for review with nothing to check by — an older ticket, or a status flipped by hand.
              <p className={s.missing}>
                Работа сдана на проверку, но проверочной ссылки к ней не приложено — проверять нечем.
              </p>
            ) : null}

            {waiting ? <VerdictBar id={r.id} executor={r.takenBy ?? r.assignee} /> : null}

            <section className={s.section}>
              <SectionHeader title="Что случилось" hint="заметка тикета — её видит и агент" />
              <EditableNote id={r.id} value={r.note} />
            </section>

            {r.screenshotUrl ? (
              <section className={s.section}>
                <SectionHeader title="Что видно" hint="снимок можно разметить и отправить в обсуждение" />
                <ShotWithEditor src={r.screenshotUrl} reportId={r.id} />
              </section>
            ) : null}

            {r.attachments.length ? (
              <section className={s.section}>
                <AttachmentGallery items={r.attachments} reportId={r.id} />
              </section>
            ) : null}

            {r.videoUrl ? (
              <section className={s.section}>
                <VideoPlayer url={r.videoUrl} seconds={r.videoSeconds} trim={r.videoTrim} />
                <VideoFrames frames={r.videoFrames ?? []} />
              </section>
            ) : r.replayUrl ? (
              <section className={s.section}>
                <ReplayPlayer url={r.replayUrl} />
              </section>
            ) : r.videoFrames?.length ? (
              // Запись не доехала, а кадры остались: показать их — единственный способ увидеть, что было.
              <section className={s.section}>
                <SectionHeader title="Кадры из записи" hint="сама запись к тикету не приложена" />
                <VideoFrames frames={r.videoFrames} />
              </section>
            ) : null}

            {r.context ? (
              <section className={s.section}>
                <ReproContext context={r.context as ReproBundle} />
              </section>
            ) : null}

            <CommentThread reportId={r.id} comments={comments} roster={roster} />
          </div>

          <aside className={s.side}>
            <div className={s.card}>
              <SectionHeader plain title="Работа" />
              <div className={s.cardrow}>
                <span className={s.cardk}>Состояние</span>
                <StatusSelect id={r.id} status={r.status} />
              </div>
              <div className={s.cardrow}>
                <span className={s.cardk}>Кому передан</span>
                <AssignPicker
                  id={r.id}
                  assignee={r.assignee}
                  roster={addressable}
                  assigneeUnknown={!!r.assignee && participants.unknown.includes(r.assignee)}
                />
              </div>
              {/* Кто поставил и кто держит — два оставшихся слота адресации. «Кому» здесь нет намеренно: на него
                  уже отвечает орган передачи выше, и второй ответ рядом с первым читается как противоречие. */}
              <div className={s.cardrow}>
                <span className={s.cardk}>Поставил</span>
                {r.creator ? (
                  <AgentChip
                    handle={r.creator}
                    title={roster[r.creator]?.title ?? null}
                    lastSeen={liveOf(r.creator)}
                    unknown={participants.unknown.includes(r.creator)}
                  />
                ) : (
                  <span className={s.factv_quiet}>{r.reporter || 'неизвестно'}</span>
                )}
              </div>
              <div className={s.cardrow}>
                <span className={s.cardk}>Держит в работе</span>
                {r.takenBy ? (
                  <AgentChip
                    handle={r.takenBy}
                    title={roster[r.takenBy]?.title ?? null}
                    lastSeen={liveOf(r.takenBy)}
                    unknown={participants.unknown.includes(r.takenBy)}
                  />
                ) : r.takenAt ? (
                  // Время взятия есть, а исполнителя нет: так пишет статус «в работе», выставленный с панели.
                  // Называем расхождение вслух — тикет, который «в работе» и при этом ничей, иначе теряется.
                  <span className={s.mismatch}>
                    никто не держит, хотя взят в работу {exact(r.takenAt)}
                  </span>
                ) : (
                  <span className={s.factv_quiet}>никто не держит</span>
                )}
              </div>
            </div>

            <div className={s.card}>
              <SectionHeader plain title="Свойства" />
              <TicketProperties id={r.id} type={r.type} severity={r.severity} projectId={r.projectId} projects={projOpts} />
              <div className={cx(s.cardrow, s.cardrow_gap)}>
                <ArchiveToggle id={r.id} archived={r.archived} />
              </div>
            </div>

            <div className={s.card}>
              <SectionHeader plain title="Обстоятельства" />
              <div className={s.facts}>
                <span className={s.factk}>Страница</span>
                <span className={s.factv}>
                  {r.pageUrl ? (
                    <a className={s.metalink} href={r.pageUrl} target="_blank" rel="noreferrer">{r.pageUrl}</a>
                  ) : (
                    '—'
                  )}
                </span>
                <span className={s.factk}>Окно</span>
                <span className={s.factv}>{r.viewport || '—'}</span>
                <span className={s.factk}>Снял</span>
                <span className={s.factv}>{r.reporter || '—'}</span>
                <span className={s.factk}>Браузер</span>
                <span className={cx(s.factv, s.factv_quiet)}>{r.userAgent || '—'}</span>
                <span className={s.factk}>Создан</span>
                <span className={s.factv}>{exact(r.createdAt)}</span>
                <span className={s.factk}>Идентификатор</span>
                <span className={s.factv}>
                  <CopyId id={r.shortId} />
                  <div className={s.factid}>{r.id}</div>
                </span>
              </div>
            </div>
          </aside>
        </div>
      </main>
    </Shell>
  )
}
