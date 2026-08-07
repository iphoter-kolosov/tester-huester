import { defineConfig } from 'wxt'

export default defineConfig({
  // Force ASCII-only JS output. A bundled dependency (PostCSS, pulled in transitively) embeds a raw U+FFFE
  // noncharacter in its BOM-detection code; Chrome rejects any content script containing U+FFFE/U+FFFF as
  // "isn't UTF-8 encoded". `charset: 'ascii'` escapes every non-ASCII code point to \uXXXX (identical string
  // values, including our Cyrillic labels and emoji), so content.js is pure ASCII and loads cleanly.
  vite: () => ({
    esbuild: { charset: 'ascii' },
    build: { minify: 'esbuild' },
  }),
  manifest: {
    name: 'tester-huester',
    description: 'Capture a QA note (screenshot + drawing) on any site → your dashboard.',
    // tabCapture + offscreen: record the tab as an actual VIDEO stream (webm) rather than a DOM event log.
    // A DOM replay reconstructs markup, which is useless for the behavioural bugs this tool exists to capture.
    // unlimitedStorage: a capture draft (see lib/draft.ts) holds a 1–3 MB base screenshot plus stills sampled
    // from the recording. The default 10 MB storage.local quota would start rejecting writes — and a draft
    // that fails to save is exactly the data loss the draft store exists to prevent.
    permissions: ['activeTab', 'tabs', 'storage', 'unlimitedStorage', 'scripting', 'tabCapture', 'offscreen'],
    host_permissions: ['<all_urls>'],
    commands: {
      capture: {
        suggested_key: { default: 'Ctrl+Shift+Y' },
        description: 'Capture a QA note on this page',
      },
      // The standalone editor window (entrypoints/editor). Ctrl+Shift+U is free: it does not collide with the
      // capture shortcut above, and Chrome reserves none of it. Pressing it captures the active tab and opens
      // the window with that frame already loaded; pressing it again adds the new frame to the open window.
      open_editor: {
        suggested_key: { default: 'Ctrl+Shift+U' },
        description: 'Open the ticket editor in a separate window',
      },
    },
  },
})
