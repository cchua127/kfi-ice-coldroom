'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { PrismaClient } from '@prisma/client'
import {
  SESSION_COOKIE, encodeSession, newSession, verifyPassword, sessionMaxAge, type Role,
} from '@/lib/auth'

const prisma = new PrismaClient()

export async function signIn(_prev: string | null, formData: FormData): Promise<string | null> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase()
  const password = String(formData.get('password') ?? '')
  if (!email || !password) return 'Enter your email and password.'

  const user = await prisma.appUser.findUnique({ where: { email } })

  // One message for every failure: a wrong password, an unknown address and a
  // deactivated account must be indistinguishable from outside.
  const ok = user?.active ? await verifyPassword(password, user.passwordHash) : false
  if (!user || !ok) return 'Those details do not match an account.'

  await prisma.appUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })

  const store = await cookies()
  store.set(SESSION_COOKIE, encodeSession(newSession(user.id, user.role as Role)), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: sessionMaxAge,
  })
  redirect('/')
}

export async function signOut() {
  const store = await cookies()
  store.delete(SESSION_COOKIE)
  redirect('/login')
}
