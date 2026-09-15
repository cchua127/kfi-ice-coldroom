import { redirect } from 'next/navigation'
import { businessMonth } from '@/lib/clock'

/**
 * Opens on the month in progress at the plant, not the container's month —
 * from midnight to 8am Malaysian time those differ, and on the first of the
 * month they differ by a whole month.
 */
export default async function MonthlyIndex() {
  redirect(`/monthly/${businessMonth()}` as never)
}
