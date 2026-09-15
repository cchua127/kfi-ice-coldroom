'use client'

import { useState, useMemo } from 'react'
import type { MonthlyInputs } from '@/lib/monthly'
import { saveMonth, type MonthPayload, type MonthSaveResult } from '@/app/(app)/monthly/[month]/actions'
import { validateColdroomMonth, validateWaterMonth, hasBlocking, type Issue } from '@/lib/validation'

const n = (v: string): number => {
  const x = Number(String(v ?? '').trim())
  return Number.isFinite(x) ? x : 0
}
const blank = (v: string) => v.trim() === ''
const fmt = (v: number, dp = 0) =>
  v.toLocaleString('en-MY', { minimumFractionDigits: dp, maximumFractionDigits: dp })

export function MonthlyForm({ data, canWrite }: { data: MonthlyInputs; canWrite: boolean }) {
  const [coldroom, setColdroom] = useState(data.coldroom)
  const [water, setWater] = useState(data.water)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [serverIssues, setServerIssues] = useState<Issue[]>([])

  const legacyFactor = n(data.reference.legacyFactor)
  const tenantRate = n(data.reference.tenantRate)
  const waterPerTonne = n(data.reference.waterPerTonne)

  // The same arithmetic the recompute will do, shown live. Seeing the split
  // move as the compilations are keyed is what makes a transposed digit
  // obvious at the keyboard rather than at month end.
  const derived = useMemo(() => {
    const iceStoreKwh = n(coldroom.iceStoreInvoicedRm) / (tenantRate || 1)
    const metered = blank(coldroom.meteredKwh) ? null : n(coldroom.meteredKwh)
    const compiled = n(coldroom.ratonoRm) + n(coldroom.yemintRm)
    const total = metered ?? compiled / (legacyFactor || 1)
    return {
      total,
      iceStoreKwh,
      tenantKwh: Math.max(total - iceStoreKwh, 0),
      backInferred: metered === null && compiled > 0,
      waterKwh: (n(water.tonnes) + n(water.retailM3)) * waterPerTonne,
    }
  }, [coldroom, water, legacyFactor, tenantRate, waterPerTonne])

  const clientIssues = useMemo(
    () => [
      ...validateColdroomMonth({
        meteredKwh: blank(coldroom.meteredKwh) ? null : coldroom.meteredKwh,
        ratonoRm: blank(coldroom.ratonoRm) ? null : coldroom.ratonoRm,
        yemintRm: blank(coldroom.yemintRm) ? null : coldroom.yemintRm,
        iceStoreInvoicedRm: blank(coldroom.iceStoreInvoicedRm)
          ? null
          : coldroom.iceStoreInvoicedRm,
        legacyFactor: data.reference.legacyFactor,
        tenantRate: data.reference.tenantRate,
      }),
      ...validateWaterMonth({
        tonnes: blank(water.tonnes) ? null : water.tonnes,
        retailM3: blank(water.retailM3) ? null : water.retailM3,
      }),
    ],
    [coldroom, water, data.reference]
  )

  const issues = status === 'error' && serverIssues.length ? serverIssues : clientIssues
  const blocked = hasBlocking(issues)
  const issueFor = (field: string) => issues.filter((i) => i.field === field)

  async function submit() {
    setStatus('saving')
    const payload: MonthPayload = { month: data.month, coldroom, water }
    const result: MonthSaveResult = await saveMonth(payload)
    setServerIssues(result.issues)
    setStatus(result.ok ? 'saved' : 'error')
  }

  const field = (
    name: string,
    label: string,
    value: string,
    onChange: (v: string) => void,
    hint: string
  ) => (
    <label key={name}>
      <span>{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        disabled={!canWrite}
        onChange={(e) => {
          onChange(e.target.value)
          setStatus('idle')
        }}
      />
      <small className="hint">{hint}</small>
      {issueFor(name).map((i, k) => (
        <small key={k} className={i.severity === 'ERROR' ? 'error' : 'hint warn'}>
          {i.message}
        </small>
      ))}
    </label>
  )

  return (
    <div className="entry monthly">
      <fieldset>
        <legend>Coldroom</legend>
        <p className="sub">
          One row for the month. The sub-meter reading is the answer; the ringgit
          compilations below are the fallback, and they recover a quantity from a
          price struck at a rate that has not moved since July 2025.
        </p>

        {field(
          'coldroom.meteredKwh',
          'Sub-meter kWh (whole coldroom)',
          coldroom.meteredKwh,
          (v) => setColdroom({ ...coldroom, meteredKwh: v }),
          'Leave BLANK if the meter was not read. Blank and 0 are not the same thing.'
        )}
        {field(
          'coldroom.ratonoRm',
          'Ratono compilation RM',
          coldroom.ratonoRm,
          (v) => setColdroom({ ...coldroom, ratonoRm: v }),
          `At the legacy RM${data.reference.legacyFactor}/kWh convention.`
        )}
        {field(
          'coldroom.yemintRm',
          'Yemint compilation RM',
          coldroom.yemintRm,
          (v) => setColdroom({ ...coldroom, yemintRm: v }),
          'With Ratono, covers the WHOLE room including D10-D12.'
        )}
        {field(
          'coldroom.iceStoreInvoicedRm',
          'D10-D12 invoiced RM',
          coldroom.iceStoreInvoicedRm,
          (v) => setColdroom({ ...coldroom, iceStoreInvoicedRm: v }),
          `Our own ice store, at the RM${data.reference.tenantRate}/kWh tenant rate. Subtracted from the total above.`
        )}
        <label>
          <span>Note</span>
          <input
            type="text"
            value={coldroom.note}
            disabled={!canWrite}
            onChange={(e) => {
              setColdroom({ ...coldroom, note: e.target.value })
              setStatus('idle')
            }}
          />
        </label>

        <table className="derived">
          <caption>What that works out at</caption>
          <tbody>
            <tr>
              <th>Whole coldroom</th>
              <td>{fmt(derived.total)} kWh</td>
              <td className="sub">
                {derived.backInferred
                  ? `back-inferred: RM${fmt(n(coldroom.ratonoRm) + n(coldroom.yemintRm), 2)} / ${data.reference.legacyFactor}`
                  : blank(coldroom.meteredKwh)
                    ? 'nothing entered'
                    : 'from the sub-meter'}
              </td>
            </tr>
            <tr>
              <th>Ice storage D10-D12</th>
              <td>{fmt(derived.iceStoreKwh)} kWh</td>
              <td className="sub">counts as ice</td>
            </tr>
            <tr>
              <th>Tenant rooms</th>
              <td>{fmt(derived.tenantKwh)} kWh</td>
              <td className="sub">recharged at RM{data.reference.tenantRate}/kWh</td>
            </tr>
          </tbody>
        </table>
      </fieldset>

      <fieldset>
        <legend>Water</legend>
        <p className="sub">
          Delivered water only. The feed water that becomes ice is worked out per
          day from the ice actually made, at {data.reference.iceFeedPerTonne} kWh/t,
          and needs nothing keyed here.
        </p>

        {field(
          'water.tonnes',
          'PKPS delivery, tonnes',
          water.tonnes,
          (v) => setWater({ ...water, tonnes: v }),
          'From the PKPS water log.'
        )}
        {field(
          'water.retailM3',
          'Retail water, m³',
          water.retailM3,
          (v) => setWater({ ...water, retailM3: v }),
          'Metered. Counted as tonnes at 1:1.'
        )}
        <label>
          <span>Note</span>
          <input
            type="text"
            value={water.note}
            disabled={!canWrite}
            onChange={(e) => {
              setWater({ ...water, note: e.target.value })
              setStatus('idle')
            }}
          />
        </label>

        <table className="derived">
          <caption>What that works out at</caption>
          <tbody>
            <tr>
              <th>Delivered water</th>
              <td>{fmt(derived.waterKwh)} kWh</td>
              <td className="sub">
                {fmt(n(water.tonnes) + n(water.retailM3))} t × {data.reference.waterPerTonne} kWh/t
              </td>
            </tr>
          </tbody>
        </table>
      </fieldset>

      {canWrite ? (
        <div className="savebar">
          <span className={`save-state ${status}`}>
            {status === 'saving'
              ? 'Saving…'
              : status === 'saved'
                ? 'Saved. Run the recompute to carry it into the reports.'
                : status === 'error'
                  ? 'Not saved — see the messages above.'
                  : blocked
                    ? 'Fix the errors above before saving.'
                    : ''}
          </span>
          <button type="button" onClick={submit} disabled={blocked || status === 'saving'}>
            Save {data.month}
          </button>
        </div>
      ) : (
        <p className="note">Read-only. Entry is for staff accounts.</p>
      )}
    </div>
  )
}
