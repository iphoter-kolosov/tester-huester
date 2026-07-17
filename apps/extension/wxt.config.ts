import { defineConfig } from 'wxt'

export default defineConfig({
  manifest: {
    name: 'tester-huester',
    description: 'Capture a QA note (screenshot + drawing) on any site → your dashboard.',
    permissions: ['activeTab', 'tabs', 'storage'],
    host_permissions: ['<all_urls>'],
    commands: {
      capture: {
        suggested_key: { default: 'Ctrl+Shift+Y' },
        description: 'Capture a QA note on this page',
      },
    },
  },
})
