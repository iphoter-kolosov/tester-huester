// The ИСПОЛНИТЕЛЬ picker's data: who the capture may be addressed to on the board it is going to.
//
// Pure (no chrome, no DOM) for the same reason report.ts is: the page overlay and the standalone editor window
// must offer the SAME people under the same rules, and a rule that lives in two event handlers drifts. Both
// surfaces call these three functions and do nothing else with the roster.
//
// The roster arrives on GET /api/projects — the one call the overlay already makes, answered with an ingest key.
// The server decides who is assignable where; everything here is presentation.

/** One option in the picker: a person, not a slug. `role` is the hover text — too long for a <select> line. */
export type AssignableAgent = { handle: string; title: string; role: string }

/** GET /api/projects. `assignable` lists HANDLES into `agents`, which carries each profile exactly once. */
export type ProjectsAnswer = {
  ok?: boolean
  projects?: { id: string; name: string; assignable?: string[] }[]
  agents?: AssignableAgent[]
  defaultId?: string
}

export const ASSIGNEE_NOBODY_LABEL = '— никому (разберёт владелец)'
export const ASSIGNEE_NONE_ON_BOARD_LABEL = 'на этой доске пока нет агентов'
// Said out loud rather than shown as an empty list: "nobody is here" and "I could not ask who is here" look
// identical in a dropdown and mean opposite things — the first is a fact about the board, the second is a
// failure that the reporter has to know about before he wonders why he cannot address anything.
export const ASSIGNEE_UNAVAILABLE_LABEL = 'список агентов не загрузился — уйдёт без исполнителя'
/** A handle whose owner never described itself. The picker says so instead of showing a blank tooltip. */
export const ROLE_UNDESCRIBED = 'роль не описана — этот агент ещё не сказал, за что отвечает'

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))

/**
 * Whom the ticket may be addressed to if it goes to `projectId`.
 *
 * A handle that is not in the dictionary is dropped: offering it would produce an option with no name and no role,
 * and choosing it would earn a refusal from the collector. An unknown project id yields nobody, which is the truth
 * — the board the ticket is going to is the board whose agents may receive it.
 */
export function assignableOn(res: ProjectsAnswer, projectId: string | null): AssignableAgent[] {
  const project = res.projects?.find((p) => p.id === projectId)
  if (!project?.assignable?.length) return []
  const byHandle = new Map((res.agents ?? []).map((a) => [a.handle, a]))
  return project.assignable.map((h) => byHandle.get(h)).filter((a): a is AssignableAgent => !!a)
}

/**
 * The addressee survives a change of project only if the new board can actually receive work from them. Carrying
 * the old handle across would send the collector a name it refuses — after the screenshot, the note and the video
 * have already been typed, which is the worst possible moment to find out.
 */
export function keepAssignee(assignee: string | null, agents: AssignableAgent[]): string | null {
  return assignee && agents.some((a) => a.handle === assignee) ? assignee : null
}

/**
 * The <option> list. `loaded` says whether the roster answer arrived at all — see ASSIGNEE_UNAVAILABLE_LABEL.
 *
 * "никому" is first and is the default on purpose: most captures are exactly that, and making the common case
 * choose would slow down the one path this tool exists to keep fast.
 */
export function assigneeOptionsHtml(agents: AssignableAgent[], selected: string | null, loaded: boolean): string {
  if (!loaded) return `<option value="">${esc(ASSIGNEE_UNAVAILABLE_LABEL)}</option>`
  if (!agents.length) return `<option value="">${esc(ASSIGNEE_NONE_ON_BOARD_LABEL)}</option>`
  const nobody = `<option value=""${selected ? '' : ' selected'}>${esc(ASSIGNEE_NOBODY_LABEL)}</option>`
  return (
    nobody +
    agents
      .map((a) => {
        const label = a.title ? `${a.handle} — ${a.title}` : a.handle
        return `<option value="${esc(a.handle)}" title="${esc(a.role || ROLE_UNDESCRIBED)}"${a.handle === selected ? ' selected' : ''}>${esc(label)}</option>`
      })
      .join('')
  )
}
