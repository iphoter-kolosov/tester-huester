// Two jobs: (1) screenshot the visible tab on the shortcut / popup button and hand it to the page's overlay;
// (2) forward the finished report to the collector from the EXTENSION context — background fetches are not
// subject to the page's CSP, so the POST works on any site.
export default defineBackground(() => {
  // Send TH_OPEN to the tab's content script. If it isn't there (the tab was opened BEFORE the extension
  // loaded, so the declarative content script never ran), inject it on demand and retry — capture then works
  // on any already-open tab without a manual page reload.
  // Both halves of the capture pair must be injected: the ISOLATED overlay/recorder (content.js) and the
  // MAIN-world probe (inpage.js) that owns the page's real console/fetch/XHR and the user's action trail.
  // Injecting only content.js yields reports with a screenshot but no repro context — which is exactly what a
  // tab that outlived an extension reload produced.
  async function injectPair(tabId: number) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content-scripts/content.js'] })
    try {
      await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['content-scripts/inpage.js'] })
    } catch (e) {
      console.warn('[th] MAIN-world probe injection failed (repro context will be missing):', e)
    }
  }

  async function openOverlay(tabId: number, shot: string) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'TH_OPEN', shot })
    } catch {
      try {
        await injectPair(tabId)
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

  // After an install / update / browser start, the declarative content script is NOT retro-injected into
  // already-open tabs — so replay recording would only begin once each tab is navigated or reloaded, which is
  // exactly why a capture right after reloading the extension shows an empty replay. Warm every open http(s)
  // tab up by injecting the content script now, so rrweb starts buffering immediately everywhere. The content
  // script's own load guard makes a redundant injection a no-op.
  async function warmUpAllTabs() {
    let tabs: chrome.tabs.Tab[]
    try {
      tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] })
    } catch {
      return
    }
    await Promise.all(
      tabs.map(async (t) => {
        if (t.id == null) return
        try {
          await injectPair(t.id)
        } catch {
          // restricted tabs (Web Store, chrome://, PDF viewer, …) can't be injected — skip silently
        }
      }),
    )
  }
  chrome.runtime.onInstalled.addListener(() => void warmUpAllTabs())
  chrome.runtime.onStartup.addListener(() => void warmUpAllTabs())

  // ── real video recording of the tab ──────────────────────────────────────────────────────────────────
  // getMediaStreamId must be called from the extension (not a content script), and the stream itself has to
  // live in an offscreen document because a service worker cannot hold one. This is what produces an actual
  // webm of what the tester saw, instead of a DOM event log.
  async function ensureOffscreen(): Promise<void> {
    const has = await chrome.offscreen?.hasDocument?.()
    if (has) return
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Recording the tab to a video file for a bug report',
    })
  }

  async function startVideo(tabId: number, maxSeconds?: number, collectorUrl?: string) {
    try {
      await ensureOffscreen()
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId })
      return await chrome.runtime.sendMessage({ type: 'TH_OFF_START', streamId, maxSeconds, collectorUrl })
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message || e) }
    }
  }

  async function stopVideo() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'TH_OFF_STOP' })
      try { await chrome.offscreen?.closeDocument?.() } catch {}
      return res
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message || e) }
    }
  }

  // ── the standalone editor window ─────────────────────────────────────────────────────────────────────
  // A separate browser window is not part of the page, so a dev server reloading the site cannot touch the
  // report being written in it. That is the whole architectural point, and everything below exists to keep it
  // true: the window owns the work, the tab is only a source of pictures and video.
  const EDITOR_PAGE = 'editor.html'
  const SEED_KEY = 'th.editorSeed' // one freshly captured frame, handed to a window that may not exist yet
  const WIN_KEY = 'th.editorWin' // remembered size/position (and the live window id) between opens
  const DEFAULT_W = 1200
  const DEFAULT_H = 840
  const MIN_W = 900
  const MIN_H = 560

  type WinGeom = { id?: number; left?: number; top?: number; width: number; height: number }

  async function readGeom(): Promise<WinGeom | null> {
    const got = await chrome.storage.local.get(WIN_KEY)
    const g = got[WIN_KEY] as WinGeom | undefined
    return g && Number.isFinite(g.width) && Number.isFinite(g.height) ? g : null
  }

  // The window id lives in the same record so a restarted service worker still finds the window the tester
  // has open instead of stacking a second one on top of it.
  async function liveEditorWindow(): Promise<number | null> {
    const g = await readGeom()
    if (g?.id == null) return null
    try {
      await chrome.windows.get(g.id)
      return g.id
    } catch {
      return null
    }
  }

  async function rememberWindow(id: number | null, bounds?: chrome.windows.Window): Promise<void> {
    const g = (await readGeom()) ?? { width: DEFAULT_W, height: DEFAULT_H }
    const next: WinGeom = {
      ...g,
      id: id ?? undefined,
      left: bounds?.left ?? g.left,
      top: bounds?.top ?? g.top,
      width: Math.max(MIN_W, bounds?.width ?? g.width),
      height: Math.max(MIN_H, bounds?.height ?? g.height),
    }
    await chrome.storage.local.set({ [WIN_KEY]: next })
  }

  chrome.windows.onBoundsChanged.addListener((win) => {
    void (async () => {
      const id = await liveEditorWindow()
      if (id === win.id) await rememberWindow(id, win)
    })()
  })
  chrome.windows.onRemoved.addListener((id) => {
    void (async () => {
      const g = await readGeom()
      if (g?.id === id) await chrome.storage.local.set({ [WIN_KEY]: { ...g, id: undefined } })
    })()
  })

  // Ask the page's overlay (if one is on screen) to write everything it holds into the draft and step aside.
  // Two writers on one draft key is precisely the data loss this stage removes, so this is awaited before the
  // window is allowed to read it.
  async function handOverFromOverlay(tabId: number): Promise<void> {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'TH_ED_TAKEOVER' }, { frameId: 0 })
    } catch {
      // No content script (a restricted page, or a tab older than the extension) — nothing to hand over.
    }
  }

  async function openEditor(tabId?: number, fresh = true): Promise<void> {
    let tab: chrome.tabs.Tab | undefined
    if (tabId == null) [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    else tab = await chrome.tabs.get(tabId).catch(() => undefined)
    if (!tab?.id) return

    const pageUrl = tab.url ?? ''
    let origin = ''
    try {
      origin = new URL(pageUrl).origin
    } catch {
      console.warn('[th] this page has no usable origin, the editor cannot keep a draft for it:', pageUrl)
      return
    }

    await handOverFromOverlay(tab.id)

    let shot = ''
    if (fresh) {
      // captureVisibleTab photographs whatever is VISIBLE in the window — a tab sitting in the background
      // would hand back a picture of a different page, which is worse than no picture.
      if (tab.active) {
        shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }).catch((e) => {
          console.warn('[th] screenshot failed (restricted page?):', e)
          return ''
        })
      } else {
        console.warn('[th] the target tab is not visible; the editor opens without a fresh frame')
      }
    }

    await chrome.storage.local.set({ [SEED_KEY]: { shot, tabId: tab.id, origin, pageUrl, at: Date.now() } })

    const existing = await liveEditorWindow()
    if (existing != null) {
      await chrome.windows.update(existing, { focused: true, drawAttention: true })
      // The window is already loaded, so it will not run its startup seed read again — poke it.
      chrome.runtime.sendMessage({ type: 'TH_ED_SEED' }).catch(() => {})
      return
    }

    const url = `${EDITOR_PAGE}?tab=${tab.id}&origin=${encodeURIComponent(origin)}&url=${encodeURIComponent(pageUrl)}`
    const g = await readGeom()
    // No remembered geometry yet: size the window from the browser window it was launched from, so it lands
    // on the same screen and inside it on a laptop as well as on a 4K monitor.
    const host = await chrome.windows.get(tab.windowId).catch(() => undefined)
    const width = Math.max(MIN_W, g?.width ?? Math.min(DEFAULT_W, (host?.width ?? DEFAULT_W) - 80))
    const height = Math.max(MIN_H, g?.height ?? Math.min(DEFAULT_H, (host?.height ?? DEFAULT_H) - 60))
    const created = await chrome.windows.create({
      url: chrome.runtime.getURL(url),
      type: 'popup',
      focused: true,
      width,
      height,
      left: g?.left ?? (host?.left ?? 0) + 40,
      top: g?.top ?? (host?.top ?? 0) + 40,
    })
    if (created?.id != null) await rememberWindow(created.id, created)
  }

  chrome.commands.onCommand.addListener((cmd) => {
    if (cmd === 'capture') capture()
    else if (cmd === 'open_editor') void openEditor()
  })

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'TH_CAPTURE') {
      capture()
      return
    }
    if (msg?.type === 'TH_SHOT') {
      // Screenshot for the explicit "record repro" flow: the content script asks for a fresh frame when the
      // tester presses Stop, then reopens the overlay with it + the recorded clip.
      // The editor WINDOW has no sender.tab, so it names the tab explicitly — and a tab that is not the
      // visible one is refused by name rather than photographed as whatever is in front of it.
      if (msg.tabId != null) {
        void (async () => {
          try {
            const t = await chrome.tabs.get(msg.tabId as number)
            if (!t.active) { sendResponse({ ok: false, error: 'вкладка не на переднем плане' }); return }
            const shot = await chrome.tabs.captureVisibleTab(t.windowId, { format: 'png' })
            sendResponse({ ok: true, shot })
          } catch (e) {
            sendResponse({ ok: false, error: String((e as Error)?.message || e) })
          }
        })()
        return true
      }
      const winId = sender.tab?.windowId
      const shoot = winId != null ? chrome.tabs.captureVisibleTab(winId, { format: 'png' }) : chrome.tabs.captureVisibleTab({ format: 'png' })
      shoot.then((shot) => sendResponse({ ok: true, shot })).catch((e) => sendResponse({ ok: false, error: String(e) }))
      return true
    }
    if (msg?.type === 'TH_CTX') {
      // The editor window cannot reach the page's MAIN-world probe itself; the content script owns that
      // bridge. Frame 0 only — every iframe runs the same script and would answer with its own bundle.
      const tabId = msg.tabId ?? sender.tab?.id
      if (tabId == null) { sendResponse({ ok: false, error: 'no tab' }); return true }
      chrome.tabs
        .sendMessage(tabId, { type: 'TH_CTX' }, { frameId: 0 })
        .then((r) => sendResponse(r ?? { ok: false, error: 'no answer' }))
        .catch((e) => sendResponse({ ok: false, error: String((e as Error)?.message || e) }))
      return true
    }
    if (msg?.type === 'TH_EDITOR_OPEN') {
      // From the overlay's "⇗ Открыть в окне" (fresh: false — the draft already holds the frame) or the popup.
      const tabId = msg.tabId ?? sender.tab?.id
      openEditor(tabId, msg.fresh !== false)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String((e as Error)?.message || e) }))
      return true
    }
    if (msg?.type === 'TH_EDITOR_CLOSE') {
      void (async () => {
        const id = await liveEditorWindow()
        if (id != null) await chrome.windows.remove(id).catch(() => {})
      })()
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
    if (msg?.type === 'TH_VIDEO_START') {
      // sender.tab only exists for a content script. The editor window is an extension page, so it names the
      // tab to record explicitly — without this it would record nothing (or, worse, itself).
      const tabId = msg.tabId ?? sender.tab?.id
      if (tabId == null) { sendResponse({ ok: false, error: 'no tab' }); return true }
      startVideo(tabId, msg.maxSeconds, msg.collectorUrl).then(sendResponse)
      return true
    }
    if (msg?.type === 'TH_VIDEO_STOP') {
      stopVideo().then(sendResponse)
      return true
    }
    if (msg?.type === 'TH_PROJECTS') {
      // The overlay's project picker: list the account's projects. Fetched from the background so it isn't
      // subject to the page's CSP (same reason as TH_SEND).
      const url = `${msg.collectorUrl}/api/projects?ingestKey=${encodeURIComponent(msg.ingestKey || '')}`
      fetch(url, { headers: { Accept: 'application/json' } })
        .then((r) => r.json())
        .then((j) => sendResponse(j))
        .catch((e) => sendResponse({ ok: false, error: String(e) }))
      return true
    }
  })
})
