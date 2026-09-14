/** Server-side session access. Node runtime only — it uses node:crypto. */
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { PrismaClient } from '@prisma/client'
import { SESSION_COOKIE, decodeSession, type Role } from './auth'

const prisma = new PrismaClient()

export interface CurrentUser {
  id: number
  name: string
  email: string
  role: Role
}

export async function currentUser(): Promise<CurrentUser | null> {
  const store = await cookies()
  const session = decodeSession(store.get(SESSION_COOKIE)?.value)
  if (!session) return null

  const user = await prisma.appUser.findUnique({ where: { id: session.userId } })
  // A deactivated account must lose access immediately, not when its cookie
  // happens to expire.
  if (!user || !user.active) return null

  return { id: user.id, name: user.name, email: user.email, role: user.role as Role }
}

export async function requireUser(): Promise<CurrentUser> {
  const user = await currentUser()
  if (!user) redirect('/login')
  return user
}

/** Entry and confirmation are STAFF-only; MANAGER is read-only throughout. */
export async function requireStaff(): Promise<CurrentUser> {
  const user = await requireUser()
  if (user.role !== 'STAFF') redirect('/?denied=1')
  return user
}
