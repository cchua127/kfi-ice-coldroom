import type { ReactNode } from 'react'
import Link from 'next/link'
import { requireUser } from '@/lib/session'
import { signOut } from '../login/actions'

/** Everything under this layout requires a signed-in user. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser()

  return (
    <>
      <header className="topbar">
        <Link href="/" className="brand">KFI Ice Ops</Link>
        <nav>
          <Link href="/">Dashboard</Link>
          <Link href="/entry">Daily entry</Link>
          <Link href="/bills">TNB bills</Link>
          <Link href="/reports">Reports</Link>
          <Link href="/parallel">Parallel check</Link>
        </nav>
        <form action={signOut} className="whoami">
          <span>
            {user.name}
            <span className="role">{user.role === 'STAFF' ? 'Entry' : 'Read-only'}</span>
          </span>
          <button type="submit" className="linkish">Sign out</button>
        </form>
      </header>
      {children}
    </>
  )
}
