import { describe, it, expect, beforeAll } from 'vitest'
import {
  encodeSession, decodeSession, newSession, hashPassword, verifyPassword,
  canWrite, generatePassword,
} from '@/lib/auth'

beforeAll(() => {
  process.env.AUTH_SECRET = 'test-secret-value-long-enough-to-pass'
})

describe('session tokens', () => {
  it('round-trips a valid session', () => {
    const s = newSession(7, 'STAFF')
    const back = decodeSession(encodeSession(s))
    expect(back).toEqual(s)
  })

  it('rejects a tampered payload', () => {
    // Flip the role in the payload and keep the old signature.
    const token = encodeSession(newSession(7, 'STAFF'))
    const [body, sig] = token.split('.')
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString())
    decoded.role = 'MANAGER'
    const forged = `${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${sig}`
    expect(decodeSession(forged)).toBeNull()
  })

  it('rejects a token signed with a different secret', () => {
    const token = encodeSession(newSession(7, 'STAFF'))
    process.env.AUTH_SECRET = 'a-completely-different-secret-value'
    expect(decodeSession(token)).toBeNull()
    process.env.AUTH_SECRET = 'test-secret-value-long-enough-to-pass'
  })

  it('rejects an expired session', () => {
    const expired = { userId: 1, role: 'STAFF' as const, exp: Math.floor(Date.now() / 1000) - 60 }
    expect(decodeSession(encodeSession(expired))).toBeNull()
  })

  it.each([undefined, '', 'garbage', 'a.b', '.', 'x.'])('rejects %s', (t) => {
    expect(decodeSession(t as string | undefined)).toBeNull()
  })

  it('refuses to sign without a usable secret', () => {
    const saved = process.env.AUTH_SECRET
    process.env.AUTH_SECRET = 'short'
    expect(() => encodeSession(newSession(1, 'STAFF'))).toThrow(/AUTH_SECRET/)
    process.env.AUTH_SECRET = saved
  })
})

describe('passwords', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery')
    expect(await verifyPassword('correct horse battery', hash)).toBe(true)
    expect(await verifyPassword('wrong', hash)).toBe(false)
  })

  it('never stores the password in readable form', async () => {
    const hash = await hashPassword('plaintext-secret')
    expect(hash).not.toContain('plaintext-secret')
    expect(hash.startsWith('$2')).toBe(true)
  })

  it('generates a password with enough entropy to be issued once', () => {
    const a = generatePassword()
    expect(a.length).toBeGreaterThanOrEqual(16)
    expect(a).not.toBe(generatePassword())
  })
})

describe('roles', () => {
  it('makes MANAGER read-only', () => {
    expect(canWrite('STAFF')).toBe(true)
    expect(canWrite('MANAGER')).toBe(false)
  })
})
