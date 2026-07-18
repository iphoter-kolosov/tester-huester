'use client'

import { useEffect, useRef, useState } from 'react'
import 'rrweb/dist/style.css'

// Replays the captured rrweb DOM stream — the human half of the "last 2 minutes". Uses rrweb's Replayer
// engine directly (rock-solid) with a small custom controller; the rrweb-player Svelte wrapper doesn't mount
// cleanly under React Strict Mode. Progress is tracked from wall-clock elapsed (the replay runs at 1×),
// because this rrweb build's getCurrentTime() is unreliable. Client-only + lazy-loaded (Replayer needs window).
type Replayerish = {
  getMetaData: () => { totalTime: number }
  play: (offset?: number) => void
  pause: (offset?: number) => void
  on: (ev: string, cb: () => void) => void
  destroy?: () => void
}

const fmt = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export default function ReplayPlayer({ url }: { url: string }) {
  const host = useRef<HTMLDivElement>(null)
  const rep = useRef<Replayerish | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null) // setInterval, not rAF — rAF pauses when the tab is hidden
  const startWall = useRef(0) // performance.now() when the current play began
  const startOffset = useRef(0) // replay offset (ms) the current play began at
  const totalRef = useRef(0)
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading')
  const [playing, setPlaying] = useState(false)
  const [total, setTotal] = useState(0)
  const [cur, setCur] = useState(0)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`fetch ${res.status}`)
        const data = (await res.json()) as { events?: unknown[] }
        const events = data.events ?? []
        if (cancelled) return
        if (events.length < 2) return setState('empty')

        const { Replayer } = await import('rrweb')
        if (cancelled || !host.current) return
        host.current.innerHTML = ''
        const replayer = new Replayer(events as never, { root: host.current, skipInactive: true, mouseTail: false }) as unknown as Replayerish
        rep.current = replayer
        replayer.pause(0) // first frame, paused
        const t = replayer.getMetaData().totalTime
        totalRef.current = t
        setTotal(t)
        replayer.on('finish', () => {
          if (cancelled) return
          if (timer.current) clearInterval(timer.current)
          setPlaying(false)
          setCur(totalRef.current)
        })

        // rrweb renders at the recorded viewport size; scale the wrapper to fit our panel width.
        const wrapper = host.current.querySelector('.replayer-wrapper') as HTMLElement | null
        const iframe = wrapper?.querySelector('iframe') as HTMLIFrameElement | null
        if (wrapper && iframe) {
          const scale = Math.min(1, (host.current.clientWidth || 900) / (iframe.offsetWidth || 1280))
          wrapper.style.transform = `scale(${scale})`
          wrapper.style.transformOrigin = 'top left'
          host.current.style.height = `${Math.round((iframe.offsetHeight || 720) * scale)}px`
        }
        setState('ready')
      } catch {
        if (!cancelled) setState('error')
      }
    })()

    return () => {
      cancelled = true
      if (timer.current) clearInterval(timer.current)
      try {
        rep.current?.pause()
        rep.current?.destroy?.()
      } catch {}
      rep.current = null
    }
  }, [url])

  const tick = () => {
    const elapsed = startOffset.current + (performance.now() - startWall.current)
    if (elapsed >= totalRef.current) {
      if (timer.current) clearInterval(timer.current)
      setCur(totalRef.current)
      setPlaying(false)
      rep.current?.pause(totalRef.current)
      return
    }
    setCur(elapsed)
  }
  const play = (from: number) => {
    const r = rep.current
    if (!r) return
    startOffset.current = from
    startWall.current = performance.now()
    r.play(from)
    setPlaying(true)
    if (timer.current) clearInterval(timer.current)
    timer.current = setInterval(tick, 100)
  }
  const pause = () => {
    if (timer.current) clearInterval(timer.current)
    rep.current?.pause()
    setPlaying(false)
  }
  const toggle = () => (playing ? pause() : play(cur >= total ? 0 : cur))
  const seek = (ms: number) => {
    setCur(ms)
    if (playing) play(ms)
    else rep.current?.pause(ms)
  }

  return (
    <div className="replay">
      <div className="replayhead">
        <span className="ctxttl">▶ Session replay</span>
        <span className="replaymeta">last ~2 min · inputs masked{state === 'loading' ? ' · loading…' : ''}</span>
      </div>
      {state === 'empty' && <div className="ctxempty">Replay was captured but has no playable frames.</div>}
      {state === 'error' && <div className="ctxempty">Could not load the replay.</div>}
      <div style={{ display: state === 'ready' || state === 'loading' ? 'block' : 'none' }}>
        <div ref={host} className="replaybox" />
        {state === 'ready' && (
          <div className="rc">
            <button className="rcbtn" onClick={toggle}>{playing ? '⏸' : '▶'}</button>
            <span className="rct">{fmt(cur)}</span>
            <input className="rcrange" type="range" min={0} max={Math.max(1, total)} value={Math.min(cur, total)} onChange={(e) => seek(Number(e.target.value))} />
            <span className="rct">{fmt(total)}</span>
          </div>
        )}
      </div>
    </div>
  )
}
