// Two jobs: (1) screenshot the visible tab on the shortcut / popup button and hand it to the page's overlay;
// (2) forward the finished report to the collector from the EXTENSION context — background fetches are not
// subject to the page's CSP, so the POST works on any site.
export default defineBackground(() => {
  // Send TH_OPEN to the tab's content script. If it isn't there (the tab was opened BEFORE the extension
  // loaded, so the declarative content script never ran), inject it on demand and retry — capture then works
  // on any already-open tab without a manual page reload.
  async function openOverlay(tabId: number, shot: string) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'TH_OPEN', shot })
    } catch {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content-scripts/content.js'] })
        await chrome.tabs.sendMessage(tabId, { type: 'TH_OPEN', shot })
      } catch (e) {
        console.warn('[th] could not open the overlay on this tab (a restricted page like the New Tab, the Web Store, or brave://* cannot be captured):', e)
      }
    }
  }

  async function capture(tabId?: number) {
    let id = tabId
    if (id == null) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      id = tab?.id
    }
    if (id == null) return
    let shot: string
    try {
      shot = await chrome.tabs.captureVisibleTab({ format: 'png' })
    } catch (e) {
      console.warn('[th] screenshot failed (restricted page?):', e)
      return
    }
    await openOverlay(id, shot)
  }

  chrome.commands.onCommand.addListener((cmd) => {
    if (cmd === 'capture') capture()
  })

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'TH_CAPTURE') {
      capture()
      return
    }
    if (msg?.type === 'TH_SEND') {
      fetch(`${msg.collectorUrl}/api/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(msg.payload),
      })
        .then((r) => r.json())
        .then((j) => sendResponse(j))
        .catch((e) => sendResponse({ ok: false, error: String(e) }))
      return true // keep the message channel open for the async response
    }
  })
})
