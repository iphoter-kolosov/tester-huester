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

/**
 * GET /api/projects. `assignable` lists HANDLES into `agents`, which carries each profile exactly once — EVERY
 * active agent, not only the ones who have already touched this board. `onBoard` is the subset of `assignable`
 * that are regulars here (already `assignable`'s own leading order, restated as a set so the picker can group
 * without re-deriving the split); missing/undefined on an older server just means "cannot group", not "nobody
 * assignable" — the picker still renders the full flat list.
 */
export type ProjectsAnswer = {
  ok?: boolean
  projects?: { id: string; name: string; assignable?: string[]; onBoard?: string[] }[]
  agents?: AssignableAgent[]
  defaultId?: string
}

export const ASSIGNEE_NOBODY_LABEL = '— никому (разберёт владелец)'
export const ASSIGNEE_NONE_ON_BOARD_LABEL = 'на этой доске пока нет агентов'
export const ASSIGNEE_GROUP_ON_BOARD = 'Уже работают здесь'
export const ASSIGNEE_GROUP_OTHERS = 'Другие агенты (ещё не были на этой доске)'
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
 * Which of `assignableOn`'s handles are regulars on `projectId` — the split `assigneeOptionsHtml` groups by.
 * Empty (not missing) for an older server that never sent `onBoard`: the picker still renders correctly, just
 * as one flat list instead of two groups, same as before this field existed.
 */
export function onBoardHandles(res: ProjectsAnswer, projectId: string | null): Set<string> {
  return new Set(res.projects?.find((p) => p.id === projectId)?.onBoard ?? [])
}

/**
 * The addressee survives a change of project only if the new board can actually receive work from them. Carrying
 * the old handle across would send the collector a name it refuses — after the screenshot, the note and the video
 * have already been typed, which is the worst possible moment to find out.
 */
export function keepAssignee(assignee: string | null, agents: AssignableAgent[]): string | null {
  return assignee && agents.some((a) => a.handle === assignee) ? assignee : null
}

const optionTag = (a: AssignableAgent, selected: string | null): string => {
  const label = a.title ? `${a.handle} — ${a.title}` : a.handle
  return `<option value="${esc(a.handle)}" title="${esc(a.role || ROLE_UNDESCRIBED)}"${a.handle === selected ? ' selected' : ''}>${esc(label)}</option>`
}

/**
 * The <option> list. `loaded` says whether the roster answer arrived at all — see ASSIGNEE_UNAVAILABLE_LABEL.
 *
 * "никому" is first and is the default on purpose: most captures are exactly that, and making the common case
 * choose would slow down the one path this tool exists to keep fast.
 *
 * `onBoard` splits the rest into two <optgroup>s — regulars here, then everyone else on the roster — so a picker
 * that now offers EVERY active agent on EVERY board (not just the ones who happened to have touched this one
 * already) still surfaces the usual suspects first instead of turning into one long, unsorted directory. Omitted,
 * empty, or covering the whole list: falls back to one flat group, unchanged from before grouping existed.
 */
export function assigneeOptionsHtml(agents: AssignableAgent[], selected: string | null, loaded: boolean, onBoard?: Set<string>): string {
  if (!loaded) return `<option value="">${esc(ASSIGNEE_UNAVAILABLE_LABEL)}</option>`
  if (!agents.length) return `<option value="">${esc(ASSIGNEE_NONE_ON_BOARD_LABEL)}</option>`
  const nobody = `<option value=""${selected ? '' : ' selected'}>${esc(ASSIGNEE_NOBODY_LABEL)}</option>`
  const regulars = onBoard?.size ? agents.filter((a) => onBoard.has(a.handle)) : []
  const others = onBoard?.size ? agents.filter((a) => !onBoard.has(a.handle)) : agents
  if (!regulars.length || !others.length) {
    // Nothing to split: either every agent already works this board, or none do (the field is absent/empty) —
    // either way a second group would be empty or the only one, so one flat list reads better than a group of one.
    return nobody + agents.map((a) => optionTag(a, selected)).join('')
  }
  const group = (label: string, list: AssignableAgent[]): string => `<optgroup label="${esc(label)}">${list.map((a) => optionTag(a, selected)).join('')}</optgroup>`
  return nobody + group(ASSIGNEE_GROUP_ON_BOARD, regulars) + group(ASSIGNEE_GROUP_OTHERS, others)
}
