import Link from 'next/link'
import { notFound } from 'next/navigation'
import { shiftMonth } from '@/lib/clock'
import { loadMonth } from '@/lib/monthly'
import { requireUser } from '@/lib/session'
import { canWrite } from '@/lib/auth'
import { MonthlyForm } from '@/components/monthly-form'

export const dynamic = 'force-dynamic'

const VALID = /^\d{4}-\d{2}$/

const pretty = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-MY', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  })

export default async function MonthlyPage({ params }: { params: Promise<{ month: string }> }) {
  const { month } = await params
  if (!VALID.test(month)) notFound()

  const user = await requireUser()
  const data = await loadMonth(month)
  const has = new Set(data.monthsWithData)

  return (
    <main>
      <div className="daynav">
        <Link href={`/monthly/${shiftMonth(month, -1)}` as never} className="linkish">‹ Previous</Link>
        <h1>{pretty(month)}</h1>
        <Link href={`/monthly/${shiftMonth(month, 1)}` as never} className="linkish">Next ›</Link>
      </div>

      <p className="sub">
        Monthly inputs. Everything else in this system is keyed daily; these two
        arrive once a month, and inventing a daily figure for them would put a
        made-up number where a keyed one should be.
      </p>

      {/* Which months already have figures, at a glance — the same reason the
          daily screen shows a calendar. */}
      <nav className="calendar" aria-label="Months entered">
        {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => {
          const m = `${month.slice(0, 4)}-${String(n).padStart(2, '0')}`
          const cls = ['day', m === month ? 'current' : '', has.has(m) ? 'has-data' : 'missing']
            .filter(Boolean)
            .join(' ')
          return (
            <Link key={m} href={`/monthly/${m}` as never} className={cls}>
              {new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-MY', {
                month: 'short', timeZone: 'UTC',
              })}
            </Link>
          )
        })}
      </nav>

      <MonthlyForm data={data} canWrite={canWrite(user.role)} />
    </main>
  )
}
