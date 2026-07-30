'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export type CommentView = { id: string; author: string; authorKind: string; body: string; createdAt: number }

function ago(ms: number): string {
  const mins = Math.floor((Date.now() - ms) / 60000)
  if (mins < 1) return 'только что'
  if (mins < 60) return `${mins} мин назад`
  const h = Math.floor(mins / 60)
  if (h < 24) return `${h} ч назад`
  return new Date(ms).toLocaleString()
}

// The ticket's conversation: the dev agent reports back here (what it fixed, what it couldn't reproduce) and
// the reporter answers in the same place. The agent posts through MCP/REST scoped to its project; this is the
// human half of the same thread.
export default function CommentThread({ reportId, comments }: { reportId: string; comments: CommentView[] }) {
  const router = useRouter()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const post = async () => {
    const body = text.trim()
    if (!body || busy) return
    setBusy(true)
    try {
      const r = await fetch(`/api/reports/${reportId}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      })
      if (r.ok) {
        setText('')
        router.refresh()
      }
    } finally {
      setBusy(false)
    }
  }

  const remove = async (commentId: string) => {
    if (!confirm('Удалить комментарий?')) return
    setBusy(true)
    try {
      const r = await fetch(`/api/reports/${reportId}/comments?commentId=${encodeURIComponent(commentId)}`, { method: 'DELETE' })
      if (r.ok) router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="thr">
      <div className="thrhead">
        <span className="ctxttl">💬 Обсуждение</span>
        <span className="thrn">{comments.length}</span>
      </div>

      {comments.length === 0 && <div className="ctxempty">Пока нет комментариев. Агент оставит здесь отчёт о работе.</div>}

      {comments.map((c) => (
        <div className={'cmt' + (c.authorKind === 'agent' ? ' cmt-agent' : '')} key={c.id}>
          <div className="cmthead">
            <span className="cmtwho">{c.authorKind === 'agent' ? '🤖' : '👤'} {c.author}</span>
            <span className="cmtwhen">{ago(c.createdAt)}</span>
            <button className="cmtdel" onClick={() => remove(c.id)} disabled={busy} title="Удалить">✕</button>
          </div>
          <div className="cmtbody">{c.body}</div>
        </div>
      ))}

      <div className="cmtnew">
        <textarea
          className="cmtta"
          value={text}
          placeholder="Ответить агенту…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); post() } }}
        />
        <div className="cmtfoot">
          <span className="ednote-hint">⌘/Ctrl+Enter — отправить</span>
          <button className="ednote-save" onClick={post} disabled={!text.trim() || busy}>Отправить</button>
        </div>
      </div>
    </div>
  )
}
