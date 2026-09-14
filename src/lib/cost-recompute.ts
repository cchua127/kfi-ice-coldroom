/**
 * Turns daily entry into stored, dated cost rows.
 *
 * Kept pure — data in, rows out — so the arithmetic can be tested without a
 * database. The thin wrapper that reads and writes lives in scripts/recompute.ts.
 *
 * She keys in daily; the truth arrives monthly; this is what restates itself
 * instead of her. Confirming a bill re-runs the affected dates and flips them
 * from PROVISIONAL to FINAL.
 */
import { Decimal, d, rm, type Numeric } from './money'
import type { DailyRate } from './cost-engine'
import { Assumptions, productionKg, addDays, type LineCode, type UnitCode, type UnitRow } from './domain'

export interface ReadingRow {
  meterCode: string
  readingDate: string
  closing: Numeric
  ctMultiplier?: Numeric
}

export interface ProductionRow {
  line: LineCode
  unitCode: UnitCode
  prodDate: string
  quantity: Numeric
  tongKosong?: Numeric
  focQuantity?: Numeric
  quantitySource?: 'COUNTED' | 'CONVENTION'
}

export interface DailyLineCostRow {
  costDate: string
  line: LineCode
  kwh: Decimal
  kwhSource: 'METERED' | 'MODELLED'
  kg: Decimal
  focKg: Decimal
  ratePerKwh: Decimal
  costRm: Decimal
  status: 'PROVISIONAL' | 'FINAL'
  /** Why this day carries the rate it does. Surfaced in reports. */
  rateBasis: DailyRate['basis']
  /** False when nothing was available to cost with — kWh and kg still stand. */
  rateAvailable: boolean
  /**
   * How many days the metered delta covers. Greater than one means entry was
   * missed and this day carries its neighbours' consumption too — visible in
   * reports rather than quietly averaged away.
   */
  spansDays: number
  /** True when any input was a standing convention rather than a count. */
  fromConvention: boolean
}

/** Which meter feeds which line. BIMC has none — it is modelled. */
const METER_FOR_LINE: Partial<Record<LineCode, string>> = {
  TUBE: 'TUBE',
  BIG_POOL: 'BIG_POOL',
  SMALL_POOL: 'SMALL_POOL',
}

export interface RecomputeInput {
  from: string
  to: string
  readings: ReadingRow[]
  production: ProductionRow[]
  units: UnitRow[]
  assumptions: Assumptions
  rates: DailyRate[]
  /** Lines to cost. Defaults to everything that has production or a meter. */
  lines?: LineCode[]
}

/** Metered consumption for each date, measured against the previous reading. */
function meteredByDate(
  readings: ReadingRow[],
  meterCode: string
): Map<string, { kwh: Decimal; spansDays: number }> {
  const rows = readings
    .filter((r) => r.meterCode === meterCode)
    .sort((a, b) => (a.readingDate < b.readingDate ? -1 : 1))

  const out = new Map<string, { kwh: Decimal; spansDays: number }>()
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1]
    const cur = rows[i]
    const delta = d(cur.closing).minus(d(prev.closing))
    // A negative delta is a rollover or a keying error, and either way must be
    // resolved on the entry screen rather than guessed at here.
    if (delta.isNegative()) continue

    let spans = 0
    for (let c = prev.readingDate; c < cur.readingDate; c = addDays(c, 1)) spans++
    out.set(cur.readingDate, {
      kwh: rm(delta.times(d(cur.ctMultiplier ?? 1))),
      spansDays: Math.max(spans, 1),
    })
  }
  return out
}

export function recompute(input: RecomputeInput): DailyLineCostRow[] {
  const rateByDate = new Map(input.rates.map((r) => [r.date, r]))
  const metered = new Map<string, ReturnType<typeof meteredByDate>>()
  for (const [line, meterCode] of Object.entries(METER_FOR_LINE)) {
    metered.set(line, meteredByDate(input.readings, meterCode!))
  }

  // Production, grouped by date and line.
  const prodByKey = new Map<string, ProductionRow[]>()
  for (const p of input.production) {
    const key = `${p.prodDate}|${p.line}`
    prodByKey.set(key, [...(prodByKey.get(key) ?? []), p])
  }

  const lines: LineCode[] =
    input.lines ??
    ([...new Set([
      ...input.production.map((p) => p.line),
      ...Object.keys(METER_FOR_LINE),
    ])] as LineCode[])

  const out: DailyLineCostRow[] = []

  for (let date = input.from; date <= input.to; date = addDays(date, 1)) {
    const rate = rateByDate.get(date)
    if (!rate) continue

    for (const line of lines) {
      const rows = prodByKey.get(`${date}|${line}`) ?? []

      let kg = d(0)
      let focKg = d(0)
      let fromConvention = false
      for (const p of rows) {
        kg = kg.plus(productionKg(input.units, input.assumptions, p))
        if (p.focQuantity) {
          focKg = focKg.plus(
            productionKg(input.units, input.assumptions, { ...p, quantity: p.focQuantity })
          )
        }
        if (p.quantitySource === 'CONVENTION') fromConvention = true
      }

      let kwh = d(0)
      let kwhSource: 'METERED' | 'MODELLED' = 'MODELLED'
      let spansDays = 1

      const meter = metered.get(line)?.get(date)
      if (meter) {
        kwh = meter.kwh
        kwhSource = 'METERED'
        spansDays = meter.spansDays
      } else if (line === 'BIMC') {
        // Modelled from booked blocks. The per-block figure is calibrated
        // against the bills, not measured, and says so in its note.
        const blocks = rows
          .filter((p) => p.unitCode === 'SMALL_TONG')
          .reduce<Decimal>((a, p) => a.plus(d(p.quantity)), d(0))
        if (blocks.isZero()) continue
        kwh = rm(blocks.times(input.assumptions.at('bimc_kwh_per_block', date)))
        kwhSource = 'MODELLED'
      } else if (kg.isZero()) {
        continue
      }

      if (kwh.isZero() && kg.isZero()) continue

      out.push({
        costDate: date,
        line,
        kwh,
        kwhSource,
        kg,
        focKg,
        ratePerKwh: rate.ratePerKwh,
        costRm: rm(kwh.times(rate.ratePerKwh)),
        status: rate.status,
        rateBasis: rate.basis,
        rateAvailable: rate.basis !== 'NO_RATE',
        spansDays,
        fromConvention,
      })
    }
  }

  return out
}

export interface MonthlySummary {
  month: string
  iceKwh: Decimal
  iceKg: Decimal
  iceCostRm: Decimal
  kwhPerKg: Decimal
  /** Null when no day in the month had a rate to cost with. */
  rmPerKg: Decimal | null
  focKg: Decimal
  /** PROVISIONAL when any contributing day is. No report may mix the two silently. */
  status: 'PROVISIONAL' | 'FINAL'
  daysWithData: number
  /** Days in the month with no rate available at all. */
  daysWithoutRate: number
}

const ICE_LINES: LineCode[] = ['TUBE', 'BIG_POOL', 'BIMC', 'SMALL_POOL']

/**
 * Monthly ratios come from monthly totals, never from an average of daily
 * ratios, and the day count is the days that actually have data — the legacy
 * sheet summed its ratio columns and divided by a hardcoded 13.
 */
export function summariseMonths(rows: DailyLineCostRow[]): MonthlySummary[] {
  const byMonth = new Map<string, DailyLineCostRow[]>()
  for (const r of rows) {
    if (!ICE_LINES.includes(r.line)) continue
    const m = r.costDate.slice(0, 7)
    byMonth.set(m, [...(byMonth.get(m) ?? []), r])
  }

  return [...byMonth.entries()]
    .sort()
    .map(([month, list]) => {
      const iceKwh = list.reduce<Decimal>((a, r) => a.plus(r.kwh), d(0))
      const iceKg = list.reduce<Decimal>((a, r) => a.plus(r.kg), d(0))
      const iceCostRm = list.reduce<Decimal>((a, r) => a.plus(r.costRm), d(0))
      const focKg = list.reduce<Decimal>((a, r) => a.plus(r.focKg), d(0))
      const priced = list.filter((r) => r.rateAvailable)
      const pricedKg = priced.reduce<Decimal>((a, r) => a.plus(r.kg), d(0))
      return {
        month,
        iceKwh,
        iceKg,
        iceCostRm,
        kwhPerKg: iceKg.isZero() ? d(0) : iceKwh.dividedBy(iceKg).toDecimalPlaces(4),
        // Spread only over the tonnage that actually had a rate, so an
        // uncosted day cannot drag the figure towards zero.
        rmPerKg: pricedKg.isZero() ? null : iceCostRm.dividedBy(pricedKg).toDecimalPlaces(4),
        focKg,
        status: list.some((r) => r.status === 'PROVISIONAL') ? 'PROVISIONAL' : 'FINAL',
        daysWithData: new Set(list.map((r) => r.costDate)).size,
        daysWithoutRate: new Set(
          list.filter((r) => !r.rateAvailable).map((r) => r.costDate)
        ).size,
      }
    })
}
