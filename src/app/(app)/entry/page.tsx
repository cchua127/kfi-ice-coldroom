import { redirect } from 'next/navigation'
import { businessToday } from '@/lib/clock'

/** Opening "Entry" means today, which is what she wants nine times in ten. */
export default function EntryIndex() {
  redirect(`/entry/${businessToday()}` as never)
}
