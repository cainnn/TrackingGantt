import type { Metadata } from 'next'
import './globals.css'
import { StoreProvider } from '@/store/provider'

export const metadata: Metadata = {
  title: '跟踪甘特图',
  description: '项目进度甘特图管理工具',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <head>
        {/* Bryntum Gantt 7.2.1 library loaded before page scripts */}
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="/lib/gantt/gantt.umd.js" />
      </head>
      <body>
        <StoreProvider>{children}</StoreProvider>
      </body>
    </html>
  )
}
