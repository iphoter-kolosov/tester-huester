'use client'

// A real recording of the tab. Nothing to reconstruct, nothing to go wrong: the browser plays the pixels the
// tester saw. This replaced the DOM replay as the primary artefact — on app-heavy pages a reconstructed DOM
// played back as an unrecognisable layer with a moving cursor, which is worse than no recording at all.
export default function VideoPlayer({ url, seconds }: { url: string; seconds?: number | null }) {
  const dur = seconds ? `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}` : null
  return (
    <div className="replay">
      <div className="replayhead">
        <span className="ctxttl">🎥 Запись экрана</span>
        <span className="replaymeta">
          {dur ? `${dur} · ` : ''}видео вкладки
          <a className="vdl" href={url} download>
            скачать
          </a>
        </span>
      </div>
      <video className="vplayer" src={url} controls preload="metadata" playsInline />
    </div>
  )
}
