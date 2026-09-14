import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/session'
import { buildReport } from '@/lib/reports/builders'
import { reportToWorkbook, filenameFor } from '@/lib/reports/excel'
import { REPORTS, type ReportSlug } from '@/lib/reports/types'

/** Excel download. Both roles may take reports; only entry is STAFF-only. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const user = await currentUser()
  if (!user) return new NextResponse('Sign in first.', { status: 401 })

  const { slug } = await params
  if (!REPORTS.some((r) => r.slug === slug)) {
    return new NextResponse('No such report.', { status: 404 })
  }
  const month = new URL(request.url).searchParams.get('month') ?? ''
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return new NextResponse('Give a month as YYYY-MM.', { status: 400 })
  }

  const report = await buildReport(slug as ReportSlug, month)
  const buffer = await reportToWorkbook(report)

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filenameFor(report)}"`,
      'Content-Length': String(buffer.byteLength),
    },
  })
}
