import s from './ticket.module.css'

// Кадры, нарезанные из записи при захвате. Они лежали в базе и отдавались агентам по API с самого начала, а
// человеку не показывались ни разу — при том что именно по ним видно, что произошло, БЕЗ проигрывания видео.
//
// Полоса, а не сетка: кадры идут по времени, и порядок здесь — само содержание.

export type VideoFrame = { at: number; url: string }

function stamp(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export default function VideoFrames({ frames }: { frames: readonly VideoFrame[] }) {
  if (!frames.length) return null
  return (
    <div className={s.frames}>
      {frames.map((f) => (
        <a className={s.frame} key={`${f.at}-${f.url}`} href={f.url} target="_blank" rel="noreferrer" title={`Кадр на ${stamp(f.at)} — открыть в полный размер`}>
          <img className={s.frameimg} src={f.url} alt="" loading="lazy" />
          <span className={s.frameat}>{stamp(f.at)}</span>
        </a>
      ))}
    </div>
  )
}
