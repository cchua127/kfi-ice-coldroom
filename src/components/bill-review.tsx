'use client'

import { useState, useMemo } from 'react'
import { confirmBill } from '@/app/(app)/bills/actions'
import type { Finding } from '@/lib/bill-validation'

interface Props {
  billId: string
  canWrite: boolean
  confirmed: boolean
  fields: Record<string, string>
  /** What the reconstruction says each line must be, given kWh and the AFA rate. */
  expected: Record<string, string>
  meterReadings: { meterNo: string; unit: string; usage: string }[]
  notes: string
}

const LABELS: [string, string, string][] = [
  // key, English, as printed on the bill
  ['kwh', 'Consumption (kWh)', 'Jumlah Penggunaan Anda'],
  ['afaRatePerKwh', 'AFA rate (RM/kWh)', 'rate inside the AFA label'],
  ['energyRm', 'Energy', 'Tenaga'],
  ['afaRm', 'AFA', 'AFA'],
  ['capacityRm', 'Capacity', 'Kapasiti'],
  ['networkRm', 'Network', 'Caj Rangkaian'],
  ['retailRm', 'Retail', 'Caj Peruncitan'],
  ['rebateRm', 'Rebate', 'Rebat'],
  ['currentUsageRm', 'Current usage charge', 'Caj Penggunaan Bulan Semasa'],
  ['kwtbbRm', 'KWTBB', 'KWTBB (1.6%)'],
  ['currentChargesRm', 'Current charges', 'Caj Semasa'],
  ['previousBalanceRm', 'Previous balance', 'Baki Terdahulu'],
  ['roundingRm', 'Rounding', 'Pelarasan Penggenapan'],
  ['totalRm', 'Total', 'Jumlah Bil Anda'],
]

const sen = (a: string, b: string) =>
  Math.round((Number(a) - Number(b)) * 100)

export function BillReview({
  billId, canWrite, confirmed, fields, expected, meterReadings, notes,
}: Props) {
  const [values, setValues] = useState(fields)
  const [findings, setFindings] = useState<Finding[]>([])
  const [state, setState] = useState<'idle' | 'busy' | 'ok' | 'error'>('idle')
  const [message, setMessage] = useState<string | null>(null)

  // A break is shown as a field-level difference in sen, never as a generic
  // "parse failed" — the point is to say which line moved and by how much.
  const diffs = useMemo(() => {
    const out: Record<string, number> = {}
    for (const [key, ] of LABELS) {
      if (expected[key] === undefined) continue
      const d = sen(values[key] ?? '0', expected[key])
      if (d !== 0) out[key] = d
    }
    return out
  }, [values, expected])

  const kwhSum = meterReadings
    .filter((m) => m.unit.toLowerCase() === 'kwh')
    .reduce((a, m) => a + Number(m.usage), 0)
  const kwhTies = meterReadings.length === 0 || kwhSum === Number(values.kwh)

  async function confirm() {
    setState('busy')
    const res = await confirmBill(billId, values)
    setFindings(res.findings)
    setMessage(res.message ?? null)
    setState(res.ok ? 'ok' : 'error')
  }

  return (
    <div className="review">
      {notes ? (
        <p className="issue warn">
          <strong>The model flagged:</strong> {notes}
        </p>
      ) : null}

      <section className="panel">
        <h2>Figures</h2>
        <p className="note">
          The right-hand column is what the bill must say, rebuilt from the
          consumption and the AFA rate alone. Where the two disagree, one of them
          is wrong — correct the left before confirming.
        </p>
        <div className="scroll">
          <table className="grid">
            <thead>
              <tr>
                <th>Line</th>
                <th className="num">On the bill</th>
                <th className="num">Reconstructed</th>
                <th className="num">Difference</th>
              </tr>
            </thead>
            <tbody>
              {LABELS.map(([key, label, printed]) => (
                <tr key={key}>
                  <th scope="row">
                    {label}
                    <span className="unit bm">{printed}</span>
                  </th>
                  <td className="num" data-label="On the bill">
                    <input
                      inputMode="decimal"
                      value={values[key] ?? ''}
                      aria-label={label}
                      aria-invalid={diffs[key] !== undefined}
                      disabled={!canWrite}
                      onChange={(e) =>
                        setValues((v) => ({ ...v, [key]: e.target.value }))
                      }
                    />
                  </td>
                  <td className="num muted" data-label="Reconstructed">
                    {expected[key] ?? '—'}
                  </td>
                  <td className="num" data-label="Difference">
                    {diffs[key] !== undefined ? (
                      <span className="issue error">
                        {diffs[key] > 0 ? '+' : ''}{diffs[key]} sen
                      </span>
                    ) : expected[key] !== undefined ? (
                      <span className="ok">ties</span>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>Meter readings</h2>
        <p className="note">
          Each account carries two physical meters, each reporting kWh, kW and
          kVARh. Only the kWh rows sum to billed consumption.
        </p>
        <div className="scroll">
          <table>
            <thead>
              <tr><th>Meter</th><th>Unit</th><th className="num">Usage</th></tr>
            </thead>
            <tbody>
              {meterReadings.map((m, i) => (
                <tr key={i}>
                  <td>{m.meterNo}</td>
                  <td>{m.unit}</td>
                  <td className="num">{Number(m.usage).toLocaleString('en-MY')}</td>
                </tr>
              ))}
              {meterReadings.length === 0 ? (
                <tr><td colSpan={3} className="muted">None captured.</td></tr>
              ) : null}
            </tbody>
            {meterReadings.length ? (
              <tfoot>
                <tr>
                  <th scope="row" colSpan={2}>kWh rows</th>
                  <td className="num">
                    {kwhSum.toLocaleString('en-MY')}{' '}
                    <span className={kwhTies ? 'ok' : 'issue error'}>
                      {kwhTies ? 'ties' : 'does not tie'}
                    </span>
                  </td>
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      </section>

      {findings.length ? (
        <section className="panel">
          <h2>Checks</h2>
          {findings.map((f, i) => (
            <p key={i} className={`issue ${f.severity.toLowerCase()}`}>
              <strong>{f.field ?? f.code}</strong> — {f.message}
              {f.expected !== undefined ? ` Expected ${f.expected}, got ${f.actual}.` : ''}
            </p>
          ))}
        </section>
      ) : null}

      <div className="savebar">
        <span className={`save-state ${state === 'ok' ? 'saved' : state === 'error' ? 'error' : ''}`}>
          {confirmed
            ? 'Already confirmed'
            : message ?? (Object.keys(diffs).length
                ? `${Object.keys(diffs).length} line(s) do not reconstruct`
                : 'Every line reconstructs')}
        </span>
        {canWrite ? (
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={state === 'busy' || Object.keys(diffs).length > 0 || !kwhTies}
          >
            {state === 'busy' ? 'Confirming…' : 'Confirm bill'}
          </button>
        ) : null}
      </div>
    </div>
  )
}
