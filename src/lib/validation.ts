/**
 * Entry validation.
 *
 * These rules run in the browser for immediate feedback AND on the server
 * before anything is written. They live here, once, so the two can never drift:
 * client-side validation is a courtesy, the server copy is the truth.
 *
 * Soft warnings never block. She knows the plant better than the rule does;
 * a warning she can pass with a note is worth more than a rule that stops her
 * keying a genuine outlier at six in the morning.
 */
import { Decimal, d, type Numeric } from './money'

export type Severity = 'ERROR' | 'WARN'

export interface Issue {
  severity: Severity
  field: string
  message: string
  /** WARNs can be accepted; the note is kept with the row. */
  requiresNote?: boolean
}

export interface MeterInput {
  meterCode: string
  label: string
  closing: Numeric | null
  priorClosing: Numeric | null
  priorDate: string | null
  digits: number
  rolloverConfirmed?: boolean
  /** Trailing mean of recent daily kWh, for the outlier check. */
  trailingMean?: Numeric | null
}

/**
 * A closing below the prior reading is either a register rollover or a keyed
 * digit out of place. The legacy sheets resolved it by subtracting from zero
 * and carrying a seven-figure negative into the monthly total, so this one is
 * a hard stop until somebody says which it is.
 */
export function validateMeter(input: MeterInput): Issue[] {
  const out: Issue[] = []
  const field = `meter.${input.meterCode}`

  if (input.closing === null || input.closing === '') return out
  const closing = d(input.closing)

  if (closing.isNegative()) {
    out.push({ severity: 'ERROR', field, message: 'A meter reading cannot be negative.' })
    return out
  }

  if (input.priorClosing === null) {
    out.push({
      severity: 'WARN',
      field,
      message:
        `No earlier reading for ${input.label}, so this day's consumption cannot ` +
        `be worked out yet. It will resolve once the previous day is entered.`,
    })
    return out
  }

  const prior = d(input.priorClosing)
  if (closing.lessThan(prior)) {
    if (!input.rolloverConfirmed) {
      out.push({
        severity: 'ERROR',
        field,
        message:
          `${input.label} reads ${closing.toString()}, below the previous reading of ` +
          `${prior.toString()}${input.priorDate ? ` on ${input.priorDate}` : ''}. ` +
          `Confirm a register rollover, or correct the entry.`,
      })
      return out
    }
    const wrap = d(10).pow(input.digits)
    const delta = closing.plus(wrap).minus(prior)
    if (delta.greaterThan(wrap.dividedBy(2))) {
      out.push({
        severity: 'ERROR',
        field,
        message:
          `A rollover here would imply ${delta.toFixed(0)} kWh in one day, which is ` +
          `not plausible for a ${input.digits}-digit register.`,
      })
    }
    return out
  }

  const kwh = closing.minus(prior)
  const mean = input.trailingMean ? d(input.trailingMean) : null
  if (mean && mean.greaterThan(0)) {
    const ratio = kwh.dividedBy(mean)
    if (ratio.greaterThan('1.4') || ratio.lessThan('0.6')) {
      out.push({
        severity: 'WARN',
        field,
        requiresNote: true,
        message:
          `${kwh.toFixed(0)} kWh is ${ratio.greaterThan(1) ? 'above' : 'below'} the ` +
          `recent daily average of ${mean.toFixed(0)} kWh by more than 40%. ` +
          `Check the reading, then add a note if it is right.`,
      })
    }
  }

  return out
}

export interface ProductionInput {
  line: string
  label: string
  unitCode: string
  quantity: Numeric | null
  tongKosong?: Numeric | null
  focQuantity?: Numeric | null
  blocksPerBaris?: Numeric
}

export function validateProduction(input: ProductionInput): Issue[] {
  const out: Issue[] = []
  const field = `production.${input.line}.${input.unitCode}`

  if (input.quantity === null || input.quantity === '') return out
  const qty = d(input.quantity)

  if (qty.isNegative()) {
    out.push({ severity: 'ERROR', field, message: `${input.label} cannot be negative.` })
    return out
  }

  const kosong = input.tongKosong ? d(input.tongKosong) : d(0)
  if (kosong.isNegative()) {
    out.push({ severity: 'ERROR', field, message: 'Tong kosong cannot be negative.' })
  }

  // Empty cans cannot exceed the cans in the rows that were filled.
  if (input.unitCode === 'BARIS' && input.blocksPerBaris) {
    const cans = qty.times(d(input.blocksPerBaris))
    if (kosong.greaterThan(cans)) {
      out.push({
        severity: 'ERROR',
        field,
        message:
          `Tong kosong (${kosong.toString()}) is more than the ${cans.toString()} cans ` +
          `in ${qty.toString()} baris. It cannot exceed what was filled.`,
      })
    }
  }

  const foc = input.focQuantity ? d(input.focQuantity) : d(0)
  if (foc.isNegative()) {
    out.push({ severity: 'ERROR', field, message: 'FOC cannot be negative.' })
  }
  if (foc.greaterThan(qty)) {
    out.push({
      severity: 'ERROR',
      field,
      message: `FOC (${foc.toString()}) is more than the ${qty.toString()} produced.`,
    })
  }

  return out
}

export interface CashInput {
  shift1: Numeric | null
  shift2: Numeric | null
  isHoliday?: boolean
  note?: string | null
}

export function validateCash(input: CashInput): Issue[] {
  const out: Issue[] = []
  for (const [key, v] of [['shift1', input.shift1], ['shift2', input.shift2]] as const) {
    if (v === null || v === '') continue
    if (d(v).isNegative()) {
      out.push({ severity: 'ERROR', field: `cash.${key}`, message: 'Cash cannot be negative.' })
    }
  }
  const total = d(input.shift1 ?? 0).plus(d(input.shift2 ?? 0))
  if (total.isZero() && !input.isHoliday) {
    out.push({
      severity: 'WARN',
      field: 'cash.total',
      requiresNote: true,
      message: 'No counter cash on a working day. Confirm the counter was closed.',
    })
  }
  return out
}

export interface SaleInput {
  index: number
  customer: string | null
  product: string | null
  quantity: Numeric | null
  unitPrice: Numeric | null
}

export function validateSale(s: SaleInput): Issue[] {
  const out: Issue[] = []
  const field = `sale.${s.index}`
  const blank = !s.customer && !s.product && !s.quantity
  if (blank) return out

  if (!s.customer) out.push({ severity: 'ERROR', field, message: 'Choose a customer.' })
  if (!s.product) out.push({ severity: 'ERROR', field, message: 'Choose a product.' })
  if (s.quantity === null || s.quantity === '') {
    out.push({ severity: 'ERROR', field, message: 'Enter a quantity.' })
  } else if (d(s.quantity).isNegative()) {
    out.push({ severity: 'ERROR', field, message: 'Quantity cannot be negative.' })
  }
  if (s.unitPrice !== null && s.unitPrice !== '' && d(s.unitPrice).isNegative()) {
    out.push({ severity: 'ERROR', field, message: 'Price cannot be negative.' })
  }
  return out
}

/**
 * Sub-metered consumption over a bill period cannot exceed what TNB billed for
 * the whole site. If it does, a reading is miskeyed — the sub-meters are a
 * subset of the site by construction.
 */
export function validateAgainstBill(
  subMeterKwh: Numeric,
  billedKwh: Numeric
): Issue[] {
  if (d(subMeterKwh).greaterThan(d(billedKwh))) {
    return [{
      severity: 'ERROR',
      field: 'period',
      message:
        `Sub-meter consumption (${d(subMeterKwh).toFixed(0)} kWh) exceeds the billed ` +
        `site total (${d(billedKwh).toFixed(0)} kWh). The sub-meters are part of the ` +
        `site, so a reading is miskeyed.`,
    }]
  }
  return []
}

export const hasBlocking = (issues: Issue[]): boolean =>
  issues.some((i) => i.severity === 'ERROR')

export const needsNote = (issues: Issue[]): boolean =>
  issues.some((i) => i.severity === 'WARN' && i.requiresNote)

/** Mean of the trailing N daily values that exist — never a hardcoded divisor. */
export function trailingMean(values: Numeric[], window = 7): Decimal | null {
  const recent = values.slice(-window)
  if (!recent.length) return null
  return recent.reduce<Decimal>((a, v) => a.plus(d(v)), d(0)).dividedBy(recent.length)
}
