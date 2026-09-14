/**
 * Domain lookups that everything else builds on.
 *
 * Every dated value — a pack size, a cost assumption, a price — is resolved
 * "as at" a business date, never as a current value. Restating an assumption
 * must change future costings without silently rewriting history.
 */
import { Decimal, d, type Numeric } from './money'

export type LineCode = 'TUBE' | 'BIG_POOL' | 'BIMC' | 'SMALL_POOL'
export type UnitCode = 'BAG' | 'TONG' | 'BARIS' | 'SMALL_TONG' | 'BLOK'

export interface DatedValue {
  effectiveFrom: string
  value: Numeric
}

/** The value in force on `date`, or null when nothing was in force yet. */
export function asAt<T extends { effectiveFrom: string }>(
  rows: T[],
  date: string
): T | null {
  let best: T | null = null
  for (const r of rows) {
    if (r.effectiveFrom <= date && (!best || r.effectiveFrom > best.effectiveFrom)) {
      best = r
    }
  }
  return best
}

export interface AssumptionRow {
  key: string
  effectiveFrom: string
  value: Numeric
  measured?: boolean
}

export class Assumptions {
  constructor(private rows: AssumptionRow[]) {}

  /** Throws rather than defaulting: a silent zero here would understate cost. */
  at(key: string, date: string): Decimal {
    const row = asAt(
      this.rows.filter((r) => r.key === key),
      date
    )
    if (!row) {
      throw new Error(
        `No value for cost assumption "${key}" as at ${date}. Seed one with an ` +
          `effective_from on or before that date.`
      )
    }
    return d(row.value)
  }

  isMeasured(key: string, date: string): boolean {
    const row = asAt(this.rows.filter((r) => r.key === key), date)
    return row?.measured === true
  }
}

export interface UnitRow {
  line: LineCode
  unitCode: UnitCode
  kgPerUnit: Numeric | null
  effectiveFrom: string
}

/**
 * Kilograms for a production row, as at its date.
 *
 * BARIS is the one unit whose kg is not a simple multiple: a row of the big pool
 * holds `blocks_per_baris` cans, minus however many came out empty, each of
 * `BLOK` weight. Keeping `blocks_per_baris` and `tong_kosong` as separate inputs
 * rather than folding them into one number is what makes the arithmetic
 * checkable afterwards.
 */
export function productionKg(
  units: UnitRow[],
  assumptions: Assumptions,
  row: {
    line: LineCode
    unitCode: UnitCode
    quantity: Numeric
    tongKosong?: Numeric
    prodDate: string
  }
): Decimal {
  const qty = d(row.quantity)

  if (row.unitCode === 'BARIS') {
    const perBaris = assumptions.at(
      row.line === 'SMALL_POOL' ? 'small_pool_blocks_per_baris' : 'blocks_per_baris',
      row.prodDate
    )
    const blockKg = unitKg(units, row.line, 'BLOK', row.prodDate)
    const blocks = qty.times(perBaris).minus(d(row.tongKosong ?? 0))
    return blocks.isNegative() ? d(0) : blocks.times(blockKg)
  }

  return qty.times(unitKg(units, row.line, row.unitCode, row.prodDate))
}

export function unitKg(
  units: UnitRow[],
  line: LineCode,
  unitCode: UnitCode,
  date: string
): Decimal {
  const row = asAt(
    units.filter((u) => u.line === line && u.unitCode === unitCode),
    date
  )
  if (!row || row.kgPerUnit === null) {
    throw new Error(
      `No kg per unit for ${line}/${unitCode} as at ${date}. The small block ` +
        `weight differs by line — 38 kg on the small pool, 45 kg on BIMC — so a ` +
        `missing row here would silently mis-state tonnage.`
    )
  }
  return d(row.kgPerUnit)
}

/** Cash total. Deliberately derived, never stored — a stored total can drift. */
export const cashTotal = (shift1: Numeric, shift2: Numeric): Decimal =>
  d(shift1).plus(d(shift2))

export const addDays = (iso: string, n: number): string => {
  const t = new Date(`${iso}T00:00:00Z`)
  t.setUTCDate(t.getUTCDate() + n)
  return t.toISOString().slice(0, 10)
}

export const monthOf = (iso: string): string => `${iso.slice(0, 7)}-01`

export function eachDate(from: string, to: string): string[] {
  const out: string[] = []
  for (let cur = from; cur <= to; cur = addDays(cur, 1)) out.push(cur)
  return out
}
