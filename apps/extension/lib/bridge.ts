import type { ReproBundle } from '@th/core'

// window.postMessage bridge between the ISOLATED overlay content script and the MAIN-world collector script.
// They share the page's DOM window, so a message posted on one is seen by both worlds' listeners.
export const TH_COLLECT = 'TH_COLLECT'
export const TH_BUNDLE = 'TH_BUNDLE'

let seq = 0

// ISOLATED side: ask the MAIN-world collector for the current repro bundle (a snapshot of the console /
// network / action rings). Resolves null if the MAIN world isn't present or doesn't answer in time.
export function requestBundle(timeoutMs = 700): Promise<ReproBundle | null> {
  return new Promise((resolve) => {
    const reqId = `${Date.now()}-${seq++}`
    let done = false
    const finish = (b: ReproBundle | null) => {
      if (done) return
      done = true
      window.removeEventListener('message', onMsg)
      resolve(b)
    }
    const onMsg = (e: MessageEvent) => {
      if (e.source !== window) return
      const d = e.data as { __th?: string; reqId?: string; bundle?: ReproBundle | null } | null
      if (d && d.__th === TH_BUNDLE && d.reqId === reqId) finish(d.bundle ?? null)
    }
    window.addEventListener('message', onMsg)
    window.postMessage({ __th: TH_COLLECT, reqId }, '*')
    setTimeout(() => finish(null), timeoutMs)
  })
}
