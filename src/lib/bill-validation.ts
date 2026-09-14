import { Decimal, d, rm, centsApart, type Numeric } from './money'
import { reconstructBill, RATE_CARD_2025_07, RP4_ENDS, type RateCard } from './tariff'

export type Severity = 'ERROR' | 'WARN'

export interface Finding {
  severity: Severity
  code: string
  field?: string
  message: string
  expected?: string
  actual?: string
  /** WARNs the operator may pass with a note; ERRORs stop the review form. */
  requiresNote?: boolean
}

export interface ParsedBill {
  accountNo: string
  periodStart: string
  periodEnd: string
  kwh: Numeric
  afaRatePerKwh: Numeric
  energyRate?: Numeric
  capacityRate?: Numeric
  networkRate?: Numeric
  rebateRate?: Numeric
  energyRm?: Numeric
  afaRm?: Numeric
  capacityRm?: Numeric
  networkRm?: Numeric
  retailRm?: Numeric
  rebateRm?: Numeric
  currentUsageRm?: Numeric
  kwtbbRm?: Numeric
  currentChargesRm?: Numeric
  previousBalanceRm?: Numeric
  roundingRm?: Numeric
  totalRm: Numeric
  meterReadings?: { meterNo: string; unit: string; usage: Numeric }[]
}

export interface ValidationContext {
  knownAccountNos: string[]
  card?: RateCard
  /** Confirmed bills for this account, to catch period overlap and kWh jumps. */
  priorBills?: { periodStart: string; periodEnd: string; kwh: Numeric }[]
}

const RATE_FIELDS = [
  ['energyRate', 'energyPerKwh'],
  ['capacityRate', 'capacityPerKwh'],
  ['networkRate', 'networkPerKwh'],
  ['rebateRate', 'rebatePerKwh'],
] as const

const AMOUNT_FIELDS = [
  ['energyRm', 'energyRm'],
  ['afaRm', 'afaRm'],
  ['capacityRm', 'capacityRm'],
  ['networkRm', 'networkRm'],
  ['retailRm', 'retailRm'],
  ['rebateRm', 'rebateRm'],
  ['currentUsageRm', 'currentUsageRm'],
  ['kwtbbRm', 'kwtbbRm'],
  ['currentChargesRm', 'currentChargesRm'],
] as const

/**
 * Runs before the review form is shown. Never auto-confirms anything: the model
 * extracts, the reconstruction checks, and a human confirms. This is money.
 */
export function validateParsedBill(
  parsed: ParsedBill,
  ctx: ValidationContext
): Finding[] {
  const findings: Finding[] = []
  const card = ctx.card ?? RATE_CARD_2025_07

  if (!ctx.knownAccountNos.includes(parsed.accountNo)) {
    findings.push({
      severity: 'ERROR',
      code: 'UNKNOWN_ACCOUNT',
      field: 'accountNo',
      message: `Account ${parsed.accountNo} is not one of this site's accounts.`,
      expected: ctx.knownAccountNos.join(' or '),
      actual: parsed.accountNo,
    })
  }

  if (!(parsed.periodStart < parsed.periodEnd)) {
    findings.push({
      severity: 'ERROR',
      code: 'BAD_PERIOD',
      message: `Period start ${parsed.periodStart} is not before end ${parsed.periodEnd}.`,
    })
  }

  for (const prior of ctx.priorBills ?? []) {
    if (parsed.periodStart <= prior.periodEnd && prior.periodStart <= parsed.periodEnd) {
      findings.push({
        severity: 'ERROR',
        code: 'PERIOD_OVERLAP',
        message: `Period overlaps a confirmed bill (${prior.periodStart} to ${prior.periodEnd}).`,
      })
    }
  }

  // A component change before RP4 ends is an event, not a new number to accept.
  for (const [parsedKey, cardKey] of RATE_FIELDS) {
    const actual = parsed[parsedKey]
    if (actual === undefined || actual === null) continue
    const expected = card[cardKey]
    if (!d(actual).equals(expected)) {
      findings.push({
        severity: 'ERROR',
        code: 'TARIFF_REVISION_SUSPECTED',
        field: parsedKey,
        message:
          `${parsedKey} does not match the stored rate card. RP4 runs to ${RP4_ENDS}, ` +
          `so this is either a misparse or a tariff revision. Do not accept it silently.`,
        expected: expected.toString(),
        actual: d(actual).toString(),
      })
    }
  }

  const built = reconstructBill({
    kwh: parsed.kwh,
    afaRatePerKwh: parsed.afaRatePerKwh,
    previousBalanceRm: parsed.previousBalanceRm ?? 0,
    roundingRm: parsed.roundingRm ?? 0,
    card,
  })

  // Field-level diffs, never a generic "parse failed".
  for (const [parsedKey, builtKey] of AMOUNT_FIELDS) {
    const actual = parsed[parsedKey]
    if (actual === undefined || actual === null) continue
    const expected = built[builtKey] as Decimal
    const apart = centsApart(actual, expected)
    if (apart !== 0) {
      findings.push({
        severity: 'ERROR',
        code: 'RECONSTRUCTION_BREAK',
        field: parsedKey,
        message: `${parsedKey} is ${apart > 0 ? '+' : ''}${apart} sen against the reconstruction.`,
        expected: expected.toFixed(2),
        actual: rm(actual).toFixed(2),
      })
    }
  }

  const totalApart = centsApart(parsed.totalRm, built.totalRm)
  if (totalApart !== 0) {
    findings.push({
      severity: 'ERROR',
      code: 'TOTAL_BREAK',
      field: 'totalRm',
      message: `Total is ${totalApart > 0 ? '+' : ''}${totalApart} sen against the reconstruction.`,
      expected: built.totalRm.toFixed(2),
      actual: rm(parsed.totalRm).toFixed(2),
    })
  }

  // Each account has two physical meters, each reporting kWh, kW and kVARh.
  // Only the kWh rows sum to billed consumption.
  if (parsed.meterReadings?.length) {
    const kwhRows = parsed.meterReadings.filter(
      (r) => r.unit.toLowerCase() === 'kwh'
    )
    if (kwhRows.length) {
      const summed = kwhRows.reduce<Decimal>((a, r) => a.plus(d(r.usage)), d(0))
      if (!summed.equals(d(parsed.kwh))) {
        findings.push({
          severity: 'ERROR',
          code: 'METER_SUM_MISMATCH',
          field: 'meterReadings',
          message: 'Sum of the kWh meter rows does not equal billed consumption.',
          expected: d(parsed.kwh).toString(),
          actual: summed.toString(),
        })
      }
    }
  }

  const derivedRate = d(parsed.kwh).isZero()
    ? d(0)
    : d(parsed.totalRm).dividedBy(d(parsed.kwh))
  if (derivedRate.lessThan('0.45') || derivedRate.greaterThan('0.65')) {
    findings.push({
      severity: 'WARN',
      code: 'RATE_OUT_OF_BAND',
      field: 'totalRm',
      message:
        `Derived rate ${derivedRate.toFixed(4)} RM/kWh is outside the expected ` +
        `0.45-0.65 band. Observed range Jun-Aug 2026 was 0.5207-0.5328.`,
      requiresNote: true,
    })
  }

  const mostRecent = [...(ctx.priorBills ?? [])].sort((a, b) =>
    a.periodStart < b.periodStart ? 1 : -1
  )[0]
  if (mostRecent && !d(mostRecent.kwh).isZero()) {
    const change = d(parsed.kwh).minus(d(mostRecent.kwh)).dividedBy(d(mostRecent.kwh))
    if (change.abs().greaterThan('0.15')) {
      findings.push({
        severity: 'WARN',
        code: 'KWH_JUMP',
        field: 'kwh',
        message:
          `Consumption moved ${change.times(100).toFixed(1)}% against the previous ` +
          `bill. Confirm the reading and add a note.`,
        requiresNote: true,
      })
    }
  }

  return findings
}

export const hasBlockingFinding = (findings: Finding[]): boolean =>
  findings.some((f) => f.severity === 'ERROR')
