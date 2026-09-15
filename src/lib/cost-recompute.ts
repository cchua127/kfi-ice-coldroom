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
import {
  coldroomSplit,
  flatDailyKwh,
  spreadOverDays,
  DEFAULT_COUNTS_AS_ICE,
  type ColdroomMonthInput,
  type EnergyUseCode,
} from './site-energy'
export type { ColdroomRegisterRow } from './site-energy'

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
  /**
   * The part of `iceKwh` that came from a non-production consumer — the brine
   * compressor and the D10-D12 ice store. Broken out because it is the whole
   * difference between this figure and the one the system reported before the
   * owner's template named those loads, and a reader comparing the two needs
   * to see the reconciliation rather than guess at it.
   */
  supportKwh: Decimal
  /** PROVISIONAL when any contributing day is. No report may mix the two silently. */
  status: 'PROVISIONAL' | 'FINAL'
  daysWithData: number
  /** Days in the month with no rate available at all. */
  daysWithoutRate: number
}

const ICE_LINES: LineCode[] = ['TUBE', 'BIG_POOL', 'BIMC', 'SMALL_POOL']

export interface SummariseOptions {
  /**
   * Costed non-production consumers, from `recomputeEnergyUses()`. Those
   * flagged as ice are added to ice kWh and ice cost.
   */
  energyUses?: EnergyUseCostRow[]
  /**
   * Which consumers count as ice. Defaults to the seeded convention. Passed in
   * rather than read here so the owner's `energy_use.counts_as_ice` column is
   * the single authority and this module never second-guesses it.
   */
  countsAsIce?: Partial<Record<EnergyUseCode, boolean>>
}

/**
 * Monthly ratios come from monthly totals, never from an average of daily
 * ratios, and the day count is the days that actually have data — the legacy
 * sheet summed its ratio columns and divided by a hardcoded 13.
 *
 * Cost of ice here includes the support plant that freezes and holds the ice
 * but produces none of it: the 30HP brine compressor and the D10-D12 storage
 * rooms. Leaving them out — which is what this function did before the owner's
 * template named them — understated cost of ice by roughly a sen per kilogram
 * and parked the difference in the site residual. The figure going up is the
 * correction working.
 */
export function summariseMonths(
  rows: DailyLineCostRow[],
  opts: SummariseOptions = {}
): MonthlySummary[] {
  const iceFlag = { ...DEFAULT_COUNTS_AS_ICE, ...(opts.countsAsIce ?? {}) }
  const support = (opts.energyUses ?? []).filter((u) => iceFlag[u.useCode])

  const byMonth = new Map<string, DailyLineCostRow[]>()
  for (const r of rows) {
    if (!ICE_LINES.includes(r.line)) continue
    const m = r.costDate.slice(0, 7)
    byMonth.set(m, [...(byMonth.get(m) ?? []), r])
  }
  const supportByMonth = new Map<string, EnergyUseCostRow[]>()
  for (const u of support) {
    const m = u.costDate.slice(0, 7)
    supportByMonth.set(m, [...(supportByMonth.get(m) ?? []), u])
    // A support-only month still has ice energy to report, so make sure it is
    // not dropped for want of a production row.
    if (!byMonth.has(m)) byMonth.set(m, [])
  }

  return [...byMonth.entries()]
    .sort()
    .map(([month, list]) => {
      const sup = supportByMonth.get(month) ?? []
      const supportKwh = sup.reduce<Decimal>((a, u) => a.plus(u.kwh), d(0))

      const iceKwh = list.reduce<Decimal>((a, r) => a.plus(r.kwh), d(0)).plus(supportKwh)
      const iceKg = list.reduce<Decimal>((a, r) => a.plus(r.kg), d(0))
      const iceCostRm = list
        .reduce<Decimal>((a, r) => a.plus(r.costRm), d(0))
        .plus(sup.reduce<Decimal>((a, u) => a.plus(u.costRm), d(0)))
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
        supportKwh,
        status:
          list.some((r) => r.status === 'PROVISIONAL') || sup.some((u) => u.status === 'PROVISIONAL')
            ? 'PROVISIONAL'
            : 'FINAL',
        daysWithData: new Set(list.map((r) => r.costDate)).size,
        daysWithoutRate: new Set(
          [...list.filter((r) => !r.rateAvailable), ...sup.filter((u) => !u.rateAvailable)]
            .map((r) => r.costDate)
        ).size,
      }
    })
}

// ---------------------------------------------------------------------------
// The non-production consumers
// ---------------------------------------------------------------------------

export interface EnergyUseCostRow {
  costDate: string
  useCode: EnergyUseCode
  kwh: Decimal
  kwhSource: 'METERED' | 'MODELLED'
  basis: string
  ratePerKwh: Decimal
  rateBasis: DailyRate['basis']
  costRm: Decimal
  status: 'PROVISIONAL' | 'FINAL'
  rateAvailable: boolean
}

/** A coldroom month as it comes out of the database. */
export interface ColdroomMonthRow extends ColdroomMonthInput {
  /** 'YYYY-MM'. */
  month: string
}

/** A water month as it comes out of the database. */
export interface WaterMonthRow {
  /** 'YYYY-MM'. */
  month: string
  tonnes?: Numeric
  retailM3?: Numeric
}

export interface EnergyRecomputeInput {
  from: string
  to: string
  rates: DailyRate[]
  assumptions: Assumptions
  /**
   * Output of `recompute()`. Ice-feed water is derived from the ice each day
   * actually made, so this is a real dependency and not a convenience.
   */
  lineCosts: DailyLineCostRow[]
  coldroom?: ColdroomMonthRow[]
  water?: WaterMonthRow[]
  /** Restrict the run. Defaults to every consumer that has an input. */
  uses?: EnergyUseCode[]
}

const FLAT_LOADS: EnergyUseCode[] = ['BRINE_COMPRESSOR', 'OFFICE_CCTV', 'CRUSHER']

/**
 * Cost the seven non-production consumers, day by day.
 *
 * Three shapes of input, handled three ways, and the difference matters when
 * reading the output:
 *
 *   - The flat loads are a per-day assumption, so they land on every day in the
 *     range that carries a rate. They are continuous plant — a compressor
 *     holding -8C and two dozen cameras do not stop because nothing was made —
 *     so charging them on quiet days is correct, not sloppy.
 *
 *   - The coldroom arrives once a month and is spread evenly. That is an
 *     assumption about a load holding a steady temperature, and a fair one, but
 *     it does mean a coldroom day is never evidence of anything by itself.
 *
 *   - Ice-feed water is NOT spread. It is struck against the ice each day
 *     actually made, which needs no assumption at all and costs the feed water
 *     at the same day's rate as the freezing it feeds.
 *
 * Days with no rate still produce rows. Consumption happened; the cost is
 * recorded as unavailable rather than as zero, exactly as the production lines
 * do it.
 */
export function recomputeEnergyUses(input: EnergyRecomputeInput): EnergyUseCostRow[] {
  const rateByDate = new Map(input.rates.map((r) => [r.date, r]))
  const wanted = input.uses ? new Set(input.uses) : null
  const include = (u: EnergyUseCode) => !wanted || wanted.has(u)

  const datesInRange: string[] = []
  for (let date = input.from; date <= input.to; date = addDays(date, 1)) {
    if (rateByDate.has(date)) datesInRange.push(date)
  }
  const datesInMonth = (month: string) => datesInRange.filter((x) => x.startsWith(month))

  // kWh per (date, use), assembled first so each consumer's derivation is built
  // in one place and costed in another.
  const kwhByDate = new Map<string, { kwh: Decimal; source: 'METERED' | 'MODELLED'; basis: string }>()
  const put = (
    date: string,
    use: EnergyUseCode,
    kwh: Decimal,
    source: 'METERED' | 'MODELLED',
    basis: string
  ) => {
    if (!include(use)) return
    kwhByDate.set(`${date}|${use}`, { kwh, source, basis })
  }

  for (const date of datesInRange) {
    for (const use of FLAT_LOADS) {
      if (!include(use)) continue
      const row = flatDailyKwh(use, input.assumptions, date)
      put(date, use, row.kwh, row.kwhSource, row.basis)
    }
  }

  // Coldroom: split once per month, then spread.
  for (const room of input.coldroom ?? []) {
    const dates = datesInMonth(room.month)
    if (!dates.length) continue
    const monthStart = `${room.month}-01`
    const split = coldroomSplit(
      room,
      input.assumptions.at('coldroom_legacy_factor_rm_per_kwh', monthStart),
      input.assumptions.at('tenant_billing_rate_rm_per_kwh', monthStart)
    )
    const tenant = spreadOverDays(split.tenantKwh, dates)
    const store = spreadOverDays(split.iceStoreKwh, dates)
    const spreadNote = `, spread evenly over ${dates.length} day(s)`
    // What is subtracted depends on where the figure came from: the register
    // knows which rooms KFI actually occupied, the other two paths only know
    // the invoice for D10-D12.
    const lessWhat =
      split.provenance === 'REGISTER' ? 'less the rooms KFI occupied' : 'less D10-D12'
    for (const date of dates) {
      put(
        date,
        'COLDROOM_TENANT',
        tenant.get(date) ?? d(0),
        split.source,
        `${split.totalBasis}, ${lessWhat}${spreadNote}`
      )
      put(date, 'COLDROOM_ICE_STORE', store.get(date) ?? d(0), split.source, split.iceStoreBasis + spreadNote)
    }
  }

  // Delivered water: monthly tonnage, spread.
  for (const w of input.water ?? []) {
    const dates = datesInMonth(w.month)
    if (!dates.length) continue
    const monthStart = `${w.month}-01`
    const tonnes = d(w.tonnes ?? 0).plus(d(w.retailM3 ?? 0))
    const intensity = input.assumptions.at('water_kwh_per_tonne', monthStart)
    const spread = spreadOverDays(rm(tonnes.times(intensity)), dates)
    for (const date of dates) {
      put(
        date,
        'WATER_DELIVERED',
        spread.get(date) ?? d(0),
        'MODELLED',
        `${tonnes.toFixed(2)} t x ${intensity.toFixed(4)} kWh/t delivered, ` +
          `spread evenly over ${dates.length} day(s)`
      )
    }
  }

  // Ice-feed water: per day, against that day's ice. No spreading, no assumption
  // about how the month was shaped.
  const iceKgByDate = new Map<string, Decimal>()
  for (const r of input.lineCosts) {
    if (!ICE_LINES.includes(r.line)) continue
    iceKgByDate.set(r.costDate, (iceKgByDate.get(r.costDate) ?? d(0)).plus(r.kg))
  }
  for (const [date, kg] of iceKgByDate) {
    if (!rateByDate.has(date) || kg.isZero()) continue
    const intensity = input.assumptions.at('water_ice_feed_kwh_per_tonne', date)
    const tonnes = kg.dividedBy(1000)
    put(
      date,
      'WATER_ICE_FEED',
      rm(tonnes.times(intensity)),
      'MODELLED',
      `${tonnes.toFixed(3)} t of ice made x ${intensity.toFixed(4)} kWh/t feed water`
    )
  }

  const out: EnergyUseCostRow[] = []
  for (const [key, v] of kwhByDate) {
    const [costDate, useCode] = key.split('|') as [string, EnergyUseCode]
    const rate = rateByDate.get(costDate)!
    if (v.kwh.isZero()) continue
    out.push({
      costDate,
      useCode,
      kwh: v.kwh,
      kwhSource: v.source,
      basis: v.basis,
      ratePerKwh: rate.ratePerKwh,
      rateBasis: rate.basis,
      costRm: rm(v.kwh.times(rate.ratePerKwh)),
      status: rate.status,
      rateAvailable: rate.basis !== 'NO_RATE',
    })
  }
  return out.sort((a, b) =>
    a.costDate === b.costDate ? a.useCode.localeCompare(b.useCode) : a.costDate < b.costDate ? -1 : 1
  )
}
