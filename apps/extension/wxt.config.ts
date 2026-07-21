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
    permissions: ['activeTab', 'tabs', 'storage', 'scripting'],
    host_permissions: ['<all_urls>'],
    commands: {
      capture: {
        suggested_key: { default: 'Ctrl+Shift+Y' },
        description: 'Capture a QA note on this page',
      },
    },
  },
})
