import { getConfig, setConfig, DEFAULTS } from '@/lib/config'

const url = document.getElementById('url') as HTMLInputElement
const key = document.getElementById('key') as HTMLInputElement
const hint = document.getElementById('hint') as HTMLElement

getConfig().then((c) => {
  url.value = c.collectorUrl
  key.value = c.ingestKey
})

document.getElementById('save')!.addEventListener('click', async () => {
  await setConfig({
    collectorUrl: url.value.trim() || DEFAULTS.collectorUrl,
    ingestKey: key.value.trim() || DEFAULTS.ingestKey,
  })
  hint.innerHTML = 'Saved <span class="ok">✓</span>'
})

document.getElementById('capture')!.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'TH_CAPTURE' })
  window.close() // let the tab (and its overlay) take over
})
