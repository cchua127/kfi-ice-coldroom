import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/session'
import { buildReport } from '@/lib/reports/builders'
import { REPORTS, formatCell, type ReportSlug } from '@/lib/reports/types'
import { statusLabel } from '@/lib/reports/excel'

export const dynamic = 'force-dynamic'

const COMPANY = 'KFI Cold Storage Sdn Bhd'

export default async function ReportPage({
  params, searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ month?: string }>
}) {
  const { slug } = await params
  const { month: raw } = await searchParams
  await requireUser()

  if (!REPORTS.some((r) => r.slug === slug)) notFound()
  const month = /^\d{4}-\d{2}$/.test(raw ?? '')
    ? raw!
    : new Date().toISOString().slice(0, 7)

  const report = await buildReport(slug as ReportSlug, month)

  const shift = (delta: number) => {
    const [y, m] = month.split('-').map(Number)
    return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7)
  }

  return (
    <main className="report">
      {/* Printed sheets leave the building. They carry who, what, when, and
          whether the figures are final, on every page. */}
      <header className="printhead">
        <strong>{COMPANY}</strong>
        <span>{report.meta.name} · {report.meta.period}</span>
        <span>Generated {new Date(report.meta.generatedAt).toLocaleString('en-MY')}</span>
      </header>

      <nav className="reportnav noprint" aria-label="Reports">
        {REPORTS.map((r) => (
          <Link
            key={r.slug}
            href={`/reports/${r.slug}?month=${month}` as never}
            className={r.slug === slug ? 'current' : ''}
          >
            {r.name}
          </Link>
        ))}
      </nav>

      <div className="reportbar noprint">
        <Link href={`/reports/${slug}?month=${shift(-1)}` as never} className="linkish">
          ‹ {shift(-1)}
        </Link>
        <h1>{report.meta.name} · {month}</h1>
        <Link href={`/reports/${slug}?month=${shift(1)}` as never} className="linkish">
          {shift(1)} ›
        </Link>
        <a className="button" href={`/api/reports/${slug}?month=${month}`}>
          Export to Excel
        </a>
      </div>

      {report.meta.status && report.meta.status !== 'FINAL' ? (
        <p className={`statusline ${report.meta.status.toLowerCase()}`}>
          {statusLabel(report.meta.status)}
        </p>
      ) : null}

      {report.tables.map((table, ti) => (
        <section className="panel" key={ti}>
          <h2>{table.title}</h2>
          {table.subtitle ? <p className="note">{table.subtitle}</p> : null}
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  {table.columns.map((c) => (
                    <th key={c.key} className={c.type === 'text' ? '' : 'num'}>
                      {c.label}
                      {c.labelBm ? <span className="bm"> {c.labelBm}</span> : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, ri) => (
                  <tr key={ri} className={row.emphasis ? 'emphasis' : ''}>
                    {table.columns.map((c) => (
                      <td key={c.key} className={c.type === 'text' ? '' : 'num'}>
                        {formatCell(row.cells[c.key] ?? null, c.type)}
                      </td>
                    ))}
                  </tr>
                ))}
                {table.rows.length === 0 ? (
                  <tr>
                    <td colSpan={table.columns.length} className="muted">
                      Nothing recorded for this period.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {(table.columns.some((c) => c.note) || table.notes?.length) ? (
            <ul className="footnotes">
              {table.columns.filter((c) => c.note).map((c) => (
                <li key={c.key}><strong>{c.label}</strong> — {c.note}</li>
              ))}
              {(table.notes ?? []).map((note, i) => <li key={`n${i}`}>{note}</li>)}
            </ul>
          ) : null}
        </section>
      ))}
    </main>
  )
}
