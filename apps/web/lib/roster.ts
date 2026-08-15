import { repo, type AgentProfile } from '@th/db'

/**
 * Who the handles in an answer ARE, attached to the answer itself.
 *
 * Every read that carries identities carries this block, because the alternative is a reader looking at `creator:
 * "photoking agents"` with no idea whether that is an agent, a department or the board it is standing on — which
 * is exactly the state the board was in. One extra query beats a second round trip that nobody makes.
 */
export type Participants = {
  /** Roster rows for the handles that appear in this answer. */
  agents: AgentProfile[]
  /**
   * Handles that appear in the data but are on NO roster row. Reported rather than silently omitted: these are the
   * legacy names — board names and pre-identity strings — and a reader that cannot tell "unknown" from "absent"
   * would keep treating them as agents.
   */
  unknown: string[]
}

export function participantsOf(handles: (string | null | undefined)[]): Participants {
  const wanted = [...new Set(handles.filter((h): h is string => !!h))]
  const agents = repo.getAgents(wanted)
  const known = new Set(agents.map((a) => a.handle))
  return { agents, unknown: wanted.filter((h) => !known.has(h)) }
}
