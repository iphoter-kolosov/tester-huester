import VerifyBlock from './VerifyBlock'

// The executor's hand-over, pinned above the ticket so the owner never hunts the thread for it: WHAT was done,
// WHERE to look, HOW to check, and WHAT PROVES it. The last three are the existing "✅ Как проверить" block —
// same component, same design, so a work report and a bare check never look like two different things.
export default function WorkReport({
  author,
  body,
  url,
  steps,
  evidence,
  at,
}: {
  author: string
  body: string
  url: string | null
  steps: string[] | null
  evidence: string | null
  at: number
}) {
  return (
    <div className="wr">
      <div className="wrhead">
        <span className="wrttl">🧾 Отчёт о работе</span>
        <span className="wrwho">от {author}</span>
        <span className="wrwhen">{new Date(at).toLocaleString()}</span>
      </div>
      {body ? (
        <div className="wrpart">
          <div className="wrk">Что сделано</div>
          <div className="wrbody">{body}</div>
        </div>
      ) : null}
      <VerifyBlock url={url} steps={steps} evidence={evidence} compact />
    </div>
  )
}
