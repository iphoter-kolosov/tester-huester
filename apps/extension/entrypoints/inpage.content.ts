import { Ring, patchConsole, wrapFetchXhr, ActionRecorder, assembleBundle, captureEnv } from '@th/core'
import type { ConsoleEntry, NetworkEntry, ActionStep, ReproBundle } from '@th/core'
import { TH_COLLECT, TH_BUNDLE } from '@/lib/bridge'

// Runs in the page's MAIN world at document_start — the only place we can see the app's OWN console output
// and fetch/XHR traffic (an isolated content script gets its own console/fetch, not the page's). It keeps
// bounded rings of console + network + user actions and, on request from the ISOLATED overlay, replies with
// an assembled repro bundle. No chrome.* APIs are used here (they don't exist in the MAIN world).
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    const consoleRing = new Ring<ConsoleEntry>(200)
    const networkRing = new Ring<NetworkEntry>(200)
    const actionRing = new Ring<ActionStep>(100)

    // Each wrapper guards itself; a failure to instrument one stream must never break the page or the others.
    try {
      patchConsole(consoleRing, console, window)
    } catch {}
    try {
      wrapFetchXhr(networkRing, window)
    } catch {}
    try {
      new ActionRecorder(actionRing, document).start()
    } catch {}

    window.addEventListener('message', (e) => {
      if (e.source !== window) return
      const d = e.data as { __th?: string; reqId?: string } | null
      if (!d || d.__th !== TH_COLLECT) return
      let bundle: ReproBundle | null = null
      try {
        bundle = assembleBundle({ env: captureEnv(window), console: consoleRing, network: networkRing, actions: actionRing })
      } catch {
        bundle = null
      }
      window.postMessage({ __th: TH_BUNDLE, reqId: d.reqId, bundle }, '*')
    })
  },
})
