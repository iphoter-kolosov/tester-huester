// The check the agent handed over: WHERE to look and HOW. Rendered twice — pinned at the top of the ticket
// (the most recent one, so the reporter never hunts the thread for "where do I click") and inline in the
// comment that made the claim, so the record stays attached to who said it.
export default function VerifyBlock({
  url,
  steps,
  author,
  compact = false,
}: {
  url: string | null
  steps: string[] | null
  author?: string
  compact?: boolean
}) {
  if (!url && !(steps && steps.length)) return null
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
      {url ? <div className="vfyraw">{url}</div> : null}
    </div>
  )
}
