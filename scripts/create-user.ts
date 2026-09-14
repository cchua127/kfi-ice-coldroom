/**
 * Create or update an account. There is no self-registration: every account is
 * made here by an administrator.
 *
 *   npx tsx scripts/create-user.ts --email a@b.com --name "Siti" --role STAFF
 *   npx tsx scripts/create-user.ts --email a@b.com --reset
 *   npx tsx scripts/create-user.ts --email a@b.com --deactivate
 *
 * Omit --password and one is generated and printed once. It is never stored in
 * readable form and cannot be shown again.
 */
import { PrismaClient } from '@prisma/client'
import { hashPassword, generatePassword } from '../src/lib/auth'

const prisma = new PrismaClient()
const args = process.argv.slice(2)
const arg = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : null)
const flag = (k: string) => args.includes(k)

async function main() {
  const email = arg('--email')?.trim().toLowerCase()
  if (!email) throw new Error('--email is required')

  if (flag('--deactivate')) {
    await prisma.appUser.update({ where: { email }, data: { active: false } })
    console.log(`${email} deactivated. Existing sessions stop working immediately.`)
    return
  }

  const role = (arg('--role') ?? 'STAFF').toUpperCase()
  if (role !== 'STAFF' && role !== 'MANAGER') throw new Error('--role must be STAFF or MANAGER')

  const password = arg('--password') ?? generatePassword()
  const passwordHash = await hashPassword(password)
  const existing = await prisma.appUser.findUnique({ where: { email } })

  if (existing) {
    await prisma.appUser.update({
      where: { email },
      data: { passwordHash, active: true, ...(arg('--name') ? { name: arg('--name')! } : {}), role },
    })
    console.log(`Updated ${email} (${role}).`)
  } else {
    const name = arg('--name')
    if (!name) throw new Error('--name is required for a new account')
    await prisma.appUser.create({ data: { email, name, role, passwordHash } })
    console.log(`Created ${email} (${role}).`)
  }

  if (!arg('--password')) {
    console.log(`\n  Password: ${password}\n`)
    console.log('Give this to them directly. It is not stored in readable form and')
    console.log('cannot be shown again — use --reset to issue a new one.')
  }
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1) }).finally(() => prisma.$disconnect())
