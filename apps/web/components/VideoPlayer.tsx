'use client'
import { useEffect, useRef } from 'react'

// A real recording of the tab. Nothing to reconstruct, nothing to go wrong: the browser plays the pixels the
// tester saw. `trim` is the stretch they selected in the extension's editor — playback is confined to it, so
// the reader lands on the moment that matters instead of the whole run-up. The full file stays downloadable.
export default function VideoPlayer({
  url,
  seconds,
  trim,
}: {
  url: string
  seconds?: number | null
  trim?: { from: number; to: number } | null
}) {
  const ref = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const v = ref.current
    if (!v || !trim) return
    const onMeta = () => { v.currentTime = trim.from }
    const onTime = () => {
      if (v.currentTime < trim.from - 0.2) v.currentTime = trim.from
      if (v.currentTime >= trim.to) { v.pause(); v.currentTime = trim.to }
    }
    v.addEventListener('loadedmetadata', onMeta)
    v.addEventListener('timeupdate', onTime)
    return () => {
      v.removeEventListener('loadedmetadata', onMeta)
      v.removeEventListener('timeupdate', onTime)
    }
  }, [trim])

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
  const shown = trim ? Math.max(0, trim.to - trim.from) : seconds || 0

  return (
    <div className="replay">
      <div className="replayhead">
        <span className="ctxttl">🎥 Запись экрана</span>
        <span className="replaymeta">
          {shown ? `${fmt(shown)} · ` : ''}
          {trim ? `отрезок ${fmt(trim.from)}–${fmt(trim.to)}` : 'видео вкладки'}
          <a className="vdl" href={url} download>
            скачать
          </a>
        </span>
      </div>
      <video ref={ref} className="vplayer" src={url} controls preload="metadata" playsInline />
    </div>
  )
}
