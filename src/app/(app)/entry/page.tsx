import { redirect } from 'next/navigation'

/** Opening "Entry" means today, which is what she wants nine times in ten. */
export default function EntryIndex() {
  redirect(`/entry/${new Date().toISOString().slice(0, 10)}`)
}
