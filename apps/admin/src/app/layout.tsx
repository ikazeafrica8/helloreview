import type { Metadata, Viewport } from 'next'
import { GeistSans } from 'geist/font/sans'
import './globals.css'

export const metadata: Metadata = {
  title: { default: '운영 콘솔', template: '%s | HelloReview 운영 콘솔' },
  description: 'HelloReview 운영자를 위한 접근 제어 관리 화면',
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#14231c',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko" className={GeistSans.variable}>
      <body>{children}</body>
    </html>
  )
}
