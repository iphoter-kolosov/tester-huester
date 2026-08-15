const NOBODY = '—'

// The three questions a board of agents asks about every ticket: who filed it, who it is for, who is holding it
// right now. Always all three, including the empty ones — an unassigned ticket is a fact worth seeing, and fixed
// slots let the eye scan a column of rows instead of re-reading each one.
export default function Addressing({
  creator,
  reporter,
  assignee,
  takenBy,
  takenAt,
}: {
  creator: string | null
  reporter: string | null
  assignee: string | null
  takenBy: string | null
  takenAt: number | null
}) {
  // `creator` is the canonical identity of whoever filed it. `reporter` is the free human text the extension
  // collects and is all a ticket filed before identities existed ever had — so it stands in rather than "—".
  const filed = creator ?? reporter
  const held = takenBy
  return (
    <div className="who">
      <span className="whoitem" title="Кто поставил тикет">
        <span className="whok">поставил</span>
        <span className={'whov' + (filed ? '' : ' whov-none')}>{filed ?? NOBODY}</span>
      </span>
      <span className="whoitem" title="Кому тикет адресован">
        <span className="whok">кому</span>
        <span className={'whov' + (assignee ? '' : ' whov-none')}>{assignee ?? NOBODY}</span>
      </span>
      <span className="whoitem" title={held && takenAt ? `Взят в работу ${new Date(takenAt).toLocaleString()}` : 'Кто держит тикет прямо сейчас'}>
        <span className="whok">держит</span>
        <span className={'whov' + (held ? '' : ' whov-none')}>{held ?? NOBODY}</span>
      </span>
    </div>
  )
}
