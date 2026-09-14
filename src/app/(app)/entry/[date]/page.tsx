import Link from 'next/link'
import { notFound } from 'next/navigation'
import { loadDay, nextDay, prevDay } from '@/lib/entry'
import { requireUser } from '@/lib/session'
import { canWrite } from '@/lib/auth'
import { EntryForm } from '@/components/entry-form'

export const dynamic = 'force-dynamic'

const VALID = /^\d{4}-\d{2}-\d{2}$/

const pretty = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-MY', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  })

export default async function EntryPage({ params }: { params: Promise<{ date: string }> }) {
  const { date } = await params
  if (!VALID.test(date) || Number.isNaN(Date.parse(date))) notFound()

  const user = await requireUser()
  const day = await loadDay(date)

  const [y, m] = date.split('-').map(Number)
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const today = new Date().toISOString().slice(0, 10)
  const withData = new Set(day.monthDaysWithData)
  const thisDay = Number(date.slice(8, 10))

  return (
    <main>
      <div className="daynav">
        <Link href={`/entry/${prevDay(date)}`} className="linkish">‹ Previous</Link>
        <h1>{pretty(date)}</h1>
        <Link href={`/entry/${nextDay(date)}`} className="linkish">Next ›</Link>
      </div>

      {/* Missing days are visible at a glance rather than discovered at month end. */}
      <nav className="calendar" aria-label="Days this month">
        {Array.from({ length: daysInMonth }, (_, i) => i + 1).map((n) => {
          const iso = `${date.slice(0, 7)}-${String(n).padStart(2, '0')}`
          const future = iso > today
          const cls = [
            'day',
            n === thisDay ? 'current' : '',
            withData.has(n) ? 'has-data' : future ? 'future' : 'missing',
          ].filter(Boolean).join(' ')
          return (
            <Link
              key={n}
              href={`/entry/${iso}`}
              className={cls}
              aria-current={n === thisDay ? 'page' : undefined}
              title={
                withData.has(n) ? `${iso} — entered`
                  : future ? `${iso} — not yet`
                  : `${iso} — no entry`
              }
            >
              {n}
            </Link>
          )
        })}
      </nav>
      <p className="legend-inline">
        <span className="key has-data" /> entered
        <span className="key missing" /> missing
        <span className="key future" /> not yet
      </p>

      <EntryForm day={day} canWrite={canWrite(user.role)} />
    </main>
  )
}
