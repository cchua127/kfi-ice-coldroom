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

// ---------------------------------------------------------------------------
// The monthly inputs
// ---------------------------------------------------------------------------

export interface ColdroomMonthInputCheck {
  meteredKwh: Numeric | null
  ratonoRm: Numeric | null
  yemintRm: Numeric | null
  iceStoreInvoicedRm: Numeric | null
  legacyFactor: Numeric
  tenantRate: Numeric
  /**
   * True when the month already has an imported meter register. Everything
   * below is then a fallback nobody needs, so the warnings about a missing
   * reading are not only unhelpful but false — the meter WAS read, room by room.
   */
  hasRegister?: boolean
}

/**
 * The coldroom month.
 *
 * The rule that matters here is the one about a blank. A blank meter reading
 * means "not read" and sends the whole month down the back-inference path; a
 * zero means "the coldroom drew nothing", which for rooms holding -18C is not
 * a thing that happens. The legacy sheets could not tell those apart, which is
 * how a missing reading became a real zero in a total.
 */
export function validateColdroomMonth(input: ColdroomMonthInputCheck): Issue[] {
  const out: Issue[] = []
  const metered = input.meteredKwh === null || input.meteredKwh === '' ? null : d(input.meteredKwh)
  const compilation = d(input.ratonoRm ?? 0).plus(d(input.yemintRm ?? 0))
  const iceStore = d(input.iceStoreInvoicedRm ?? 0)

  for (const [field, value] of [
    ['coldroom.meteredKwh', metered],
    ['coldroom.ratonoRm', input.ratonoRm === null || input.ratonoRm === '' ? null : d(input.ratonoRm)],
    ['coldroom.yemintRm', input.yemintRm === null || input.yemintRm === '' ? null : d(input.yemintRm)],
    [
      'coldroom.iceStoreInvoicedRm',
      input.iceStoreInvoicedRm === null || input.iceStoreInvoicedRm === ''
        ? null
        : d(input.iceStoreInvoicedRm),
    ],
  ] as const) {
    if (value !== null && value.isNegative()) {
      out.push({ severity: 'ERROR', field, message: 'This figure cannot be negative.' })
    }
  }

  if (metered !== null && metered.isZero()) {
    out.push({
      severity: 'ERROR',
      field: 'coldroom.meteredKwh',
      message:
        'A coldroom holding temperature does not draw zero. Leave the field ' +
        'BLANK if the meter was not read — blank and zero mean different things ' +
        'here, and zero would be treated as a measurement.',
    })
  }

  if (metered === null && compilation.isZero() && !iceStore.isZero()) {
    out.push({
      severity: 'ERROR',
      field: 'coldroom.ratonoRm',
      message:
        'D10-D12 is invoiced but no compilation and no meter reading were given. ' +
        'The tenant rooms would come out negative and be clamped to zero.',
    })
  }

  // A month read room by room needs none of the fallback warnings below: the
  // compilations are not consulted, so their absence is not a gap.
  if (input.hasRegister) return out

  if (metered === null && !compilation.isZero()) {
    out.push({
      severity: 'WARN',
      field: 'coldroom.meteredKwh',
      message:
        'No sub-meter reading, so the month will be BACK-INFERRED by dividing ' +
        `RM${compilation.toFixed(2)} by the frozen ${d(input.legacyFactor).toFixed(4)} ` +
        'RM/kWh factor. That rate has been stale since July 2025 and every ' +
        'coldroom figure this month inherits it.',
    })
  }

  if (metered !== null) {
    const iceStoreKwh = iceStore.dividedBy(d(input.tenantRate))
    if (iceStoreKwh.greaterThan(metered)) {
      out.push({
        severity: 'ERROR',
        field: 'coldroom.iceStoreInvoicedRm',
        message:
          `D10-D12 works out at ${iceStoreKwh.toFixed(0)} kWh, more than the ` +
          `${metered.toFixed(0)} kWh on the whole-room meter. One of the two is wrong.`,
      })
    }
  }

  if (metered === null && compilation.isZero() && iceStore.isZero()) {
    out.push({
      severity: 'WARN',
      field: 'coldroom.meteredKwh',
      message:
        'Nothing entered for the coldroom. The whole coldroom load will sit ' +
        'inside the unaccounted residual on the site energy statement.',
    })
  }

  return out
}

export interface WaterMonthInputCheck {
  tonnes: Numeric | null
  retailM3: Numeric | null
  /** The month before, for the outlier check. Null when there is none. */
  priorTonnes?: Numeric | null
}

/** Water delivery. Volumes move slowly, so a large step is worth a question. */
export function validateWaterMonth(input: WaterMonthInputCheck): Issue[] {
  const out: Issue[] = []
  const tonnes = input.tonnes === null || input.tonnes === '' ? null : d(input.tonnes)
  const retail = input.retailM3 === null || input.retailM3 === '' ? null : d(input.retailM3)

  for (const [field, value] of [
    ['water.tonnes', tonnes],
    ['water.retailM3', retail],
  ] as const) {
    if (value !== null && value.isNegative()) {
      out.push({ severity: 'ERROR', field, message: 'This figure cannot be negative.' })
    }
  }

  if (
    tonnes !== null &&
    input.priorTonnes !== null &&
    input.priorTonnes !== undefined &&
    !d(input.priorTonnes).isZero()
  ) {
    const move = tonnes.minus(d(input.priorTonnes)).dividedBy(d(input.priorTonnes)).abs()
    if (move.greaterThan(d('0.25'))) {
      out.push({
        severity: 'WARN',
        field: 'water.tonnes',
        message:
          `${move.times(100).toFixed(0)}% away from last month's delivery. ` +
          'Confirm the figure, or note what changed.',
      })
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// The coldroom register
// ---------------------------------------------------------------------------

export interface RegisterRowCheck {
  /** 1-based position on the screen, for addressing the issue back to a row. */
  rowNo: number
  roomCode: string
  tenantLabel: string | null
  ownUse: boolean
  openingKwh: Numeric | null
  closingKwh: Numeric | null
  rateRmPerKwh: Numeric | null
  /** Set when the register was swapped, which is the only sane reason to go backwards. */
  meterReplaced?: boolean
  /** Last month's closing for this room, where there was one. */
  priorClosing?: Numeric | null
}

/**
 * One row of the register.
 *
 * The rule that earns its place here is the one about going backwards. A
 * closing below the opening is either a replaced register or a transposed
 * digit, and the legacy sheets resolved exactly this situation by subtracting
 * from zero and carrying the result into a monthly total. It is a hard stop
 * until somebody says which it is.
 */
export function validateRegisterRow(row: RegisterRowCheck): Issue[] {
  const out: Issue[] = []
  const field = `register.${row.rowNo}`
  const blank = (v: Numeric | null) => v === null || v === ''

  if (!row.roomCode.trim()) {
    out.push({ severity: 'ERROR', field: `${field}.roomCode`, message: 'A row needs a room.' })
  }

  // A row with no closing is simply not filled in yet — normal mid-entry, and
  // never an error. It is skipped on save rather than stored as a zero.
  if (blank(row.closingKwh)) return out

  const closing = d(row.closingKwh as Numeric)
  if (closing.isNegative()) {
    out.push({
      severity: 'ERROR', field: `${field}.closingKwh`,
      message: 'A meter reading cannot be negative.',
    })
    return out
  }

  if (blank(row.openingKwh)) {
    out.push({
      severity: 'ERROR', field: `${field}.openingKwh`,
      message:
        `${row.roomCode}: no opening reading. Carry last month's closing forward, ` +
        `or key the opening if this room is new.`,
    })
    return out
  }

  const opening = d(row.openingKwh as Numeric)
  if (closing.lessThan(opening)) {
    out.push(
      row.meterReplaced
        ? {
            severity: 'WARN', field: `${field}.closingKwh`,
            message:
              `${row.roomCode}: register replaced, so this month counts from ` +
              `${opening} to ${closing}. Confirm the new meter's starting figure.`,
            requiresNote: true,
          }
        : {
            severity: 'ERROR', field: `${field}.closingKwh`,
            message:
              `${row.roomCode}: closing ${closing} is below opening ${opening}. ` +
              `Tick "meter replaced" if the register was swapped, or correct the reading.`,
          }
    )
  }

  if (blank(row.rateRmPerKwh)) {
    out.push({
      severity: 'ERROR', field: `${field}.rateRmPerKwh`,
      message: `${row.roomCode}: no rate, so this room cannot be recharged.`,
    })
  } else if (d(row.rateRmPerKwh as Numeric).isNegative()) {
    out.push({
      severity: 'ERROR', field: `${field}.rateRmPerKwh`,
      message: `${row.roomCode}: the rate cannot be negative.`,
    })
  }

  // The chain is the thing that makes a monthly register trustworthy: this
  // month's opening should be last month's closing. A silent break means a
  // room's consumption has gone missing or been counted twice.
  if (
    row.priorClosing !== null && row.priorClosing !== undefined &&
    !row.meterReplaced &&
    !opening.equals(d(row.priorClosing))
  ) {
    out.push({
      severity: 'WARN', field: `${field}.openingKwh`,
      message:
        `${row.roomCode}: opening ${opening} does not match last month's closing ` +
        `${d(row.priorClosing)}. ${opening.greaterThan(d(row.priorClosing))
          ? 'Consumption between the two readings is not recorded anywhere.'
          : 'This month would count consumption already billed last month.'}`,
      requiresNote: true,
    })
  }

  if (row.ownUse !== isOwnUseLabel(row.tenantLabel)) {
    out.push({
      severity: 'WARN', field: `${field}.ownUse`,
      message: row.ownUse
        ? `${row.roomCode} is marked as KFI's own use but the occupant reads ` +
          `"${row.tenantLabel ?? 'blank'}". Its power goes to cost of ice.`
        : `${row.roomCode}'s occupant reads as KFI but the row is not marked own ` +
          `use, so its power will be recharged to a tenant instead of costed to ice.`,
    })
  }

  return out
}

/**
 * Whether an occupant label reads as KFI itself.
 *
 * Deliberately duplicated from the importer's `isOwnUseTenant` rather than
 * imported: validation must not pull in the import stack, which drags the
 * workbook types into the browser bundle. The two are tested against each other
 * so they cannot drift apart silently.
 */
export const isOwnUseLabel = (label: string | null): boolean =>
  /^kfi\b/i.test((label ?? '').trim())

/** The whole register for a month, after every row has been checked. */
export function validateRegister(rows: RegisterRowCheck[]): Issue[] {
  const out = rows.flatMap(validateRegisterRow)

  const filled = rows.filter((r) => r.closingKwh !== null && r.closingKwh !== '')
  if (!filled.length) {
    out.push({
      severity: 'WARN', field: 'register',
      message:
        'No readings entered. Saving now removes the month from the register and ' +
        'the coldroom falls back to the ringgit compilations.',
    })
    return out
  }

  // Two rooms on one code is normal here — there are two D5s, and a room re-let
  // mid-month appears twice. What is NOT normal is the same room read twice from
  // the same opening, which means a row was duplicated rather than split.
  const seen = new Map<string, number[]>()
  rows.forEach((r, i) => {
    const key = `${r.roomCode.trim().toUpperCase()}|${r.openingKwh ?? ''}`
    seen.set(key, [...(seen.get(key) ?? []), i + 1])
  })
  for (const [key, at] of seen) {
    if (at.length > 1 && key.split('|')[1] !== '') {
      out.push({
        severity: 'ERROR', field: `register.${at[1]}`,
        message:
          `Rows ${at.join(' and ')} read ${key.split('|')[0]} from the same opening. ` +
          `A room re-let mid-month runs continuously — the first row's closing is ` +
          `the second row's opening — so this is a duplicated row, not a split.`,
      })
    }
  }

  if (!filled.some((r) => r.ownUse)) {
    out.push({
      severity: 'WARN', field: 'register',
      message:
        'No room is marked as KFI\'s own use this month, so none of the coldroom ' +
        'will be costed to ice. Correct if D10-D12 were in use.',
    })
  }

  return out
}
