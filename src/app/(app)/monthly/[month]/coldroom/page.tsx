import Link from 'next/link'
import { notFound } from 'next/navigation'
import { shiftMonth } from '@/lib/clock'
import { loadRegister } from '@/lib/coldroom-entry'
import { requireUser } from '@/lib/session'
import { canWrite } from '@/lib/auth'
import { ColdroomRegisterForm } from '@/components/coldroom-register-form'

export const dynamic = 'force-dynamic'

const VALID = /^\d{4}-\d{2}$/

const pretty = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-MY', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  })

export default async function ColdroomRegisterPage({
  params,
}: {
  params: Promise<{ month: string }>
}) {
  const { month } = await params
  if (!VALID.test(month)) notFound()

  const user = await requireUser()
  const data = await loadRegister(month)

  return (
    <main>
      <div className="daynav">
        <Link href={`/monthly/${shiftMonth(month, -1)}/coldroom` as never} className="linkish">
          ‹ Previous
        </Link>
        <h1>Coldroom register · {pretty(month)}</h1>
        <Link href={`/monthly/${shiftMonth(month, 1)}/coldroom` as never} className="linkish">
          Next ›
        </Link>
      </div>

      <p className="sub">
        One row per room, read once a month. Only the <strong>closing</strong> column
        needs keying — the rooms, the occupants and every opening carry forward from
        last month.{' '}
        <Link href={`/monthly/${month}` as never} className="linkish">
          Water and the ringgit fallback are on the monthly inputs screen.
        </Link>
      </p>

      {data.source === 'CARRIED_FORWARD' ? (
        <p className="alert info">
          <strong>Draft, carried forward from {data.carriedFrom}</strong>
          <span>
            Nothing is stored for {month} yet. These {data.rows.length} rooms and their
            openings come from last month&rsquo;s closings; key the closings and save.
          </span>
        </p>
      ) : data.source === 'EMPTY' ? (
        <p className="alert warn">
          <strong>Nothing to carry forward</strong>
          <span>
            There is no register for {data.carriedFrom ?? 'the previous month'}, so every
            room has to be added by hand — including its opening reading.
          </span>
        </p>
      ) : (
        <p className="alert info">
          <strong>Saved</strong>
          <span>
            {data.rows.length} rooms stored for {month}. Editing and saving replaces the
            month; the reports move when the recompute runs.
          </span>
        </p>
      )}

      <ColdroomRegisterForm data={data} canWrite={canWrite(user.role)} />
    </main>
  )
}
