import { redirect } from 'next/navigation'

export default function ReportsIndex() {
  const month = new Date().toISOString().slice(0, 7)
  redirect(`/reports/daily-rekod?month=${month}` as never)
}
