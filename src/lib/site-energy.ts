/**
 * Everything on the site that draws power and makes no ice.
 *
 * The report this replaces had one line for all of it: "Unallocated", running
 * at 46.7% of the bill. A residual that large is not a reconciliation, it is a
 * confession — and because it was a residual, every site-wide tariff rise and
 * every unmetered load landed on cost of ice by arithmetic rather than by
 * anyone deciding it should.
 *
 * Naming the consumers does not measure them. Five of the seven are still
 * modelled from a per-day or per-tonne assumption, and one — the coldroom — is
 * worse than modelled when its sub-meter has not been read, because the only
 * surviving artefact is a ringgit total struck at the frozen RM0.484/kWh rate.
 * What changes is that each carries its own derivation in a string that reaches
 * the report, so a reader can argue with it. You cannot argue with a residual.
 *
 * Pure: data in, rows out. The database wrapper lives in cost-recompute.ts.
 */
import { Decimal, d, rm, type Numeric } from './money'
import { Assumptions, addDays } from './domain'

export type EnergyUseCode =
  | 'BRINE_COMPRESSOR'
  | 'COLDROOM_TENANT'
  | 'COLDROOM_ICE_STORE'
  | 'WATER_DELIVERED'
  | 'WATER_ICE_FEED'
  | 'OFFICE_CCTV'
  | 'CRUSHER'

export type KwhSource = 'METERED' | 'MODELLED'

export interface EnergyUseRow {
  useCode: EnergyUseCode
  kwh: Decimal
  kwhSource: KwhSource
  /** How the number was made. Never empty — a modelled figure must say so. */
  basis: string
  /** Stored ringgit for these days, where they have been costed. See below. */
  costRm?: Numeric
}

/**
 * Which consumers belong in cost of ice.
 *
 * This mirrors the owner's template, whose ice total is tube + big pool + old
 * small pool + the 30HP compressor + the China machine + the D10-D12 storage
 * rooms. Two of the exclusions are conventions rather than facts and are worth
 * knowing before anyone quotes the figure:
 *
 *   - The crusher is out because crushing acts on ice that has already been
 *     made and already been costed; putting it back in would charge the same
 *     tonnage's energy twice.
 *   - Ice-feed water is IN, by owner decision (docs §10.3), against the
 *     template's convention. The water itself is free — it comes out of the
 *     tubewell — so what is being allocated is only the electricity of pumping
 *     and filtering it, and that water becomes the ice. It moves cost of ice by
 *     0.023 sen/kg, which is small enough that the decision is about being right
 *     rather than about the money.
 *
 * The live answer is the `counts_as_ice` column on `energy_use`, which the
 * owner can change without a deployment. This constant is the seeded default
 * and the value the pure functions fall back to when no table is supplied.
 */
export const DEFAULT_COUNTS_AS_ICE: Record<EnergyUseCode, boolean> = {
  BRINE_COMPRESSOR: true,
  COLDROOM_ICE_STORE: true,
  WATER_ICE_FEED: true,
  COLDROOM_TENANT: false,
  WATER_DELIVERED: false,
  OFFICE_CCTV: false,
  CRUSHER: false,
}

// ---------------------------------------------------------------------------
// The coldroom
// ---------------------------------------------------------------------------

export interface ColdroomMonthInput {
  /** Whole-coldroom sub-meter kWh. When present, nothing below is used. */
  meteredKwh?: Numeric | null
  /** Tenant compilations. Together they cover the whole room, D10-D12 included. */
  ratonoRm?: Numeric
  yemintRm?: Numeric
  /** D10-D12, invoiced internally at the tenant rate. */
  iceStoreInvoicedRm?: Numeric
}

export interface ColdroomSplit {
  totalKwh: Decimal
  tenantKwh: Decimal
  iceStoreKwh: Decimal
  source: KwhSource
  totalBasis: string
  iceStoreBasis: string
  /**
   * True when the kWh came from dividing a ringgit total by a rate rather than
   * from a meter. Surfaced in the month-close checks, not buried.
   */
  backInferred: boolean
}

/**
 * Split the coldroom into tenant rooms and the plant's own D10-D12 ice store.
 *
 * Meter first. When there is no meter reading the legacy path divides the
 * ringgit compilations back out by the rate each was struck at — RM0.484/kWh
 * for the tenant compilations, the tenant billing rate for D10-D12. That is
 * circular in the precise sense that it recovers a quantity from a price, and
 * it is only as good as the frozen rate; it is done anyway so the coldroom is
 * not simply missing from the bridge, and every report that touches it says
 * which of the two paths produced the number.
 *
 * Note the asymmetry, which is in the source data and not an error here: the
 * two tenant compilations cover the WHOLE room including D10-D12, so the ice
 * store is subtracted out rather than added in.
 */
export function coldroomSplit(
  input: ColdroomMonthInput,
  legacyFactorRmPerKwh: Numeric,
  tenantRateRmPerKwh: Numeric
): ColdroomSplit {
  const legacy = d(legacyFactorRmPerKwh)
  const tenantRate = d(tenantRateRmPerKwh)

  if (legacy.isZero() || tenantRate.isZero()) {
    throw new Error(
      'Coldroom split needs a non-zero legacy factor and tenant rate: the ' +
        'legacy path divides ringgit totals by them.'
    )
  }

  const iceStoreRm = d(input.iceStoreInvoicedRm ?? 0)
  const iceStoreKwh = rm(iceStoreRm.dividedBy(tenantRate))
  const iceStoreBasis =
    `RM${iceStoreRm.toFixed(2)} invoiced / ${tenantRate.toFixed(4)} RM/kWh tenant rate`

  if (input.meteredKwh !== null && input.meteredKwh !== undefined) {
    const total = d(input.meteredKwh)
    // The ice store still comes from its invoice: the sub-meter covers the room
    // as a whole and D10-D12 has no meter of its own.
    const tenant = total.minus(iceStoreKwh)
    return {
      totalKwh: total,
      tenantKwh: tenant.isNegative() ? d(0) : tenant,
      iceStoreKwh,
      source: 'METERED',
      totalBasis: 'coldroom sub-meter',
      iceStoreBasis,
      backInferred: false,
    }
  }

  const compilationRm = d(input.ratonoRm ?? 0).plus(d(input.yemintRm ?? 0))
  const total = rm(compilationRm.dividedBy(legacy))
  const tenant = total.minus(iceStoreKwh)
  return {
    totalKwh: total,
    tenantKwh: tenant.isNegative() ? d(0) : tenant,
    iceStoreKwh,
    source: 'MODELLED',
    totalBasis:
      `BACK-INFERRED: RM${compilationRm.toFixed(2)} compiled / ${legacy.toFixed(4)} ` +
      'RM/kWh legacy factor — no sub-meter reading on file',
    iceStoreBasis,
    backInferred: true,
  }
}

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------

export interface WaterMonthInput {
  /** PKPS tubewell tonnes. */
  tonnes?: Numeric
  /** Metered retail water, cubic metres. A cubic metre is a tonne. */
  retailM3?: Numeric
  /** Ice made this month, in kg. Its feed water is pumped and filtered too. */
  iceKg?: Numeric
}

/**
 * Two water lines, because they are two different jobs at two intensities.
 *
 * Delivered water is pumped, filtered and transferred to a client's tank — the
 * full 0.65 kWh/t. Ice-feed water stops short of that last transfer and runs at
 * 0.45. Keeping them apart is what makes the owner's decision expressible at
 * all: one water line could only be all ice or none, and it is neither.
 *
 * Nobody keys the split. Delivered tonnage is entered monthly; the ice-feed
 * side is struck against the ice each day actually made. The extra precision
 * costs the office nothing.
 */
export function waterKwh(
  input: WaterMonthInput,
  deliveredKwhPerTonne: Numeric,
  iceFeedKwhPerTonne: Numeric
): EnergyUseRow[] {
  const deliveredT = d(input.tonnes ?? 0).plus(d(input.retailM3 ?? 0))
  const iceT = d(input.iceKg ?? 0).dividedBy(1000)
  const deliveredRate = d(deliveredKwhPerTonne)
  const iceRate = d(iceFeedKwhPerTonne)

  return [
    {
      useCode: 'WATER_DELIVERED',
      kwh: rm(deliveredT.times(deliveredRate)),
      kwhSource: 'MODELLED',
      basis: `${deliveredT.toFixed(2)} t x ${deliveredRate.toFixed(4)} kWh/t delivered`,
    },
    {
      useCode: 'WATER_ICE_FEED',
      kwh: rm(iceT.times(iceRate)),
      kwhSource: 'MODELLED',
      basis: `${iceT.toFixed(3)} t ice feed x ${iceRate.toFixed(4)} kWh/t`,
    },
  ]
}

// ---------------------------------------------------------------------------
// The flat daily loads
// ---------------------------------------------------------------------------

/** Assumption key per flat-load consumer. One place decides the mapping. */
export const FLAT_LOAD_KEYS: Partial<Record<EnergyUseCode, string>> = {
  BRINE_COMPRESSOR: 'brine_compressor_kwh_per_day',
  OFFICE_CCTV: 'office_cctv_kwh_per_day',
  CRUSHER: 'crusher_kwh_per_day',
}

/**
 * A consumer that runs at a standing rate every day the plant is active.
 *
 * These are estimates and the basis string says the figure and its unit, so a
 * reader sees "340 kWh/day" rather than a total that looks surveyed. The three
 * of them are the part of the old x1.2 big-pool loader that could be named;
 * naming them is what made the loader removable.
 */
export function flatDailyKwh(
  useCode: EnergyUseCode,
  assumptions: Assumptions,
  date: string
): EnergyUseRow {
  const key = FLAT_LOAD_KEYS[useCode]
  if (!key) {
    throw new Error(`${useCode} is not a flat daily load; it has no per-day assumption.`)
  }
  const perDay = assumptions.at(key, date)
  return {
    useCode,
    kwh: rm(perDay),
    kwhSource: 'MODELLED',
    basis: `${perDay.toFixed(4)} kWh/day standing load`,
  }
}

/**
 * Spread a monthly figure evenly across the days that are actually active.
 *
 * The coldroom and the water lines arrive as one number for the month, but
 * everything downstream is costed per day against that day's rate. An even
 * spread is a choice, not a measurement: it assumes the load does not care
 * which day of the month it is, which for a coldroom holding a steady
 * temperature is close enough, and for water tracks delivery schedules only
 * loosely. The remainder lands on the final day rather than being dropped, so
 * the daily rows still sum to the monthly figure exactly.
 */
export function spreadOverDays(monthlyKwh: Numeric, dates: string[]): Map<string, Decimal> {
  const out = new Map<string, Decimal>()
  if (!dates.length) return out

  const total = rm(monthlyKwh)
  const per = rm(total.dividedBy(dates.length))
  let placed = d(0)
  dates.forEach((date, i) => {
    const value = i === dates.length - 1 ? total.minus(placed) : per
    placed = placed.plus(value)
    out.set(date, value)
  })
  return out
}

export function eachDateInclusive(from: string, to: string): string[] {
  const out: string[] = []
  for (let cur = from; cur <= to; cur = addDays(cur, 1)) out.push(cur)
  return out
}

// ---------------------------------------------------------------------------
// The site statement
// ---------------------------------------------------------------------------

export interface StatementLine {
  key: string
  label: string
  kwh: Decimal
  kwhSource: KwhSource
  basis: string
  costRm: Decimal
  /** Share of billed site consumption. Null when nothing was billed. */
  share: Decimal | null
  countsAsIce: boolean
}

export interface SiteStatement {
  billedKwh: Decimal
  billedRm: Decimal
  ratePerKwh: Decimal
  lines: StatementLine[]
  accountedKwh: Decimal
  /** What the bill covers that nothing claims. Reported as itself, always. */
  unallocatedKwh: Decimal
  unallocatedRm: Decimal
  unallocatedShare: Decimal | null
  /** Ice kWh and RM on the current `countsAsIce` convention. */
  iceKwh: Decimal
  iceRm: Decimal
  /**
   * Named lines plus the residual, against billed kWh. Zero by construction:
   * the residual is defined as the difference, so it cannot be anything else.
   * Returned so the month-close check can assert it rather than trust it.
   */
  tieOutKwh: Decimal
  /**
   * The named lines plus the residual, against the bill, in ringgit.
   *
   * Unlike `tieOutKwh` this is NOT zero by construction, and the two things it
   * catches are both worth catching. Sen-rounding each stored line accounts for
   * a few sen. Anything larger means the lines were costed at rates the month's
   * blended rate does not represent — which happens the moment a TNB bill
   * period straddles a month boundary, because each day is costed at its own
   * rate while the residual is struck at the month's.
   *
   * The template expects an exact 0.00 here and gets it only because Excel
   * rounds nothing and its months are one flat rate. Reporting the difference
   * as itself is honest; plugging it into a line is how a rounding error
   * becomes a silent allocation.
   */
  unexplainedRm: Decimal
}

export interface StatementInput {
  billedKwh: Numeric
  billedRm: Numeric
  /**
   * Production lines: tube, big pool, BIMC, small pool.
   *
   * `costRm` is the ringgit already stored against those days. Pass it whenever
   * you have it: a day is costed at ITS OWN rate, and re-striking a month's kWh
   * against a month-blended rate would disagree with every other report the
   * moment a bill period straddles a month boundary. Omitted, the statement
   * falls back to kWh times the blended rate.
   */
  productionLines: {
    code: string
    label: string
    kwh: Numeric
    source: KwhSource
    basis: string
    costRm?: Numeric
  }[]
  /** Non-production consumers. */
  energyUses: EnergyUseRow[]
  /** Overrides the seeded default, so the owner's convention wins. */
  countsAsIce?: Partial<Record<EnergyUseCode, boolean>>
  labels?: Partial<Record<EnergyUseCode, string>>
}

const DEFAULT_LABELS: Record<EnergyUseCode, string> = {
  BRINE_COMPRESSOR: '30HP brine compressor',
  COLDROOM_TENANT: 'Coldrooms — tenant (excl. D10-D12)',
  COLDROOM_ICE_STORE: 'Ice storage D10-D12',
  WATER_DELIVERED: 'Water — delivered',
  WATER_ICE_FEED: 'Water — ice feed',
  OFFICE_CCTV: 'Office and CCTV',
  CRUSHER: 'Crusher',
}

/**
 * The month's electricity, line by line, at the month's actual blended tariff.
 *
 * Every production line is ice; every other consumer is ice or not according to
 * the convention in force. The residual is whatever the bill covers that no line
 * claims, and it stays a line of its own — the single most important property of
 * this function is that it never pushes the residual anywhere.
 */
export function siteStatement(input: StatementInput): SiteStatement {
  const billedKwh = d(input.billedKwh)
  const billedRm = d(input.billedRm)
  const rate = billedKwh.isZero() ? d(0) : billedRm.dividedBy(billedKwh)
  const iceFlag = { ...DEFAULT_COUNTS_AS_ICE, ...(input.countsAsIce ?? {}) }
  const labels = { ...DEFAULT_LABELS, ...(input.labels ?? {}) }

  const shareOf = (kwh: Decimal) => (billedKwh.isZero() ? null : kwh.dividedBy(billedKwh))

  const costOf = (kwh: Decimal, stored: Numeric | undefined) =>
    stored === undefined ? rm(kwh.times(rate)) : rm(stored)

  const lines: StatementLine[] = [
    ...input.productionLines.map((l): StatementLine => {
      const kwh = d(l.kwh)
      return {
        key: l.code,
        label: l.label,
        kwh,
        kwhSource: l.source,
        basis: l.basis,
        costRm: costOf(kwh, l.costRm),
        share: shareOf(kwh),
        countsAsIce: true,
      }
    }),
    ...input.energyUses.map((u): StatementLine => ({
      key: u.useCode,
      label: labels[u.useCode],
      kwh: u.kwh,
      kwhSource: u.kwhSource,
      basis: u.basis,
      costRm: costOf(u.kwh, u.costRm),
      share: shareOf(u.kwh),
      countsAsIce: iceFlag[u.useCode],
    })),
  ]

  const accountedKwh = lines.reduce<Decimal>((a, l) => a.plus(l.kwh), d(0))
  const unallocatedKwh = billedKwh.minus(accountedKwh)
  const unallocatedRm = rm(unallocatedKwh.times(rate))

  const iceLines = lines.filter((l) => l.countsAsIce)
  const iceKwh = iceLines.reduce<Decimal>((a, l) => a.plus(l.kwh), d(0))

  // Summed from the lines above, not re-struck on the ice kWh total. The few
  // sen between the two methods do not matter to a figure quoted per kilogram,
  // but a reader adding up the printed column with a calculator and getting a
  // different answer from the printed total matters a great deal.
  const iceRm = iceLines.reduce<Decimal>((a, l) => a.plus(l.costRm), d(0))

  const namedRm = lines.reduce<Decimal>((a, l) => a.plus(l.costRm), d(0))

  return {
    billedKwh,
    billedRm,
    ratePerKwh: rate,
    lines,
    accountedKwh,
    unallocatedKwh,
    unallocatedRm,
    unallocatedShare: shareOf(unallocatedKwh),
    iceKwh,
    iceRm,
    tieOutKwh: billedKwh.minus(accountedKwh).minus(unallocatedKwh),
    unexplainedRm: rm(namedRm.plus(unallocatedRm).minus(billedRm)),
  }
}
