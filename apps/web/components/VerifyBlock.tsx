// The check the agent handed over: WHERE to look and HOW. Rendered twice — pinned at the top of the ticket
// (the most recent one, so the reporter never hunts the thread for "where do I click") and inline in the
// comment that made the claim, so the record stays attached to who said it.
export default function VerifyBlock({
  url,
  steps,
  evidence = null,
  author,
  compact = false,
}: {
  url: string | null
  steps: string[] | null
  // What PROVES the work — the fourth part of a work report. It lives with the link and the steps because a
  // reviewer reads all three in one breath: open this, do that, and here is what already passed.
  evidence?: string | null
  author?: string
  compact?: boolean
}) {
  if (!url && !(steps && steps.length) && !evidence) return null
  let host = ''
  try {
    if (url) host = new URL(url).host
  } catch {
    host = ''
  }
  return (
    <div className={'vfy' + (compact ? ' vfycompact' : '')}>
      <div className="vfyhead">
        <span className="vfyttl">✅ Как проверить</span>
        {author && !compact ? <span className="vfywho">от {author}</span> : null}
      </div>
      {url ? (
        <a className="vfylink" href={url} target="_blank" rel="noreferrer">
          <span className="vfylinklbl">Открыть и проверить</span>
          <span className="vfylinkurl">{host || url}</span>
          <span className="vfyarrow">↗</span>
        </a>
      ) : null}
      {steps && steps.length ? (
        <ol className="vfysteps">
          {steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      ) : null}
      {evidence ? (
        <div className="vfyev">
          <span className="vfyevk">🧾 Чем доказано</span>
          <span className="vfyevv">{evidence}</span>
        </div>
      ) : null}
      {url ? <div className="vfyraw">{url}</div> : null}
    </div>
  )
}
