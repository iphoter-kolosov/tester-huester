import './globals.css'
import type { ReactNode } from 'react'

export const metadata = {
  icons: { icon: '/logo.svg' },
  title: 'tester-huester',
  description: 'Capture QA notes on any site — dashboard, API, MCP.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
