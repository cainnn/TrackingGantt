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
      <body>
        <StoreProvider>{children}</StoreProvider>
      </body>
    </html>
  )
}
