/**
 * Authentication for a handful of named accounts.
 *
 * Three or four people use this system and an admin creates every one of them,
 * so there is no self-registration, no password reset by email, and no account
 * enumeration surface worth having. What matters is that a session cannot be
 * forged and a password cannot be read back out of the database.
 */
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'

export type Role = 'STAFF' | 'MANAGER'

export interface SessionPayload {
  userId: number
  role: Role
  /** Seconds since epoch. */
  exp: number
}

/** Deliberately slow. It is the main defence for a small, named user list. */
const BCRYPT_ROUNDS = 12
const SESSION_DAYS = 7

export const SESSION_COOKIE = 'kfi_session'

export const hashPassword = (plain: string): Promise<string> =>
  bcrypt.hash(plain, BCRYPT_ROUNDS)

export const verifyPassword = (plain: string, hash: string): Promise<boolean> =>
  bcrypt.compare(plain, hash)

function secret(): string {
  const s = process.env.AUTH_SECRET
  if (!s || s.length < 16) {
    throw new Error(
      'AUTH_SECRET is missing or too short. Generate one with: openssl rand -base64 32'
    )
  }
  return s
}

const b64url = (b: Buffer) => b.toString('base64url')

function sign(body: string): string {
  return b64url(createHmac('sha256', secret()).update(body).digest())
}

/** `<payload>.<signature>`, both base64url. */
export function encodeSession(payload: SessionPayload): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)))
  return `${body}.${sign(body)}`
}

/**
 * Returns null for anything that is not a valid, unexpired, correctly signed
 * session. Signature comparison is constant-time.
 */
export function decodeSession(token: string | undefined): SessionPayload | null {
  if (!token) return null
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null

  const body = token.slice(0, dot)
  const given = token.slice(dot + 1)
  const expected = sign(body)

  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString()) as SessionPayload
    if (typeof parsed.userId !== 'number' || typeof parsed.exp !== 'number') return null
    if (parsed.role !== 'STAFF' && parsed.role !== 'MANAGER') return null
    if (parsed.exp * 1000 < Date.now()) return null
    return parsed
  } catch {
    return null
  }
}

export const newSession = (userId: number, role: Role): SessionPayload => ({
  userId,
  role,
  exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400,
})

export const sessionMaxAge = SESSION_DAYS * 86400

/** MANAGER is read-only: dashboard and reports, never entry or confirmation. */
export const canWrite = (role: Role): boolean => role === 'STAFF'

export const generatePassword = (): string => randomBytes(12).toString('base64url')
