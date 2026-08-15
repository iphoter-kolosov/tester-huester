import type { ReactElement } from 'react'

// How the dashboard draws a participant. The roster itself is decided in @th/db; only its rendering lives here.
// The shape is redeclared instead of imported because CommentThread is a client component and a value import
// from @th/db would drag node:sqlite into the browser bundle — the same reason status.ts keeps its own labels.
// It is structurally a subset of AgentProfile, so a roster row passes without conversion.
export type AgentBrief = { handle: string; title: string; role: string; active: boolean }
export type RosterMap = Record<string, AgentBrief>

export function rosterMap(agents: readonly AgentBrief[]): RosterMap {
  return Object.fromEntries(
    agents.map((a) => [a.handle, { handle: a.handle, title: a.title, role: a.role, active: a.active }]),
  )
}

// What the empty slots say. «Кому» gets a sentence rather than a dash because an unaddressed ticket is currently
// EVERY ticket on the board, and a dash reads like a missing value instead of like the gap it is.
export const NOBODY_ASSIGNED = 'никому не адресована'
export const NOBODY_FILED = 'неизвестно'
export const NOBODY_HOLDS = 'никто не держит'

export const NO_ROLE = 'роль не описана'

// A handle nobody has claimed is almost always a board name written by an agent that never set its own identity.
// Saying that in the tooltip is the difference between the owner seeing a colleague and seeing the defect.
export const UNKNOWN_HINT =
  'Это имя есть в тикетах, но его нет в составе — почти всегда так подписывалась доска, а не агент. Настоящим агентом оно станет, когда агент представится под своим именем.'

export const FREE_TEXT_HINT = 'Свободный текст из расширения: тикет поставлен до того, как у агентов появились имена.'

/** The name a human reads. An undescribed entry falls back to its handle — «есть, но не описан» must not look like «нет». */
export function agentName(handle: string, roster: RosterMap): string {
  return roster[handle]?.title || handle
}

/**
 * One participant, drawn the same way everywhere a handle appears: who it is, under what handle it writes, and —
 * where the layout has room — what it is FOR. A handle with no roster row is drawn differently on purpose.
 */
export function AgentRef({
  handle,
  roster,
  nobody,
  showRole = false,
}: {
  handle: string | null
  roster: RosterMap
  nobody: string
  showRole?: boolean
}): ReactElement {
  if (!handle) return <span className="agnone">{nobody}</span>
  const a = roster[handle]
  if (!a) {
    return (
      <span className="agref agref-unknown" title={UNKNOWN_HINT}>
        <span className="aghandle">{handle}</span>
        <span className="agmark">не в составе</span>
      </span>
    )
  }
  return (
    <span className={'agref' + (a.active ? '' : ' agref-retired')} title={a.role || `${a.handle} — ${NO_ROLE}`}>
      {a.title ? <span className="agname">{a.title}</span> : null}
      <span className="aghandle">{a.handle}</span>
      {a.active ? null : <span className="agmark">в отставке</span>}
      {showRole ? <span className={'agrole' + (a.role ? '' : ' agrole-none')}>{a.role || NO_ROLE}</span> : null}
    </span>
  )
}

/** Free human text from the extension — a name, not an identity, so it is never looked up in the roster. */
export function FreeTextRef({ value }: { value: string }): ReactElement {
  return (
    <span className="agref agref-text" title={FREE_TEXT_HINT}>
      <span className="aghandle">{value}</span>
    </span>
  )
}
