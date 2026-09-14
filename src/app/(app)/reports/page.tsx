import { redirect } from 'next/navigation'
import { businessMonth } from '@/lib/clock'

/**
 * The index is a doorway to the first report. It carries an explicit `?month=`
 * through rather than replacing it with the current month: a bookmark or a
 * link that names June must not quietly open September.
 */
export default async function ReportsIndex({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>
}) {
  const { month: raw } = await searchParams
  const month = /^\d{4}-\d{2}$/.test(raw ?? '') ? raw! : businessMonth()
  redirect(`/reports/daily-rekod?month=${month}` as never)
}
