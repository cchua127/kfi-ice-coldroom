'use client'

import { useState, useMemo } from 'react'
import type { RegisterEntry, RegisterRow } from '@/lib/coldroom-entry'
import {
  saveRegister,
  type RegisterPayload,
  type RegisterSaveResult,
} from '@/app/(app)/monthly/[month]/coldroom/actions'
import {
  validateRegister,
  hasBlocking,
  isOwnUseLabel,
  type Issue,
  type RegisterRowCheck,
} from '@/lib/validation'

const n = (v: string): number => {
  const x = Number(String(v ?? '').trim())
  return Number.isFinite(x) ? x : 0
}
const blank = (v: string) => (v ?? '').trim() === ''
const fmt = (v: number, dp = 0) =>
  v.toLocaleString('en-MY', { minimumFractionDigits: dp, maximumFractionDigits: dp })

interface Editable extends RegisterRow {
  meterReplaced: boolean
}

export function ColdroomRegisterForm({
  data,
  canWrite,
}: {
  data: RegisterEntry
  canWrite: boolean
}) {
  const [rows, setRows] = useState<Editable[]>(() =>
    data.rows.map((r) => ({ ...r, meterReplaced: false }))
  )
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [serverIssues, setServerIssues] = useState<Issue[]>([])
  const [savedRows, setSavedRows] = useState<number | null>(null)

  const set = (i: number, patch: Partial<Editable>) => {
    setRows((cur) => cur.map((r, k) => (k === i ? { ...r, ...patch } : r)))
    setStatus('idle')
  }

  // Typing "KFI" into the occupant column marks the row as own use, because
  // that is the rule the whole cost-of-ice split turns on. It stays a checkbox
  // rather than a derivation, though: the office can overrule it, and the March
  // 2026 case — a room KFI normally uses, let to a tenant — is exactly the sort
  // of thing a derivation alone would get wrong in the other direction.
  const setTenant = (i: number, label: string) => {
    const row = rows[i]
    const wasFollowing = row.ownUse === isOwnUseLabel(row.tenantLabel)
    set(i, { tenantLabel: label, ...(wasFollowing ? { ownUse: isOwnUseLabel(label) } : {}) })
  }

  const checks: RegisterRowCheck[] = useMemo(
    () =>
      rows.map((r, i) => ({
        rowNo: i + 1,
        roomCode: r.roomCode,
        tenantLabel: blank(r.tenantLabel) ? null : r.tenantLabel,
        ownUse: r.ownUse,
        openingKwh: blank(r.openingKwh) ? null : r.openingKwh,
        closingKwh: blank(r.closingKwh) ? null : r.closingKwh,
        rateRmPerKwh: blank(r.rateRmPerKwh) ? null : r.rateRmPerKwh,
        meterReplaced: r.meterReplaced,
        priorClosing: r.priorClosing,
      })),
    [rows]
  )

  const clientIssues = useMemo(() => validateRegister(checks), [checks])
  const issues = status === 'error' && serverIssues.length ? serverIssues : clientIssues
  const blocked = hasBlocking(issues)
  const issuesFor = (i: number) => issues.filter((x) => x.field.startsWith(`register.${i + 1}`))
  const registerIssues = issues.filter((x) => x.field === 'register')

  // The same arithmetic the recompute will do, running as the column is keyed.
  const totals = useMemo(() => {
    let total = 0
    let own = 0
    let read = 0
    for (const r of rows) {
      if (blank(r.closingKwh) || blank(r.openingKwh)) continue
      const use = n(r.closingKwh) - n(r.openingKwh)
      if (use < 0) continue
      read++
      total += use
      if (r.ownUse) own += use
    }
    return { total, own, tenant: total - own, read, rooms: rows.length }
  }, [rows])

  const recharge = useMemo(
    () =>
      rows.reduce((a, r) => {
        if (blank(r.closingKwh) || blank(r.openingKwh)) return a
        const use = n(r.closingKwh) - n(r.openingKwh)
        return use < 0 ? a : a + use * n(r.rateRmPerKwh)
      }, 0),
    [rows]
  )

  async function submit() {
    setStatus('saving')
    const payload: RegisterPayload = {
      month: data.month,
      rows: rows.map((r) => ({
        roomCode: r.roomCode,
        tenantLabel: r.tenantLabel,
        ownUse: r.ownUse,
        openingKwh: r.openingKwh,
        closingKwh: r.closingKwh,
        rateRmPerKwh: r.rateRmPerKwh,
        usageGroup: r.usageGroup,
        note: r.note,
        meterReplaced: r.meterReplaced,
      })),
    }
    const result: RegisterSaveResult = await saveRegister(payload)
    setServerIssues(result.issues)
    setSavedRows(result.savedRows ?? null)
    setStatus(result.ok ? 'saved' : 'error')
  }

  const addRow = () =>
    setRows((cur) => [
      ...cur,
      {
        rowNo: cur.length + 1,
        roomCode: '',
        tenantLabel: '',
        ownUse: false,
        openingKwh: '',
        closingKwh: '',
        rateRmPerKwh: data.defaultRate,
        usageGroup: '',
        note: '',
        priorClosing: null,
        carriedForward: false,
        meterReplaced: false,
      },
    ])

  /**
   * Split a room that changed hands mid-month. The new row starts where the old
   * one stops, which is what makes two rows on one room code a real split of one
   * meter rather than a duplicate — and the save refuses two rows sharing an
   * opening for exactly that reason.
   */
  const splitRow = (i: number) =>
    setRows((cur) => [
      ...cur.slice(0, i + 1),
      {
        ...cur[i],
        rowNo: cur[i].rowNo + 1,
        tenantLabel: '',
        ownUse: false,
        openingKwh: cur[i].closingKwh,
        closingKwh: '',
        note: '',
        priorClosing: null,
        carriedForward: false,
        meterReplaced: false,
      },
      ...cur.slice(i + 1),
    ])

  const removeRow = (i: number) => setRows((cur) => cur.filter((_, k) => k !== i))

  return (
    <div className="entry register">
      <div className="savebar">
        <span className={`save-state ${status}`}>
          {status === 'saving'
            ? 'Saving…'
            : status === 'saved'
              ? `Saved ${savedRows} room(s). Run the recompute to carry it into the reports.`
              : status === 'error'
                ? 'Not saved — see the messages below.'
                : blocked
                  ? 'Fix the errors below before saving.'
                  : `${totals.read} of ${totals.rooms} rooms read`}
        </span>
        {canWrite ? (
          <button type="button" onClick={submit} disabled={blocked || status === 'saving'}>
            Save {data.month}
          </button>
        ) : (
          <span className="readonly-note">Read-only. Entry is for staff accounts.</span>
        )}
      </div>

      {registerIssues.map((i, k) => (
        <p key={k} className={i.severity === 'ERROR' ? 'error' : 'hint warn'}>
          {i.message}
        </p>
      ))}

      <section className="kpis secondary" aria-label="This month so far">
        <div className="kpi">
          <span className="kpi-label">Whole coldroom</span>
          <span className="kpi-value">{fmt(totals.total)}<small>kWh</small></span>
        </div>
        <div className="kpi">
          <span className="kpi-label">KFI&rsquo;s own rooms</span>
          <span className="kpi-value">{fmt(totals.own)}<small>kWh · to cost of ice</small></span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Tenant rooms</span>
          <span className="kpi-value">{fmt(totals.tenant)}<small>kWh</small></span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Recharge</span>
          <span className="kpi-value"><small>RM</small>{fmt(recharge, 2)}</span>
        </div>
      </section>

      <div className="scroll">
        <table className="grid">
          <thead>
            <tr>
              <th>Room</th>
              <th>Occupant</th>
              <th>KFI<span className="unit">own use</span></th>
              <th>Opening<span className="unit">last month</span></th>
              <th>Closing<span className="unit">this month</span></th>
              <th>kWh</th>
              <th>Rate</th>
              <th>RM</th>
              <th>Acct</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const filled = !blank(r.closingKwh) && !blank(r.openingKwh)
              const use = filled ? n(r.closingKwh) - n(r.openingKwh) : null
              const rowIssues = issuesFor(i)
              const chainBroken =
                r.priorClosing !== null &&
                !blank(r.openingKwh) &&
                n(r.openingKwh) !== n(r.priorClosing)
              return (
                <tr key={i} className={rowIssues.some((x) => x.severity === 'ERROR') ? 'bad' : ''}>
                  <td>
                    <input
                      value={r.roomCode}
                      disabled={!canWrite}
                      onChange={(e) => set(i, { roomCode: e.target.value })}
                      aria-label={`Room, row ${i + 1}`}
                    />
                  </td>
                  <td>
                    <input
                      value={r.tenantLabel}
                      disabled={!canWrite}
                      placeholder="vacant"
                      onChange={(e) => setTenant(i, e.target.value)}
                      aria-label={`Occupant, row ${i + 1}`}
                    />
                  </td>
                  <td className="mid">
                    <input
                      type="checkbox"
                      checked={r.ownUse}
                      disabled={!canWrite}
                      onChange={(e) => set(i, { ownUse: e.target.checked })}
                      aria-label={`KFI own use, row ${i + 1}`}
                    />
                  </td>
                  <td>
                    <input
                      inputMode="decimal"
                      value={r.openingKwh}
                      disabled={!canWrite}
                      className={chainBroken ? 'warned' : ''}
                      onChange={(e) => set(i, { openingKwh: e.target.value })}
                      aria-label={`Opening, row ${i + 1}`}
                    />
                  </td>
                  <td>
                    <input
                      inputMode="decimal"
                      value={r.closingKwh}
                      disabled={!canWrite}
                      onChange={(e) => set(i, { closingKwh: e.target.value })}
                      aria-label={`Closing, row ${i + 1}`}
                    />
                  </td>
                  <td className="num">{use === null ? '—' : fmt(use)}</td>
                  <td>
                    <input
                      inputMode="decimal"
                      value={r.rateRmPerKwh}
                      disabled={!canWrite}
                      onChange={(e) => set(i, { rateRmPerKwh: e.target.value })}
                      aria-label={`Rate, row ${i + 1}`}
                    />
                  </td>
                  <td className="num">
                    {use === null ? '—' : fmt(use * n(r.rateRmPerKwh), 2)}
                  </td>
                  <td>
                    <select
                      value={r.usageGroup}
                      disabled={!canWrite}
                      onChange={(e) => set(i, { usageGroup: e.target.value })}
                      aria-label={`TNB account, row ${i + 1}`}
                    >
                      <option value="">—</option>
                      <option value="1">1</option>
                      <option value="2">2</option>
                    </select>
                  </td>
                  <td className="rowtools">
                    {canWrite ? (
                      <>
                        <button
                          type="button"
                          className="linkish"
                          title="The room changed hands this month: start a second row where this one stops."
                          onClick={() => splitRow(i)}
                        >
                          split
                        </button>
                        <button
                          type="button"
                          className="linkish"
                          title="Remove this row"
                          onClick={() => removeRow(i)}
                        >
                          remove
                        </button>
                      </>
                    ) : null}
                    {rowIssues.length ? (
                      <ul className="issues">
                        {rowIssues.map((x, k) => (
                          <li key={k} className={x.severity === 'ERROR' ? 'error' : 'warn'}>
                            {x.message}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {canWrite ? (
        <p>
          <button type="button" className="linkish" onClick={addRow}>
            + add a room
          </button>
        </p>
      ) : null}
    </div>
  )
}
