'use client'

import { useState, useRef } from 'react'
import { runParallelCheck, type CheckOutcome } from '@/app/(app)/parallel/actions'

const fmt = (v: number | null) =>
  v === null ? '—' : v.toLocaleString('en-MY', { maximumFractionDigits: 2 })

export function ParallelCheck({ defaultMonth }: { defaultMonth: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle')
  const [outcome, setOutcome] = useState<CheckOutcome | null>(null)
  const [onlyDiffs, setOnlyDiffs] = useState(true)
  const [month, setMonth] = useState(defaultMonth)
  const fileRef = useRef<HTMLInputElement>(null)

  async function run() {
    const file = fileRef.current?.files?.[0]
    if (!file) {
      setOutcome({ ok: false, message: 'Choose the Daily Rekod Ais workbook.' })
      return
    }
    const fd = new FormData()
    fd.set('month', month)
    fd.set('file', file)
    setState('busy')
    setOutcome(await runParallelCheck(fd))
    setState('done')
  }

  const result = outcome?.result
  const rows = (result?.diffs ?? []).filter(
    (x) => !onlyDiffs || x.verdict !== 'MATCH'
  )
  const clean = result && result.differed === 0 && result.missing === 0

  return (
    <>
      {/* An explicit handler rather than a form action: the file input and the
          server action are wired the same way as the bill upload, which keeps
          one pattern in the app instead of two. */}
      <section className="panel">
        <h2>Check a month</h2>
        <p className="note">
          Upload the <strong>Daily Rekod Ais</strong> workbook she is still keeping
          by hand. Anything that disagrees is either a spreadsheet error or an
          import error, and both are worth knowing.
        </p>
        <div className="row">
          <label className="stacked">
            <span>Month</span>
            <input
              type="month" value={month} aria-label="Month"
              onChange={(e) => setMonth(e.target.value)}
            />
          </label>
          <label className="stacked">
            <span>Workbook (.xlsx)</span>
            <input
              ref={fileRef} type="file" accept=".xlsx" aria-label="Workbook"
              onChange={() => setOutcome(null)}
            />
          </label>
          <button type="button" onClick={() => void run()} disabled={state === 'busy'}>
            {state === 'busy' ? 'Comparing…' : 'Compare'}
          </button>
        </div>
        {outcome && !outcome.ok ? (
          <p className="issue error">{outcome.message}</p>
        ) : null}
      </section>

      {result ? (
        <>
          <section className={`panel summary ${clean ? 'clean' : ''}`}>
            <h2>
              {result.sheetName
                ? `Sheet "${result.sheetName}" against ${result.month}`
                : result.month}
            </h2>
            {result.notes.map((n, i) => (
              <p key={i} className="issue error">{n}</p>
            ))}
            {result.diffs.length ? (
              <>
                <p className="counts">
                  <span className="ok">{result.matched} agree</span>
                  <span className={result.differed ? 'issue error' : 'muted'}>
                    {result.differed} differ
                  </span>
                  <span className={result.missing ? 'issue warn' : 'muted'}>
                    {result.missing} on one side only
                  </span>
                </p>
                {clean ? (
                  <p className="note">
                    Every compared field agrees for this month. A clean month is
                    what cutover waits for.
                  </p>
                ) : null}
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={onlyDiffs}
                    onChange={(e) => setOnlyDiffs(e.target.checked)}
                  />
                  Show only the rows that disagree
                </label>
              </>
            ) : (
              <p className="note">Nothing to compare for this month.</p>
            )}
          </section>

          {rows.length ? (
            <section className="panel">
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th className="num">Day</th>
                      <th>Field</th>
                      <th className="num">Sheet</th>
                      <th className="num">System</th>
                      <th className="num">Difference</th>
                      <th>Verdict</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((x, i) => (
                      <tr key={i}>
                        <td className="num">{x.day}</td>
                        <td>
                          {x.field}
                          {x.derivation ? (
                            <span className="unit bm">{x.derivation}</span>
                          ) : null}
                        </td>
                        <td className="num">{fmt(x.sheet)}</td>
                        <td className="num">{fmt(x.system)}</td>
                        <td className="num">{fmt(x.difference)}</td>
                        <td>
                          <span
                            className={
                              x.verdict === 'MATCH' ? 'ok'
                                : x.verdict === 'DIFFERS' ? 'issue error'
                                : 'issue warn'
                            }
                          >
                            {x.verdict === 'MATCH' ? 'agrees'
                              : x.verdict === 'DIFFERS' ? 'differs'
                              : x.verdict === 'MISSING_HERE' ? 'not in the system'
                              : 'not on the sheet'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {result.excluded.length ? (
            <section className="panel">
              <h2>Not compared, and why</h2>
              <ul className="footnotes">
                {result.excluded.map((e, i) => (
                  <li key={i}><strong>{e.field}</strong> — {e.reason}</li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
    </>
  )
}
