import { Decimal, d, rm, rate5, type Numeric } from './money'

/**
 * Bukan Domestik Am Voltan Rendah (Non-Domestic General, Low Voltage).
 * Both KFI accounts sit on this tariff. Before 1 July 2025 it was
 * Tarif D — Perindustrian Voltan Rendah, which is what still entitles these
 * accounts to the 2 sen/kWh rebate.
 *
 * Every component except AFA has been constant since 1 July 2025 and is
 * verified to the cent against six bills (Jun/Jul/Aug 2026, both accounts).
 *
 * This is NOT a maximum-demand tariff. Capacity is charged per kWh, not per kW.
 * Permintaan Maksima Tertinggi, Beban Diisytiharkan, Faktor Beban and Angkadar
 * Kuasa print on page 1 for information and carry no charge — see validate().
 */
export interface RateCard {
  effectiveFrom: string
  energyPerKwh: Decimal
  capacityPerKwh: Decimal
  networkPerKwh: Decimal
  retailFlat: Decimal
  rebatePerKwh: Decimal
  kwtbbRate: Decimal
}

export const RATE_CARD_2025_07: RateCard = {
  effectiveFrom: '2025-07-01',
  energyPerKwh: d('0.2703'),
  capacityPerKwh: d('0.0883'),
  networkPerKwh: d('0.1482'),
  retailFlat: d('20.00'),
  rebatePerKwh: d('-0.02'),
  kwtbbRate: d('0.016'),
}

/** RP4 runs to 31 December 2027, so a component change before then is an event. */
export const RP4_ENDS = '2027-12-31'

/**
 * Sum of the per-kWh components excluding AFA — 0.4868. Kept as a derived value
 * rather than a literal so it can never drift from the card above.
 */
export const basePerKwh = (card: RateCard = RATE_CARD_2025_07): Decimal =>
  card.energyPerKwh
    .plus(card.capacityPerKwh)
    .plus(card.networkPerKwh)
    .plus(card.rebatePerKwh)

export interface BillInputs {
  kwh: Numeric
  /** RM per kWh, not sen. 0.0380 means 3.80 sen. Negative is a rebate. */
  afaRatePerKwh: Numeric
  previousBalanceRm?: Numeric
  /** Pelarasan Penggenapan, as printed. Usually within a sen or two of zero. */
  roundingRm?: Numeric
  card?: RateCard
}

export interface BillBreakdown {
  kwh: Decimal
  energyRm: Decimal
  afaRm: Decimal
  capacityRm: Decimal
  networkRm: Decimal
  retailRm: Decimal
  rebateRm: Decimal
  /** Caj Penggunaan Bulan Semasa. */
  currentUsageRm: Decimal
  kwtbbBaseRm: Decimal
  kwtbbRm: Decimal
  /** Caj Semasa. */
  currentChargesRm: Decimal
  previousBalanceRm: Decimal
  roundingRm: Decimal
  /** Jumlah Bil Anda. */
  totalRm: Decimal
  blendedRatePerKwh: Decimal
}

/**
 * Rebuilds the whole bill from kWh and the AFA rate. Each component is rounded
 * to the sen individually, exactly as the bill prints them, then summed — that
 * way each line can be diffed against the parsed PDF on the review form.
 *
 * The one non-obvious step is the KWTBB base. KWTBB is 1.6% of the current
 * usage charge EXCLUDING AFA and EXCLUDING the RM20 retail charge. Computing it
 * on the full usage figure throws the total out by RM0.30–5.00, which reads like
 * a parser bug for a long time before anyone finds it.
 */
export function reconstructBill(input: BillInputs): BillBreakdown {
  const card = input.card ?? RATE_CARD_2025_07
  const kwh = d(input.kwh)
  const afaRate = d(input.afaRatePerKwh)

  const energyRm = rm(kwh.times(card.energyPerKwh))
  const afaRm = rm(kwh.times(afaRate))
  const capacityRm = rm(kwh.times(card.capacityPerKwh))
  const networkRm = rm(kwh.times(card.networkPerKwh))
  const retailRm = rm(card.retailFlat)
  const rebateRm = rm(kwh.times(card.rebatePerKwh))

  const currentUsageRm = energyRm
    .plus(afaRm)
    .plus(capacityRm)
    .plus(networkRm)
    .plus(retailRm)
    .plus(rebateRm)

  const kwtbbBaseRm = currentUsageRm.minus(afaRm).minus(retailRm)
  const kwtbbRm = rm(kwtbbBaseRm.times(card.kwtbbRate))

  const currentChargesRm = currentUsageRm.plus(kwtbbRm)
  const previousBalanceRm = rm(input.previousBalanceRm ?? 0)
  const roundingRm = rm(input.roundingRm ?? 0)
  const totalRm = currentChargesRm.plus(previousBalanceRm).plus(roundingRm)

  return {
    kwh,
    energyRm,
    afaRm,
    capacityRm,
    networkRm,
    retailRm,
    rebateRm,
    currentUsageRm,
    kwtbbBaseRm,
    kwtbbRm,
    currentChargesRm,
    previousBalanceRm,
    roundingRm,
    totalRm,
    // Costing uses Caj Semasa over kWh: the previous balance and the rounding
    // adjustment belong to the payment, not to this month's consumption.
    blendedRatePerKwh: kwh.isZero() ? d(0) : rate5(currentChargesRm.dividedBy(kwh)),
  }
}

/**
 * Site rate across both accounts. The production lines are not cleanly
 * separable by account, so costing uses this rather than either account's own
 * blended rate.
 */
export function siteRate(
  bills: { kwh: Numeric; currentChargesRm: Numeric }[]
): Decimal {
  const totalKwh = bills.reduce<Decimal>((a, b) => a.plus(d(b.kwh)), d(0))
  if (totalKwh.isZero()) return d(0)
  const totalRm = bills.reduce<Decimal>(
    (a, b) => a.plus(d(b.currentChargesRm)),
    d(0)
  )
  return rate5(totalRm.dividedBy(totalKwh))
}
