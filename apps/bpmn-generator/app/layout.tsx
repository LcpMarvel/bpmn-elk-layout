import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'BPMN Generator',
  description: 'AI-powered BPMN diagram generator using DeepSeek',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  )
}
