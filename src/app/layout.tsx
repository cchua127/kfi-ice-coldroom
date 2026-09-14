import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import './globals.css'

export const metadata: Metadata = {
  title: 'KFI Ice Ops',
  description: 'Ice production, sales and electricity costing — KFI Cold Storage Sdn Bhd',
  icons: { icon: '/favicon.svg' },
  // Internal system on a public host: keep it out of search results.
  robots: { index: false, follow: false },
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
