import Decimal from 'decimal.js'

// TNB rounds half-up to the sen. Configure once, globally, so no call site can
// quietly pick a different mode and throw a reconstruction out by a cent.
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP })

export { Decimal }

export type Numeric = Decimal | number | string

export const d = (v: Numeric): Decimal => new Decimal(v)

/** Round to sen. Every ringgit figure that reaches the database goes through this. */
export const rm = (v: Numeric): Decimal => d(v).toDecimalPlaces(2)

/** Round to the same 4dp the tariff rates are quoted at. */
export const rate4 = (v: Numeric): Decimal => d(v).toDecimalPlaces(4)

/** Blended rates are reported at 5dp — 0.5207 vs 0.5307 is a real difference. */
export const rate5 = (v: Numeric): Decimal => d(v).toDecimalPlaces(5)

export const sum = (xs: Numeric[]): Decimal =>
  xs.reduce<Decimal>((a, b) => a.plus(d(b)), d(0))

/** True when two ringgit figures agree to the sen. */
export const tiesToTheCent = (a: Numeric, b: Numeric): boolean =>
  rm(a).equals(rm(b))

/** Signed difference in sen, for field-level diffs on the bill review form. */
export const centsApart = (a: Numeric, b: Numeric): number =>
  rm(a).minus(rm(b)).times(100).toNumber()
