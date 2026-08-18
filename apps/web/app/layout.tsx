import './globals.css'
import type { ReactNode } from 'react'

export const metadata = {
  icons: { icon: '/logo.svg' },
  title: 'tester-huester',
  description: 'Доска задач и багов: тикеты, агенты, приёмка работы.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  // lang="ru": интерфейс русский целиком, и переносы, кавычки и озвучка должны это знать.
  return (
    <html lang="ru">
      <head>
        {/* Шрифты лежат у нас, а не на чужом CDN. Предзагружаются только кириллические подмножества:
            ими набран весь интерфейс, латиница подтягивается сама, когда встретится. */}
        <link rel="preload" href="/fonts/plex-sans-cyrillic.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href="/fonts/literata-cyrillic.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
      </head>
      <body>{children}</body>
    </html>
  )
}
