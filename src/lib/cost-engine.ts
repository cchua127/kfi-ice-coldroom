import { Decimal, d, rm, rate5, type Numeric } from './money'
import { reconstructBill, siteRate, type RateCard } from './tariff'

export type CostStatus = 'PROVISIONAL' | 'FINAL'
export type KwhSource = 'METERED' | 'MODELLED'

/** Why a day carries the rate it does. Surfaced in reports, not just internally. */
export type RateBasis =
  | 'CONFIRMED_BILL' // both accounts have a confirmed bill covering this date
  | 'AFA_FORECAST' // no bill yet, but the month's AFA is published
  | 'CARRIED_FORWARD' // neither — the most recent confirmed rate, held over
  | 'NO_RATE' // nothing to cost with: no bill, no AFA, nothing earlier

export interface DailyRate {
  date: string
  ratePerKwh: Decimal
  status: CostStatus
  basis: RateBasis
  note?: string
}

export interface BillPeriod {
  accountNo: string
  periodStart: string
  periodEnd: string
  kwh: Numeric
  currentChargesRm: Numeric
  confirmed: boolean
}

const iso = (x: Date): string => x.toISOString().slice(0, 10)

function eachDate(from: string, to: string): string[] {
  const out: string[] = []
  const cur = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)
  while (cur <= end) {
    out.push(iso(cur))
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return out
}

const covers = (b: BillPeriod, date: string): boolean =>
  b.periodStart <= date && date <= b.periodEnd

/**
 * Forecast the site rate from the published AFA before any bill arrives.
 *
 * The bill is fully reproducible from kWh and AFA, so the only estimate here is
 * the volume — and volume barely moves the rate, because the only non-linear
 * parts are the RM20 flat retail charge and its knock-on to KWTBB. An estimate
 * 20% out moves the rate by well under a tenth of a sen.
 *
 * This is a rate forecast, not a bill forecast. It deliberately does NOT try to
 * predict site consumption from the sub-meters: they cover roughly three
 * quarters of the site, so a sub-meter-based volume forecast would be wrong by
 * the size of the unaccounted balance.
 */
export function forecastSiteRate(
  afaRatePerKwh: Numeric,
  estimatedKwhPerAccount: Numeric[],
  card?: RateCard
): Decimal {
  const bills = estimatedKwhPerAccount.map((kwh) => {
    const b = reconstructBill({ kwh, afaRatePerKwh, card })
    return { kwh: b.kwh, currentChargesRm: b.currentChargesRm }
  })
  return siteRate(bills)
}

export interface RateSeriesOptions {
  bills: BillPeriod[]
  /** Published AFA by first-of-month ISO date, e.g. { '2026-09-01': '0.0367' }. */
  publishedAfa?: Record<string, Numeric>
  /** Volume estimate per account for the forecast path. */
  estimatedKwhPerAccount?: Numeric[]
  card?: RateCard
}

/**
 * One rate per calendar date. She keys in daily; the truth arrives monthly; the
 * system restates itself instead of her.
 *
 * A date is FINAL only when every account has a confirmed bill covering it —
 * the site rate blends both, so one missing bill leaves the day provisional.
 */
export function buildDailyRateSeries(
  from: string,
  to: string,
  opts: RateSeriesOptions
): DailyRate[] {
  const accounts = [...new Set(opts.bills.map((b) => b.accountNo))]
  const confirmed = opts.bills.filter((b) => b.confirmed)

  // Seed the carry-forward from the most recent fully-confirmed period that
  // ENDS BEFORE the range starts. Without this, costing a month that begins
  // after the last bill (the normal case — September before its bill arrives)
  // would find nothing to carry and return a zero rate.
  const fullyConfirmedPeriods = [...new Set(confirmed.map((b) => b.periodEnd))]
    .sort()
    .map((periodEnd) => confirmed.filter((b) => b.periodEnd === periodEnd))
    .filter((group) => new Set(group.map((b) => b.accountNo)).size === accounts.length)

  let lastConfirmed: Decimal | null = null
  for (const group of fullyConfirmedPeriods) {
    if (group[0].periodEnd < from) lastConfirmed = siteRate(group)
  }

  return eachDate(from, to).map((date): DailyRate => {
    const covering = confirmed.filter((b) => covers(b, date))
    const accountsCovered = new Set(covering.map((b) => b.accountNo))

    if (accounts.length > 0 && accountsCovered.size === accounts.length) {
      const r = siteRate(covering)
      lastConfirmed = r
      return { date, ratePerKwh: r, status: 'FINAL', basis: 'CONFIRMED_BILL' }
    }

    const month = `${date.slice(0, 7)}-01`
    const afa = opts.publishedAfa?.[month]
    if (afa !== undefined && opts.estimatedKwhPerAccount?.length) {
      return {
        date,
        ratePerKwh: forecastSiteRate(afa, opts.estimatedKwhPerAccount, opts.card),
        status: 'PROVISIONAL',
        basis: 'AFA_FORECAST',
        note: `Costed at the published AFA for ${date.slice(0, 7)}; bill not yet received.`,
      }
    }

    if (lastConfirmed) {
      return {
        date,
        ratePerKwh: lastConfirmed,
        status: 'PROVISIONAL',
        basis: 'CARRIED_FORWARD',
        note: 'Costed at the most recent confirmed rate; bill not yet received.',
      }
    }

    // Nothing to cost with. Record the fact rather than emitting a zero rate
    // that would read as "electricity was free that day".
    return {
      date,
      ratePerKwh: d(0),
      status: 'PROVISIONAL',
      basis: 'NO_RATE',
      note:
        'No confirmed bill, no published AFA, and no earlier rate to carry. ' +
        'Consumption is recorded; cost is not available for this date.',
    }
  })
}

// ---------------------------------------------------------------------------
// Line energy
// ---------------------------------------------------------------------------

export interface LineKwh {
  line: string
  kwh: Decimal
  source: KwhSource
  /** Shown in the UI so a modelled number can never look like a measured one. */
  basis: string
}

/** Metered line: closing less the prior reading, times the CT multiplier. */
export function meteredKwh(
  line: string,
  closing: Numeric,
  priorClosing: Numeric,
  ctMultiplier: Numeric = 1
): LineKwh {
  const delta = d(closing).minus(d(priorClosing))
  if (delta.isNegative()) {
    // The legacy sheets computed 0 minus the opening on unfilled rows and
    // carried seven-figure negatives. Never silently accept one.
    throw new Error(
      `${line}: closing ${d(closing)} is below the prior reading ${d(priorClosing)}. ` +
        `Confirm a register rollover explicitly, or correct the entry.`
    )
  }
  return {
    line,
    kwh: rm(delta.times(d(ctMultiplier))),
    source: 'METERED',
    basis: 'sub-meter',
  }
}

/** Register wrapped past its digit width. */
export function rolloverKwh(
  line: string,
  closing: Numeric,
  priorClosing: Numeric,
  digits: number,
  ctMultiplier: Numeric = 1
): LineKwh {
  const wrap = d(10).pow(digits)
  const delta = d(closing).plus(wrap).minus(d(priorClosing))
  return {
    line,
    kwh: rm(delta.times(d(ctMultiplier))),
    source: 'METERED',
    basis: `sub-meter, ${digits}-digit rollover applied`,
  }
}

/** Modelled line: a quantity times a dated cost assumption. */
export function modelledKwh(
  line: string,
  quantity: Numeric,
  perUnit: Numeric,
  unitLabel: string
): LineKwh {
  return {
    line,
    kwh: rm(d(quantity).times(d(perUnit))),
    source: 'MODELLED',
    basis: `${d(perUnit)} ${unitLabel}`,
  }
}

// ---------------------------------------------------------------------------
// Site bridge
// ---------------------------------------------------------------------------

export interface SiteBridge {
  tnbTotalKwh: Decimal
  lines: LineKwh[]
  accountedKwh: Decimal
  unaccountedKwh: Decimal
  unaccountedRm: Decimal
  unaccountedShare: Decimal
}

/**
 * The unaccounted balance is reported as itself and never pushed into the ice
 * line. Using "Ice" as a balancing figure was the legacy report's fatal flaw: it
 * loaded every site-wide tariff rise and every unmetered load onto cost of ice.
 */
export function siteBridge(
  tnbTotalKwh: Numeric,
  lines: LineKwh[],
  ratePerKwh: Numeric
): SiteBridge {
  const total = d(tnbTotalKwh)
  const accounted = lines.reduce<Decimal>((a, l) => a.plus(l.kwh), d(0))
  const unaccounted = total.minus(accounted)
  return {
    tnbTotalKwh: total,
    lines,
    accountedKwh: accounted,
    unaccountedKwh: unaccounted,
    unaccountedRm: rm(unaccounted.times(d(ratePerKwh))),
    unaccountedShare: total.isZero() ? d(0) : unaccounted.dividedBy(total),
  }
}

// ---------------------------------------------------------------------------
// Cost of ice
// ---------------------------------------------------------------------------

/**
 * Which tonnage the cost is spread over. FOC ran 25.6% of blocks moved in H1
 * 2026, so the basis changes cost per kg materially and every report must say
 * which one it used.
 */
export type KgBasis = 'PRODUCED' | 'MOVED' | 'SOLD'

export interface IceKgInput {
  /** Everything made, including FOC and anything that never left. */
  producedKg: Numeric
  /** Free-of-charge tonnage given away. */
  focKg?: Numeric
  /** Produced but never sold, given away or crushed — the block ledger gap. */
  unaccountedKg?: Numeric
}

export function iceKgOn(basis: KgBasis, input: IceKgInput): Decimal {
  const produced = d(input.producedKg)
  const foc = d(input.focKg ?? 0)
  const gap = d(input.unaccountedKg ?? 0)
  switch (basis) {
    case 'PRODUCED':
      return produced
    case 'MOVED':
      return produced.minus(gap)
    case 'SOLD':
      return produced.minus(gap).minus(foc)
  }
}

export interface IceCost {
  iceKwh: Decimal
  iceKg: Decimal
  basis: KgBasis
  ratePerKwh: Decimal
  costRm: Decimal
  kwhPerKg: Decimal
  rmPerKg: Decimal
  /** True when any contributing line is modelled rather than metered. */
  hasModelledLines: boolean
}

export function costOfIce(
  lines: LineKwh[],
  kg: IceKgInput,
  ratePerKwh: Numeric,
  basis: KgBasis = 'PRODUCED'
): IceCost {
  const iceKwh = lines.reduce<Decimal>((a, l) => a.plus(l.kwh), d(0))
  const iceKg = iceKgOn(basis, kg)
  const costRm = rm(iceKwh.times(d(ratePerKwh)))
  return {
    iceKwh,
    iceKg,
    basis,
    ratePerKwh: d(ratePerKwh),
    costRm,
    kwhPerKg: iceKg.isZero() ? d(0) : iceKwh.dividedBy(iceKg).toDecimalPlaces(4),
    rmPerKg: iceKg.isZero() ? d(0) : costRm.dividedBy(iceKg).toDecimalPlaces(4),
    hasModelledLines: lines.some((l) => l.source === 'MODELLED'),
  }
}

export interface LineIntensity {
  line: string
  source: KwhSource
  kwhPerKg: Decimal
  rmPerKg: Decimal
}

/**
 * Per-line intensity. Flat kWh/kg with rising RM/kg means tariff, not plant
 * inefficiency — separating those two is the whole point of the dashboard.
 */
export function lineIntensity(
  line: LineKwh,
  kg: Numeric,
  ratePerKwh: Numeric
): LineIntensity {
  const kgD = d(kg)
  const kwhPerKg = kgD.isZero() ? d(0) : line.kwh.dividedBy(kgD)
  return {
    line: line.line,
    source: line.source,
    kwhPerKg: kwhPerKg.toDecimalPlaces(4),
    rmPerKg: kwhPerKg.times(d(ratePerKwh)).toDecimalPlaces(4),
  }
}

/**
 * A monthly ratio is computed from monthly totals, never as an average of daily
 * ratios, and a month average divides by the days that actually have data. The
 * legacy sheets summed ratio columns and divided by a hardcoded 13.
 */
export function monthlyRatio(totalNumerator: Numeric, totalDenominator: Numeric): Decimal {
  const den = d(totalDenominator)
  return den.isZero() ? d(0) : d(totalNumerator).dividedBy(den).toDecimalPlaces(6)
}

export function meanOverDaysWithData(values: Numeric[]): Decimal {
  const present = values.filter((v) => v !== null && v !== undefined)
  if (!present.length) return d(0)
  const total = present.reduce<Decimal>((a, v) => a.plus(d(v)), d(0))
  return total.dividedBy(present.length)
}

export { rate5 }
