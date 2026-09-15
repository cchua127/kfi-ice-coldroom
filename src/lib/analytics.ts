/**
 * The four questions the owner's template asks that cost-of-ice alone cannot.
 *
 *   - Efficiency: is a line getting worse, or is the tariff?
 *   - FOC: what does the ice given away actually cost, and what did it forgo?
 *   - Coldroom: does reselling power to tenants still make money as AFA rises?
 *   - Channels: which customers pay more per kilogram than the power to freeze it?
 *
 * All four are ratios, and ratios are where the old workbooks went wrong most
 * often: a ratio column summed down the page, a monthly figure averaged from
 * daily ones, a divisor hardcoded at thirteen. Every function here takes totals
 * and divides once. None of them sums a ratio.
 *
 * Pure throughout — the database wrapper is in src/lib/reports/builders.ts.
 */
import { Decimal, d, rm, type Numeric } from './money'

/** Divide once, at the end, or return null. Never a silent zero. */
const per = (num: Decimal, den: Decimal, dp = 6): Decimal | null =>
  den.isZero() ? null : num.dividedBy(den).toDecimalPlaces(dp)

// ---------------------------------------------------------------------------
// Efficiency by machine
// ---------------------------------------------------------------------------

export interface MachineInput {
  line: string
  label: string
  kwh: Numeric
  /** Everything the line made, FOC included. */
  producedKg: Numeric
  /** The part of `producedKg` given away free. */
  focKg?: Numeric
  kwhSource: 'METERED' | 'MODELLED'
}

export interface MachineEfficiency {
  line: string
  label: string
  kwhSource: 'METERED' | 'MODELLED'
  kwh: Decimal
  producedKg: Decimal
  focKg: Decimal
  sellableKg: Decimal
  /** Over everything made. */
  kwhPerKg: Decimal | null
  rmPerKg: Decimal | null
  /** Over what could be sold. The honest figure when FOC is a defect rate. */
  netKwhPerKg: Decimal | null
  netRmPerKg: Decimal | null
}

/**
 * Gross and net-of-FOC intensity for one line.
 *
 * Both are reported because which one is right depends on an unresolved
 * question. If the free-of-charge blocks are genuine defects then the plant
 * spent that energy and got nothing, and the net figure is the true cost per
 * sellable kilogram. If they are shrinkage then the ice was fine and the loss
 * is revenue, not efficiency. Reporting only one would be picking an answer.
 */
export function machineEfficiency(
  input: MachineInput,
  ratePerKwh: Numeric
): MachineEfficiency {
  const kwh = d(input.kwh)
  const produced = d(input.producedKg)
  const foc = d(input.focKg ?? 0)
  const sellable = produced.minus(foc)
  const rate = d(ratePerKwh)

  const gross = per(kwh, produced)
  const net = per(kwh, sellable)

  return {
    line: input.line,
    label: input.label,
    kwhSource: input.kwhSource,
    kwh,
    producedKg: produced,
    focKg: foc,
    sellableKg: sellable.isNegative() ? d(0) : sellable,
    kwhPerKg: gross,
    rmPerKg: gross === null ? null : gross.times(rate).toDecimalPlaces(6),
    netKwhPerKg: net,
    netRmPerKg: net === null ? null : net.times(rate).toDecimalPlaces(6),
  }
}

// ---------------------------------------------------------------------------
// FOC watch
// ---------------------------------------------------------------------------

export interface FocInput {
  /** Units made. Blocks for BIMC, which is where FOC is actually recorded. */
  producedUnits: Numeric
  /** Units sold, from the ledger. Optional — the ledger gap needs it. */
  soldUnits?: Numeric | null
  focUnits: Numeric
  kgPerUnit: Numeric
  /** Energy per unit, for valuing the electricity inside the giveaway. */
  kwhPerUnit: Numeric
  ratePerKwh: Numeric
  /** Realised selling price per unit, for the revenue forgone. Null if unknown. */
  unitPriceRm?: Numeric | null
}

export interface FocWatch {
  producedUnits: Decimal
  soldUnits: Decimal | null
  focUnits: Decimal
  focKg: Decimal
  focTonnes: Decimal
  /** FOC over units that actually moved — sold plus given away. */
  focShareOfMoved: Decimal | null
  /** The electricity spent freezing ice nobody paid for. */
  electricityInFocRm: Decimal
  /** Revenue at the realised price. Null when no price is on file. */
  revenueForgoneRm: Decimal | null
  /**
   * Made, less sold, less given away. Not FOC and not a rounding residue: it is
   * ice the ledger cannot account for, and it is a control question rather than
   * a costing one.
   */
  ledgerGapUnits: Decimal | null
}

export function focWatch(input: FocInput): FocWatch {
  const produced = d(input.producedUnits)
  const sold = input.soldUnits === null || input.soldUnits === undefined ? null : d(input.soldUnits)
  const foc = d(input.focUnits)
  const kgPerUnit = d(input.kgPerUnit)
  const focKg = foc.times(kgPerUnit)

  const moved = sold === null ? null : sold.plus(foc)
  const electricity = rm(foc.times(d(input.kwhPerUnit)).times(d(input.ratePerKwh)))

  return {
    producedUnits: produced,
    soldUnits: sold,
    focUnits: foc,
    focKg,
    focTonnes: focKg.dividedBy(1000),
    focShareOfMoved: moved === null ? null : per(foc, moved),
    electricityInFocRm: electricity,
    revenueForgoneRm:
      input.unitPriceRm === null || input.unitPriceRm === undefined
        ? null
        : rm(foc.times(d(input.unitPriceRm))),
    ledgerGapUnits: sold === null ? null : produced.minus(sold).minus(foc),
  }
}

// ---------------------------------------------------------------------------
// Coldroom recovery
// ---------------------------------------------------------------------------

export interface ColdroomRecovery {
  tenantKwh: Decimal
  /** What that power cost at the actual blended tariff. */
  costRm: Decimal
  /** What the tenants were billed for it. */
  billedRm: Decimal
  marginRm: Decimal
  /** The spread, in RM per kWh. This is the number that goes negative first. */
  marginPerKwh: Decimal
  /** True once the tariff has overtaken the tenant rate. */
  underwater: boolean
}

/**
 * Reselling power to tenants at a fixed RM/kWh while buying it at a floating
 * one is a short position on the tariff. It has been profitable and is
 * shrinking: the spread is the tenant rate less the blended rate, and AFA moves
 * the blended rate every month. Reported per kWh as well as in total, because
 * the total also moves with occupancy and that obscures the trend.
 */
export function coldroomRecovery(
  tenantKwh: Numeric,
  ratePerKwh: Numeric,
  tenantRatePerKwh: Numeric
): ColdroomRecovery {
  const kwh = d(tenantKwh)
  const rate = d(ratePerKwh)
  const tenantRate = d(tenantRatePerKwh)
  const spread = tenantRate.minus(rate)

  return {
    tenantKwh: kwh,
    costRm: rm(kwh.times(rate)),
    billedRm: rm(kwh.times(tenantRate)),
    marginRm: rm(kwh.times(spread)),
    marginPerKwh: spread.toDecimalPlaces(5),
    underwater: spread.isNegative(),
  }
}

// ---------------------------------------------------------------------------
// Sales by channel
// ---------------------------------------------------------------------------

export interface ChannelSale {
  channel: string
  revenueRm: Numeric
  /** Kilograms moved through this channel. Null when the product mix is unknown. */
  kg?: Numeric | null
}

export interface ChannelMargin {
  channel: string
  revenueRm: Decimal
  kg: Decimal | null
  /** Realised price per kg. Null without a kg figure — never assumed. */
  realisedRmPerKg: Decimal | null
  shareOfRevenue: Decimal | null
  /** Realised price less the electricity in a kilogram of ice. */
  marginOverElectricity: Decimal | null
}

export interface ChannelSummary {
  rows: ChannelMargin[]
  totalRevenueRm: Decimal
  totalKg: Decimal
  costOfIceRmPerKg: Decimal | null
  /** Electricity as a share of what the ice sold for. The headline ratio. */
  electricityShareOfSales: Decimal | null
}

/**
 * Revenue and realised price per kilogram, channel by channel, against the
 * electricity in a kilogram of ice.
 *
 * The margin column is deliberately narrow: it is realised price less
 * electricity, and electricity only. It is not gross margin and must not be
 * read as one — there is no labour, water, depreciation or delivery in it. It
 * answers one question, which is whether a channel covers the power it takes to
 * freeze what it buys, and every channel here clears that bar by a wide
 * distance. The number is useful for ranking channels, not for pricing.
 */
export function channelMargin(
  sales: ChannelSale[],
  costOfIceRmPerKg: Numeric | null,
  totalIceElectricityRm?: Numeric
): ChannelSummary {
  const cost = costOfIceRmPerKg === null ? null : d(costOfIceRmPerKg)
  const totalRevenue = sales.reduce<Decimal>((a, s) => a.plus(d(s.revenueRm)), d(0))
  const totalKg = sales.reduce<Decimal>(
    (a, s) => (s.kg === null || s.kg === undefined ? a : a.plus(d(s.kg))),
    d(0)
  )

  const rows = sales.map((s): ChannelMargin => {
    const revenue = d(s.revenueRm)
    const kg = s.kg === null || s.kg === undefined ? null : d(s.kg)
    const realised = kg === null ? null : per(revenue, kg)
    return {
      channel: s.channel,
      revenueRm: revenue,
      kg,
      realisedRmPerKg: realised,
      shareOfRevenue: per(revenue, totalRevenue),
      marginOverElectricity:
        realised === null || cost === null ? null : realised.minus(cost).toDecimalPlaces(6),
    }
  })

  return {
    rows,
    totalRevenueRm: totalRevenue,
    totalKg,
    costOfIceRmPerKg: cost,
    electricityShareOfSales:
      totalIceElectricityRm === undefined ? null : per(d(totalIceElectricityRm), totalRevenue),
  }
}

/**
 * Pasar kilograms, by difference.
 *
 * The counter does not weigh what it sells, so the only way to a pasar tonnage
 * is sellable production less everything that left through a named channel.
 * That makes it a residual, and a residual absorbs every error upstream of it —
 * an unrecorded outside sale shows up here as pasar ice. It is reported because
 * the realised price per kilogram it produces is stable month to month, which
 * is itself evidence the residual is behaving; treat a sudden move in it as a
 * data question before a commercial one.
 */
export function pasarKg(sellableKg: Numeric, outsideKg: Numeric): Decimal {
  const remainder = d(sellableKg).minus(d(outsideKg))
  return remainder.isNegative() ? d(0) : remainder
}

/**
 * What the plant could actually sell: everything made, less the ice given away,
 * less anything bought in for resale being double-counted as production.
 *
 * Purchased ice is added, not subtracted — it is ice that moved through the
 * counter without the plant making it, and leaving it out understates the
 * denominator of every realised-price figure.
 */
export function sellableKg(
  producedKg: Numeric,
  focKg: Numeric,
  purchasedKg: Numeric = 0
): Decimal {
  const out = d(producedKg).minus(d(focKg)).plus(d(purchasedKg))
  return out.isNegative() ? d(0) : out
}
