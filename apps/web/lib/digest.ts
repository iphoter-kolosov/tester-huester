import type { AutonomyMode } from '@th/db'

// THE DIGEST — the safe, always-available half of "передавать информацию, что от него чего-то ожидают". It composes
// what the manager would SAY — new routes it proposes, what is stuck, what only the owner can decide — into text and
// HTML, so the owner can be told WITHOUT any session being woken. Composition needs no cross-session capability and
// no live board access at call time: it takes a plain projection (DigestInput), so a cron script that cannot wake a
// single session can still assemble this and hand it to whatever transport (email/Telegram) is wired later.
//
// Pure and DB-free by design — same reason manager.ts is: the surface (or a cron job) builds DigestInput from repo,
// this module only shapes it. Owner-facing, so Russian throughout.

/** One ticket line in the digest — the shape shared by all three sections. */
export type DigestSection = {
  shortId: string
  board: string
  note: string
  /** The manager's one-sentence reason (already Russian, straight from the proposal). */
  reason: string
  /** Whom the manager suggests (assign/nudge); absent on an escalation. */
  suggested?: string
}

/**
 * Everything the digest needs, as plain data. The surface fills it from a ManagerView; a test fills it by hand.
 * Nothing here reaches into the database, so composeDigest can run anywhere.
 */
export type DigestInput = {
  now: number
  autonomy: AutonomyMode
  /** Whether the LLM channel was consulted — false means nothing ambiguous was guessed, it was escalated. */
  usedLlm: boolean
  /** «Предлагаю раздать» — routes the manager found a home for. */
  assigns: DigestSection[]
  /** «Застряло, подтолкнуть» — held too long or awaiting review too long. */
  nudges: DigestSection[]
  /** «Тебе решать» — the only part that truly needs the owner. */
  escalations: DigestSection[]
  /** Consciously left to the board (fresh/already-addressed) — counted, not listed, so nothing looks lost. */
  leaveCount: number
  /** The plan was built over only PART of the board (selection ceiling) — said out loud, never hidden. */
  truncated: boolean
}

export type Digest = {
  /** A one-line subject for whatever transport carries it. */
  subject: string
  /** Plain-text body — the always-safe form (email, Telegram, a log line). */
  text: string
  /** HTML body — the same content, for a transport that renders it. */
  html: string
  /** Nothing to say: no assigns, no nudges, no escalations. Lets a scheduler skip sending an empty digest. */
  empty: boolean
}

const NBSP = ' '
/** A note is a headline, not a paragraph — trim it so the digest stays scannable. */
const NOTE_MAX = 140

function clip(s: string, n: number): string {
  const t = s.trim()
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t
}

/** Minimal HTML escape — the digest embeds ticket notes written by people, so it must not inject markup. */
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'))
}

function lineText(row: DigestSection): string {
  const who = row.suggested ? ` → ${row.suggested}` : ''
  const note = row.note.trim() ? ` — ${clip(row.note, NOTE_MAX)}` : ''
  return `  • ${row.shortId} [${row.board}]${who}${note}\n    ${row.reason}`
}

function lineHtml(row: DigestSection): string {
  const who = row.suggested ? ` <b>→ ${esc(row.suggested)}</b>` : ''
  const note = row.note.trim() ? ` — ${esc(clip(row.note, NOTE_MAX))}` : ''
  return `<li><code>${esc(row.shortId)}</code> <span style="opacity:.7">[${esc(row.board)}]</span>${who}${note}<br><span style="opacity:.8">${esc(row.reason)}</span></li>`
}

function sectionText(title: string, rows: DigestSection[]): string {
  if (rows.length === 0) return ''
  return `${title} (${rows.length}):\n${rows.map(lineText).join('\n')}\n`
}

function sectionHtml(title: string, rows: DigestSection[]): string {
  if (rows.length === 0) return ''
  return `<h3>${esc(title)} (${rows.length})</h3>\n<ul>\n${rows.map(lineHtml).join('\n')}\n</ul>`
}

/**
 * Compose the digest from its projection. The subject leads with the count that most wants the owner's attention
 * (escalations), because that is the reason to open it at all.
 */
export function composeDigest(input: DigestInput): Digest {
  const empty = input.assigns.length === 0 && input.nudges.length === 0 && input.escalations.length === 0

  const modeWord = input.autonomy === 'on' ? 'автономный режим ВКЛЮЧЁН' : 'режим советника (автономия выключена)'
  const subject = empty
    ? 'Менеджер: доска разложена, ничего не ждёт'
    : `Менеджер: ${input.escalations.length}${NBSP}вам решать, ${input.assigns.length}${NBSP}к раздаче, ${input.nudges.length}${NBSP}застряло`

  // ── text ──
  const textParts: string[] = [
    subject,
    `Режим: ${modeWord}.`,
  ]
  if (empty) {
    textParts.push('\nНечего раздавать, ничего не застряло, решать нечего. Каждый живой тикет либо в работе, либо ждёт очереди.')
  } else {
    const secs = [
      sectionText('ТЕБЕ РЕШАТЬ', input.escalations),
      sectionText('ПРЕДЛАГАЮ РАЗДАТЬ', input.assigns),
      sectionText('ЗАСТРЯЛО, ПОДТОЛКНУТЬ', input.nudges),
    ].filter(Boolean)
    textParts.push('\n' + secs.join('\n'))
    if (!input.usedLlm && input.escalations.length > 0) {
      textParts.push('LLM-помощник выключен — неоднозначное не угадывалось, оно в «тебе решать».')
    }
    if (input.leaveCount > 0) textParts.push(`Ещё ${input.leaveCount} оставлено доске (свежие или уже адресованные живому исполнителю).`)
    if (input.truncated) textParts.push('ВНИМАНИЕ: план построен по ЧАСТИ доски — тикетов больше, чем берётся за заход.')
  }
  const text = textParts.join('\n')

  // ── html ──
  const htmlParts: string[] = [
    `<h2>${esc(subject)}</h2>`,
    `<p style="opacity:.8">Режим: ${esc(modeWord)}.</p>`,
  ]
  if (empty) {
    htmlParts.push('<p>Нечего раздавать, ничего не застряло, решать нечего. Каждый живой тикет либо в работе, либо ждёт очереди.</p>')
  } else {
    htmlParts.push(
      sectionHtml('Тебе решать', input.escalations),
      sectionHtml('Предлагаю раздать', input.assigns),
      sectionHtml('Застряло, подтолкнуть', input.nudges),
    )
    if (!input.usedLlm && input.escalations.length > 0) {
      htmlParts.push('<p style="opacity:.8">LLM-помощник выключен — неоднозначное не угадывалось, оно в «тебе решать».</p>')
    }
    if (input.leaveCount > 0) htmlParts.push(`<p style="opacity:.8">Ещё ${input.leaveCount} оставлено доске (свежие или уже адресованные живому исполнителю).</p>`)
    if (input.truncated) htmlParts.push('<p><b>Внимание:</b> план построен по ЧАСТИ доски — тикетов больше, чем берётся за заход.</p>')
  }
  const html = htmlParts.filter(Boolean).join('\n')

  return { subject, text, html, empty }
}
