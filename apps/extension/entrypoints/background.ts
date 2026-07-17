// Two jobs: (1) screenshot the visible tab on the shortcut / popup button and hand it to the page's overlay;
// (2) forward the finished report to the collector from the EXTENSION context — background fetches are not
// subject to the page's CSP, so the POST works on any site.
export default defineBackground(() => {
  async function capture(tabId?: number) {
    let shot: string
    try {
      shot = await chrome.tabs.captureVisibleTab({ format: 'png' })
    } catch (e) {
      console.warn('[th] capture failed:', e)
      return
    }
    let id = tabId
    if (id == null) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      id = tab?.id
    }
    if (id != null) chrome.tabs.sendMessage(id, { type: 'TH_OPEN', shot }).catch(() => {})
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
