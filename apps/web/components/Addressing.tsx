import {
  AgentRef,
  FreeTextRef,
  NOBODY_ASSIGNED,
  NOBODY_FILED,
  NOBODY_HOLDS,
  type RosterMap,
} from './agents'

// The three questions a board of agents asks about every ticket: who filed it, who it is for, who is holding it
// right now. Always all three, including the empty ones — an unassigned ticket is a fact worth seeing, and fixed
// slots let the eye scan a column of rows instead of re-reading each one.
//
// Each slot is a ROSTER reference, not a bare handle: a name with a role beside it tells the reader why that voice
// matters, which a handle alone never did. `detailed` is the ticket page, where there is room for the role inline;
// on the board the role stays in the tooltip so a column of rows keeps scanning as a table.
export default function Addressing({
  creator,
  reporter,
  assignee,
  takenBy,
  takenAt,
  roster,
  detailed = false,
}: {
  creator: string | null
  reporter: string | null
  assignee: string | null
  takenBy: string | null
  takenAt: number | null
  roster: RosterMap
  detailed?: boolean
}) {
  return (
    <div className={'who' + (detailed ? ' whodet' : '')}>
      <span className="whoitem" title="Кто поставил тикет">
        <span className="whok">поставил</span>
        {/* `creator` is the canonical identity of whoever filed it. `reporter` is the free human text the extension
            collects and is all a ticket filed before identities existed ever had — so it stands in rather than an
            empty slot, but it is drawn as text, because looking a free name up in a roster would only ever fail. */}
        {creator ? (
          <AgentRef handle={creator} roster={roster} nobody={NOBODY_FILED} showRole={detailed} />
        ) : reporter ? (
          <FreeTextRef value={reporter} />
        ) : (
          <AgentRef handle={null} roster={roster} nobody={NOBODY_FILED} />
        )}
      </span>
      <span className="whoitem" title="Кому тикет адресован">
        <span className="whok">кому</span>
        <AgentRef handle={assignee} roster={roster} nobody={NOBODY_ASSIGNED} showRole={detailed} />
      </span>
      <span
        className="whoitem"
        title={takenBy && takenAt ? `Взят в работу ${new Date(takenAt).toLocaleString()}` : 'Кто держит тикет прямо сейчас'}
      >
        <span className="whok">держит</span>
        <AgentRef handle={takenBy} roster={roster} nobody={NOBODY_HOLDS} showRole={detailed} />
      </span>
    </div>
  )
}
