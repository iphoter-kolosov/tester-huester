import { redirect } from 'next/navigation'

// The ticket page lives at /r/<id>, but /tickets/<id> is the address people (and the agent hub's notification cards,
// up to 15.10) naturally build from the board's own /tickets. Sending it on beats a bare 404.
export default async function TicketAlias({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  redirect(`/r/${encodeURIComponent(id)}`)
}
