import { businessMonth, shiftMonth } from '@/lib/clock'
import { requireUser } from '@/lib/session'
import { ParallelCheck } from '@/components/parallel-check'

export const dynamic = 'force-dynamic'

export default async function ParallelPage() {
  await requireUser()

  return (
    <main>
      <h1>Parallel check</h1>
      <p className="sub">
        Both systems run side by side until a month comes through clean. Then the
        workbooks are archived read-only and this screen has done its job.
      </p>
      <ParallelCheck defaultMonth={shiftMonth(businessMonth(), -1)} />
    </main>
  )
}
