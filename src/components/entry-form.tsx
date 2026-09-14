'use client'

import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import type { DayEntry } from '@/lib/entry'
import { saveDay, type DayPayload, type SaveResult } from '@/app/(app)/entry/[date]/actions'
import {
  validateMeter, validateProduction, validateCash, validateSale,
  hasBlocking, type Issue,
} from '@/lib/validation'

const n = (v: string | null | undefined): number => {
  const x = Number(String(v ?? '').trim())
  return Number.isFinite(x) ? x : 0
}
const fmt = (v: number, dp = 0) =>
  v.toLocaleString('en-MY', { minimumFractionDigits: dp, maximumFractionDigits: dp })

type Meters = Record<string, { closing: string; rollover: boolean }>
type Production = Record<string, { quantity: string; tongKosong: string }>

export function EntryForm({ day, canWrite }: { day: DayEntry; canWrite: boolean }) {
  const [meters, setMeters] = useState<Meters>(() =>
    Object.fromEntries(
      day.meters.map((m) => [m.meterCode, { closing: m.closing ?? '', rollover: m.rollover }])
    )
  )
  const [production, setProduction] = useState<Production>(() =>
    Object.fromEntries(
      day.production.map((p) => [
        `${p.line}.${p.unitCode}`,
        { quantity: p.quantity ?? '', tongKosong: p.tongKosong ?? '' },
      ])
    )
  )
  const [cash, setCash] = useState({
    shift1: day.cash.shift1, shift2: day.cash.shift2, note: day.cash.note ?? '',
  })
  const [sales, setSales] = useState(() =>
    day.sales.length
      ? day.sales.map((s) => ({
          customer: s.customer ?? '', product: s.product ?? '',
          quantity: s.quantity ?? '', unitPrice: s.unitPrice ?? '',
        }))
      : [{ customer: '', product: '', quantity: '', unitPrice: '' }]
  )
  const [purchases, setPurchases] = useState(() =>
    day.purchases.length
      ? day.purchases.map((p) => ({
          supplier: p.supplier ?? '', doNo: p.doNo ?? '',
          quantity: p.quantity ?? '', unitPrice: p.unitPrice ?? '',
        }))
      : [{ supplier: '', doNo: '', quantity: '', unitPrice: '' }]
  )

  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [serverIssues, setServerIssues] = useState<Issue[]>([])
  const dirty = useRef(false)

  // Live computation, the same arithmetic the server will do.
  const meterKwh = useMemo(() => {
    const out: Record<string, number | null> = {}
    for (const m of day.meters) {
      const closing = meters[m.meterCode]?.closing
      if (!closing || m.priorClosing === null) { out[m.meterCode] = null; continue }
      out[m.meterCode] = n(closing) - n(m.priorClosing)
    }
    return out
  }, [meters, day.meters])

  // Kilograms per ROW, not per line: the tube line has a bags row and a tong
  // row, and showing the line total against each read as though bags alone
  // weighed 5,225 kg.
  const rowKg = useMemo(() => {
    const out: Record<string, number> = {}
    const bpb = n(day.reference.blocksPerBaris)
    for (const p of day.production) {
      const key = `${p.line}.${p.unitCode}`
      const v = production[key]
      if (!v?.quantity) { out[key] = 0; continue }
      const qty = n(v.quantity)
      out[key] =
        p.unitCode === 'BARIS'
          ? Math.max(qty * bpb - n(v.tongKosong), 0) * 100
          : qty * n(p.kgPerUnit)
    }
    return out
  }, [production, day.production, day.reference.blocksPerBaris])

  const totalKg = Object.values(rowKg).reduce((a, b) => a + b, 0)
  const cashTotal = n(cash.shift1) + n(cash.shift2)
  const salesTotal = sales.reduce((a, s) => a + n(s.quantity) * n(s.unitPrice), 0)

  // Client-side issues: immediate feedback only. The server decides.
  const issues = useMemo(() => {
    const out: Issue[] = []
    for (const m of day.meters) {
      out.push(...validateMeter({
        meterCode: m.meterCode, label: m.label,
        closing: meters[m.meterCode]?.closing || null,
        priorClosing: m.priorClosing, priorDate: m.priorDate, digits: m.digits,
        rolloverConfirmed: meters[m.meterCode]?.rollover,
        trailingMean: m.trailingMean,
      }))
    }
    for (const p of day.production) {
      const v = production[`${p.line}.${p.unitCode}`]
      out.push(...validateProduction({
        line: p.line, label: `${p.label} ${p.unitLabel}`, unitCode: p.unitCode,
        quantity: v?.quantity || null, tongKosong: v?.tongKosong || null,
        blocksPerBaris: day.reference.blocksPerBaris,
      }))
    }
    out.push(...validateCash({
      shift1: cash.shift1 || null, shift2: cash.shift2 || null, note: cash.note || null,
    }))
    sales.forEach((s, index) => out.push(...validateSale({
      index, customer: s.customer || null, product: s.product || null,
      quantity: s.quantity || null, unitPrice: s.unitPrice || null,
    })))
    return out
  }, [meters, production, cash, sales, day])

  const blocking = hasBlocking(issues)
  const issueFor = (field: string) => issues.filter((i) => i.field === field)

  const payload = useCallback((): DayPayload => ({
    date: day.date,
    meters: day.meters.map((m) => ({
      meterCode: m.meterCode,
      closing: meters[m.meterCode]?.closing ?? '',
      rollover: meters[m.meterCode]?.rollover ?? false,
    })),
    production: day.production.map((p) => ({
      line: p.line, unitCode: p.unitCode,
      quantity: production[`${p.line}.${p.unitCode}`]?.quantity ?? '',
      tongKosong: production[`${p.line}.${p.unitCode}`]?.tongKosong ?? '',
    })),
    cash: { shift1: cash.shift1, shift2: cash.shift2, note: cash.note },
    sales: sales.filter((s) => s.customer && s.product && s.quantity),
    purchases: purchases.filter((p) => p.supplier && p.quantity),
  }), [day, meters, production, cash, sales, purchases])

  const save = useCallback(async () => {
    if (!canWrite) return
    setStatus('saving')
    const res: SaveResult = await saveDay(payload())
    setServerIssues(res.issues)
    if (res.ok) {
      setStatus('saved')
      setSavedAt(new Date().toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit' }))
      dirty.current = false
    } else {
      setStatus('error')
    }
  }, [canWrite, payload])

  // Autosave. Drafts are kept without her having to think about it, but a
  // blocking error is never written — it waits until the entry is valid.
  useEffect(() => {
    if (!dirty.current || blocking || !canWrite) return
    const t = setTimeout(() => { void save() }, 1800)
    return () => clearTimeout(t)
  }, [meters, production, cash, sales, purchases, blocking, canWrite, save])

  const touch = () => { dirty.current = true; setStatus('idle') }

  /** Enter saves and moves on, rather than submitting and reloading the page. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return
    const t = e.target as HTMLElement
    if (t.tagName === 'TEXTAREA') return
    e.preventDefault()
    const focusable = Array.from(
      e.currentTarget.querySelectorAll<HTMLElement>('input, select, button:not([type=button])')
    ).filter((el) => !(el as HTMLInputElement).disabled)
    const i = focusable.indexOf(t)
    if (i >= 0 && i < focusable.length - 1) focusable[i + 1].focus()
    if (!blocking) void save()
  }

  const priceFor = (customer: string, product: string) =>
    day.reference.prices[`${customer}|${product}`] ?? ''

  return (
    <form className="entry" onKeyDown={onKeyDown} onSubmit={(e) => e.preventDefault()}>
      <div className="savebar" role="status" aria-live="polite">
        <span className={`save-state ${status}`}>
          {status === 'saving' ? 'Saving…'
            : status === 'saved' ? `Saved ${savedAt}`
            : status === 'error' ? 'Not saved — fix the errors below'
            : savedAt ? `Last saved ${savedAt}` : 'Not saved yet'}
        </span>
        {canWrite ? (
          <button type="button" onClick={() => void save()} disabled={blocking || status === 'saving'}>
            Save
          </button>
        ) : (
          <span className="readonly-note">Read-only account</span>
        )}
      </div>

      <fieldset disabled={!canWrite}>
        <legend>1 · Meters <span className="bm">(Meter)</span></legend>
        <table className="grid">
          <thead>
            <tr>
              <th>Meter</th>
              <th className="num">Mula <span className="bm">(opening)</span></th>
              <th className="num">Akhir <span className="bm">(closing)</span></th>
              <th className="num">kWh</th>
            </tr>
          </thead>
          <tbody>
            {day.meters.map((m) => {
              const errs = issueFor(`meter.${m.meterCode}`)
              const kwh = meterKwh[m.meterCode]
              return (
                <tr key={m.meterCode}>
                  <th scope="row">{m.label} <span className="bm">{m.labelBm}</span></th>
                  <td className="num muted" data-label="Mula">
                    {m.priorClosing ? fmt(n(m.priorClosing)) : '—'}
                  </td>
                  <td className="num" data-label="Akhir">
                    <input
                      inputMode="decimal"
                      value={meters[m.meterCode]?.closing ?? ''}
                      aria-label={`${m.label} closing reading`}
                      aria-invalid={errs.some((e) => e.severity === 'ERROR')}
                      onChange={(e) => {
                        touch()
                        setMeters((s) => ({
                          ...s,
                          [m.meterCode]: { ...s[m.meterCode], closing: e.target.value },
                        }))
                      }}
                    />
                    {errs.length ? (
                      <div className="issues">
                        {errs.map((e, i) => (
                          <p key={i} className={e.severity.toLowerCase()}>{e.message}</p>
                        ))}
                        {errs.some((e) => /rollover/.test(e.message)) ? (
                          <label className="inline">
                            <input
                              type="checkbox"
                              checked={meters[m.meterCode]?.rollover ?? false}
                              onChange={(e) => {
                                touch()
                                setMeters((s) => ({
                                  ...s,
                                  [m.meterCode]: { ...s[m.meterCode], rollover: e.target.checked },
                                }))
                              }}
                            />
                            Confirm register rollover
                          </label>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                  <td className="num strong" data-label="kWh">{kwh === null ? '—' : fmt(kwh)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </fieldset>

      <fieldset disabled={!canWrite}>
        <legend>2 · Production <span className="bm">(Pengeluaran)</span></legend>
        <table className="grid">
          <tbody>
            {day.production.map((p) => {
              const key = `${p.line}.${p.unitCode}`
              const errs = issueFor(`production.${p.line}.${p.unitCode}`)
              return (
                <tr key={key}>
                  <th scope="row">
                    {p.label}
                    <span className="unit">
                      {p.unitLabel}
                      {p.unitLabelBm.toLowerCase() !== p.unitLabel.toLowerCase() ? (
                        <span className="bm"> {p.unitLabelBm}</span>
                      ) : null}
                    </span>
                  </th>
                  <td className="num" data-label="Quantity">
                    <input
                      inputMode="decimal"
                      value={production[key]?.quantity ?? ''}
                      aria-label={`${p.label} ${p.unitLabel}`}
                      aria-invalid={errs.some((e) => e.severity === 'ERROR')}
                      onChange={(e) => {
                        touch()
                        setProduction((s) => ({
                          ...s, [key]: { ...s[key], quantity: e.target.value },
                        }))
                      }}
                    />
                  </td>
                  <td className="num">
                    {p.unitCode === 'BARIS' ? (
                      <label className="stacked">
                        <span>Tong Kosong</span>
                        <input
                          inputMode="decimal"
                          value={production[key]?.tongKosong ?? ''}
                          aria-label="Tong kosong"
                          onChange={(e) => {
                            touch()
                            setProduction((s) => ({
                              ...s, [key]: { ...s[key], tongKosong: e.target.value },
                            }))
                          }}
                        />
                      </label>
                    ) : null}
                  </td>
                  <td className="num strong" data-label="kg">{fmt(rowKg[key] ?? 0)} kg</td>
                  <td>
                    {errs.map((e, i) => (
                      <p key={i} className={`issue ${e.severity.toLowerCase()}`}>{e.message}</p>
                    ))}
                  </td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={3}>Day total</th>
              <td className="num strong">{fmt(totalKg)} kg</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </fieldset>

      <fieldset disabled={!canWrite}>
        <legend>3 · Counter cash <span className="bm">(Tunai)</span></legend>
        <div className="row">
          <label className="stacked">
            <span>Shift 1</span>
            <input
              inputMode="decimal" value={cash.shift1}
              onChange={(e) => { touch(); setCash((c) => ({ ...c, shift1: e.target.value })) }}
            />
          </label>
          <label className="stacked">
            <span>Shift 2</span>
            <input
              inputMode="decimal" value={cash.shift2}
              onChange={(e) => { touch(); setCash((c) => ({ ...c, shift2: e.target.value })) }}
            />
          </label>
          <div className="stacked">
            <span>Total</span>
            <output className="strong">RM {fmt(cashTotal, 2)}</output>
          </div>
        </div>
        {issueFor('cash.total').map((e, i) => (
          <div key={i} className={`issue ${e.severity.toLowerCase()}`}>
            {e.message}
            {e.requiresNote ? (
              <input
                className="note-input" placeholder="Reason (required)"
                value={cash.note}
                onChange={(ev) => { touch(); setCash((c) => ({ ...c, note: ev.target.value })) }}
              />
            ) : null}
          </div>
        ))}
      </fieldset>

      <fieldset disabled={!canWrite}>
        <legend>4 · Outside sales <span className="bm">(Jualan Luar)</span></legend>
        <table className="grid">
          <thead>
            <tr>
              <th>Customer</th><th>Product</th>
              <th className="num">Qty</th><th className="num">Price</th><th className="num">Amount</th><th />
            </tr>
          </thead>
          <tbody>
            {sales.map((s, i) => (
              <tr key={i}>
                <td data-label="Customer">
                  <select
                    value={s.customer} aria-label={`Customer, row ${i + 1}`}
                    onChange={(e) => {
                      touch()
                      const customer = e.target.value
                      setSales((rows) => rows.map((r, j) => j === i
                        ? { ...r, customer, unitPrice: priceFor(customer, r.product) || r.unitPrice }
                        : r))
                    }}
                  >
                    <option value="">—</option>
                    {day.reference.customers.map((c) => (
                      <option key={c.name} value={c.name}>{c.name}</option>
                    ))}
                  </select>
                </td>
                <td data-label="Product">
                  <select
                    value={s.product} aria-label={`Product, row ${i + 1}`}
                    onChange={(e) => {
                      touch()
                      const product = e.target.value
                      setSales((rows) => rows.map((r, j) => j === i
                        ? { ...r, product, unitPrice: priceFor(r.customer, product) || r.unitPrice }
                        : r))
                    }}
                  >
                    <option value="">—</option>
                    {day.reference.products.map((p) => (
                      <option key={p.code} value={p.code}>{p.name}</option>
                    ))}
                  </select>
                </td>
                <td className="num" data-label="Qty">
                  <input
                    inputMode="decimal" value={s.quantity} aria-label={`Quantity, row ${i + 1}`}
                    onChange={(e) => {
                      touch()
                      setSales((rows) => rows.map((r, j) =>
                        j === i ? { ...r, quantity: e.target.value } : r))
                    }}
                  />
                </td>
                <td className="num" data-label="Price">
                  {/* Auto-filled from the dated price list, and overridable —
                      the figure that is stored is whatever stands here. */}
                  <input
                    inputMode="decimal" value={s.unitPrice} aria-label={`Unit price, row ${i + 1}`}
                    onChange={(e) => {
                      touch()
                      setSales((rows) => rows.map((r, j) =>
                        j === i ? { ...r, unitPrice: e.target.value } : r))
                    }}
                  />
                </td>
                <td className="num strong" data-label="Amount">{fmt(n(s.quantity) * n(s.unitPrice), 2)}</td>
                <td>
                  <button
                    type="button" className="linkish"
                    onClick={() => { touch(); setSales((rows) => rows.filter((_, j) => j !== i)) }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={4}>Total</th>
              <td className="num strong">{fmt(salesTotal, 2)}</td>
              <td>
                <button
                  type="button" className="linkish"
                  onClick={() => setSales((r) => [...r, { customer: '', product: '', quantity: '', unitPrice: '' }])}
                >
                  Add row
                </button>
              </td>
            </tr>
          </tfoot>
        </table>
      </fieldset>

      <fieldset disabled={!canWrite}>
        <legend>5 · Purchases <span className="bm">(Belian)</span></legend>
        <table className="grid">
          <thead>
            <tr>
              <th>Supplier</th><th>DO no.</th>
              <th className="num">Qty</th><th className="num">Price</th><th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {purchases.map((p, i) => (
              <tr key={i}>
                <td data-label="Supplier">
                  <select
                    value={p.supplier} aria-label={`Supplier, row ${i + 1}`}
                    onChange={(e) => {
                      touch()
                      const supplier = e.target.value
                      setPurchases((rows) => rows.map((r, j) => j === i
                        ? { ...r, supplier, unitPrice: priceFor(supplier, 'BIG_BLOCK') || r.unitPrice }
                        : r))
                    }}
                  >
                    <option value="">—</option>
                    {day.reference.suppliers.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </td>
                <td data-label="DO no.">
                  <input
                    value={p.doNo} aria-label={`DO number, row ${i + 1}`}
                    onChange={(e) => {
                      touch()
                      setPurchases((rows) => rows.map((r, j) =>
                        j === i ? { ...r, doNo: e.target.value } : r))
                    }}
                  />
                </td>
                <td className="num" data-label="Qty">
                  <input
                    inputMode="decimal" value={p.quantity} aria-label={`Purchase quantity, row ${i + 1}`}
                    onChange={(e) => {
                      touch()
                      setPurchases((rows) => rows.map((r, j) =>
                        j === i ? { ...r, quantity: e.target.value } : r))
                    }}
                  />
                </td>
                <td className="num" data-label="Price">
                  <input
                    inputMode="decimal" value={p.unitPrice} aria-label={`Purchase price, row ${i + 1}`}
                    onChange={(e) => {
                      touch()
                      setPurchases((rows) => rows.map((r, j) =>
                        j === i ? { ...r, unitPrice: e.target.value } : r))
                    }}
                  />
                </td>
                <td className="num strong" data-label="Amount">{fmt(n(p.quantity) * n(p.unitPrice), 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </fieldset>

      {serverIssues.length ? (
        <div className="server-issues">
          {serverIssues.map((e, i) => (
            <p key={i} className={`issue ${e.severity.toLowerCase()}`}>{e.message}</p>
          ))}
        </div>
      ) : null}
    </form>
  )
}
