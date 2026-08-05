'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import VerifyBlock from './VerifyBlock'

export type CommentView = {
  id: string; author: string; authorKind: string; body: string; createdAt: number
  verifyUrl?: string | null; verifySteps?: string[] | null
}

// Very small markdown: bold **x**, code `x`, image ![alt](url). Nothing else — a full parser would over-invite
// the tester to write HTML in a bug report. Split into segments so React renders <img>/<code>/<strong> safely,
// no innerHTML anywhere.
type Seg = { t: 'text' | 'img' | 'code' | 'bold' | 'br'; v: string; alt?: string }
function renderBody(body: string): Seg[] {
  const out: Seg[] = []
  const lines = body.split('\n')
  const IMG = /!\[([^\]]*)\]\(([^)\s]+)\)/g
  const CODE = /`([^`]+)`/g
  const BOLD = /\*\*([^*]+)\*\*/g
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!
    let last = 0
    for (const m of line.matchAll(IMG)) {
      if (m.index! > last) inline(line.slice(last, m.index), out)
      out.push({ t: 'img', v: m[2]!, alt: m[1] || 'image' })
      last = m.index! + m[0].length
    }
    if (last < line.length) inline(line.slice(last), out)
    if (li < lines.length - 1) out.push({ t: 'br', v: '' })
  }
  return out

  function inline(s: string, o: Seg[]) {
    // Run bold and code sequentially over the same run — each replaces its matches with segment markers.
    const parts: Seg[] = [{ t: 'text', v: s }]
    const step = (re: RegExp, kind: 'bold' | 'code') => {
      const next: Seg[] = []
      for (const p of parts) {
        if (p.t !== 'text') { next.push(p); continue }
        let last = 0
        for (const m of p.v.matchAll(re)) {
          if (m.index! > last) next.push({ t: 'text', v: p.v.slice(last, m.index) })
          next.push({ t: kind, v: m[1]! })
          last = m.index! + m[0].length
        }
        if (last < p.v.length) next.push({ t: 'text', v: p.v.slice(last) })
      }
      parts.splice(0, parts.length, ...next)
    }
    step(CODE, 'code')
    step(BOLD, 'bold')
    for (const p of parts) o.push(p)
  }
}

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
  const ta = useRef<HTMLTextAreaElement>(null)

  // Listen for the ShotEditor: when it finishes, drop the markdown image reference at the caret so the reply
  // reads as "look at this: <annotated shot>". Scroll it into view so the tester sees the insertion happen.
  useEffect(() => {
    const onInsert = (e: Event) => {
      const md = (e as CustomEvent<string>).detail || ''
      const el = ta.current
      if (!el) { setText((t) => (t ? t + '\n\n' + md : md)); return }
      const start = el.selectionStart ?? el.value.length
      const end = el.selectionEnd ?? start
      const before = el.value.slice(0, start)
      const after = el.value.slice(end)
      const sep = before && !before.endsWith('\n') ? '\n\n' : ''
      const next = before + sep + md + '\n' + after
      setText(next)
      requestAnimationFrame(() => {
        el.focus()
        el.setSelectionRange(start + sep.length + md.length + 1, start + sep.length + md.length + 1)
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
    }
    window.addEventListener('th:insert-comment', onInsert)
    return () => window.removeEventListener('th:insert-comment', onInsert)
  }, [])

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
          <div className="cmtbody">
            {renderBody(c.body).map((s, i) => {
              if (s.t === 'img') return <img key={i} src={s.v} alt={s.alt} />
              if (s.t === 'code') return <code key={i}>{s.v}</code>
              if (s.t === 'bold') return <strong key={i}>{s.v}</strong>
              if (s.t === 'br') return <br key={i} />
              return <span key={i}>{s.v}</span>
            })}
          </div>
          {/* The check that came with this message — stays attached to the claim that made it. */}
          <VerifyBlock url={c.verifyUrl ?? null} steps={c.verifySteps ?? null} compact />
        </div>
      ))}

      <div className="cmtnew">
        <textarea
          ref={ta}
          className="cmtta"
          value={text}
          placeholder="Ответить агенту… (можно вставлять размеченные скриншоты через кнопку «✏ Разметить» над снимком)"
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
