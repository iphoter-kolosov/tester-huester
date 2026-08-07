import { getConfig, setConfig, DEFAULTS } from '@/lib/config'

const url = document.getElementById('url') as HTMLInputElement
const key = document.getElementById('key') as HTMLInputElement
const replay = document.getElementById('replay') as HTMLInputElement
const hint = document.getElementById('hint') as HTMLElement

getConfig().then((c) => {
  url.value = c.collectorUrl
  key.value = c.ingestKey
  replay.checked = c.recordReplay
})

document.getElementById('save')!.addEventListener('click', async () => {
  await setConfig({
    collectorUrl: url.value.trim() || DEFAULTS.collectorUrl,
    ingestKey: key.value.trim() || DEFAULTS.ingestKey,
    recordReplay: replay.checked,
  })
  hint.innerHTML = 'Saved <span class="ok">✓</span> — reload open tabs for replay changes to take effect'
})

document.getElementById('capture')!.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'TH_CAPTURE' })
  window.close() // let the tab (and its overlay) take over
})

// The standalone editor window: captures the active tab and opens the report in a window the site under test
// cannot disturb. The popup closes immediately — it would be dismissed by the new window's focus anyway.
document.getElementById('editor')!.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'TH_EDITOR_OPEN', fresh: true })
  window.close()
})
