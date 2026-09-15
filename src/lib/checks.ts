/**
 * Month-close checks.
 *
 * The owner's template ends on a sheet of red cells headed "investigate before
 * closing the month". It is the most valuable sheet in the file, because it is
 * the only one that knows what a wrong number looks like.
 *
 * Two rules shape this implementation.
 *
 * A threshold is a judgement, so every one of them is named, carries the reason
 * it sits where it does, and can be overridden per run. A threshold buried as a
 * literal inside a comparison is a threshold nobody will ever revisit.
 *
 * A check with no data to check is NOT a pass. It returns NO_DATA and says what
 * is missing. The old workbooks' habit of reading a blank cell as a zero and a
 * zero as agreement is precisely the failure mode this sheet exists to catch,
 * and a green tick over an empty month would reproduce it here.
 */
import { Decimal, d, type Numeric } from './money'

export type CheckVerdict = 'OK' | 'FLAG' | 'NO_DATA'

export interface CheckResult {
  key: string
  label: string
  verdict: CheckVerdict
  /** The measured figure. Null when there was nothing to measure. */
  value: Decimal | null
  threshold: Decimal | null
  /** What to do about it, in the language of the plant. */
  detail: string
}

/**
 * The thresholds, with the reasoning attached. Every one is the template's own
 * figure unless the comment says otherwise.
 */
export interface CheckThresholds {
  /** Sen of the bill left unexplained by the named lines plus the residual. */
  billUnexplainedSen: Numeric
  /** Unaccounted kWh per day. Above this, a load is missing from the bridge. */
  unallocatedKwhPerDay: Numeric
  /** FOC as a share of blocks moved. */
  focShare: Numeric
  /** Tube plant kWh per kg. */
  tubeKwhPerKg: Numeric
  /** Big pool plus compressor, kWh per kg. */
  poolKwhPerKg: Numeric
  /** Month-on-month move in the blended tariff. */
  rateJump: Numeric
  /** Blocks of BIMC ledger gap — made, less sold, less given away. */
  ledgerGapUnits: Numeric
  /** Counter cash against units priced out, in ringgit. */
  counterReconciliationRm: Numeric
}

export const DEFAULT_THRESHOLDS: CheckThresholds = {
  // Not the template's 0.00. Excel never rounds its intermediate columns, so it
  // can demand an exact tie; this system stores every line to the sen, and the
  // few sen that leaves has to be tolerated or plugged. Two sen per line across
  // a dozen lines is the honest allowance.
  billUnexplainedSen: 25,
  unallocatedKwhPerDay: 250,
  focShare: 0.15,
  tubeKwhPerKg: 0.145,
  poolKwhPerKg: 0.16,
  rateJump: 0.05,
  ledgerGapUnits: 50,
  // Report R1 reconciles June counter cash to the ringgit. A month that misses
  // by more than a single block's price is a keying error, not drift.
  counterReconciliationRm: 30,
}

const ok = (
  key: string,
  label: string,
  value: Decimal | null,
  threshold: Decimal | null,
  detail: string
): CheckResult => ({ key, label, verdict: 'OK', value, threshold, detail })

const flag = (
  key: string,
  label: string,
  value: Decimal | null,
  threshold: Decimal | null,
  detail: string
): CheckResult => ({ key, label, verdict: 'FLAG', value, threshold, detail })

const noData = (key: string, label: string, detail: string): CheckResult => ({
  key,
  label,
  verdict: 'NO_DATA',
  value: null,
  threshold: null,
  detail,
})

export interface CheckInput {
  month: string
  daysInMonth: number

  /** From siteStatement(). Null when the month has no bill yet. */
  unexplainedRm?: Numeric | null
  tieOutKwh?: Numeric | null
  unallocatedKwh?: Numeric | null

  /** Coldroom. `backInferred` drives a check of its own. */
  coldroomMarginRm?: Numeric | null
  coldroomBackInferred?: boolean
  coldroomPresent?: boolean

  /** FOC, on the line that records it. */
  focShare?: Numeric | null
  ledgerGapUnits?: Numeric | null

  /** Intensities. */
  tubeKwhPerKg?: Numeric | null
  poolKwhPerKg?: Numeric | null

  /** Blended tariff, this month and last. */
  ratePerKwh?: Numeric | null
  priorRatePerKwh?: Numeric | null

  /** Counter cash against counter units priced out. */
  counterCashRm?: Numeric | null
  counterPricedRm?: Numeric | null

  /** Days in the month that had no rate to cost with at all. */
  daysWithoutRate?: number

  thresholds?: Partial<CheckThresholds>
}

const num = (v: Numeric | null | undefined): Decimal | null =>
  v === null || v === undefined ? null : d(v)

/**
 * Run every check for a month. Order is deliberate: the bill tie-out comes
 * first because if it fails nothing below it means anything.
 */
export function monthCloseChecks(input: CheckInput): CheckResult[] {
  const t = { ...DEFAULT_THRESHOLDS, ...(input.thresholds ?? {}) }
  const out: CheckResult[] = []

  // 1. Does the statement account for the bill?
  const tieKwh = num(input.tieOutKwh)
  const drift = num(input.unexplainedRm)
  if (tieKwh === null || drift === null) {
    out.push(
      noData(
        'bill-tie-out',
        'Bill tie-out',
        'No confirmed TNB bill for this month, so there is nothing to tie the ' +
          'statement to. Upload and confirm both accounts.'
      )
    )
  } else if (!tieKwh.isZero()) {
    out.push(
      flag(
        'bill-tie-out',
        'Bill tie-out',
        tieKwh,
        d(0),
        `The named lines plus the residual miss billed consumption by ${tieKwh.toFixed(2)} kWh. ` +
          'This should be impossible — the residual is defined as the difference. Report it.'
      )
    )
  } else {
    const driftSen = drift.times(100).abs()
    const limit = d(t.billUnexplainedSen)
    out.push(
      driftSen.greaterThan(limit)
        ? flag(
            'bill-tie-out',
            'Bill tie-out',
            drift,
            limit.dividedBy(100),
            `RM${drift.toFixed(2)} of the bill is neither on a named line nor in the ` +
              'residual — more than sen-rounding explains. The usual cause is a TNB ' +
              'bill period straddling the month, so days are costed at two rates ' +
              "while the residual is struck at one. Check the bill's period dates."
          )
        : ok(
            'bill-tie-out',
            'Bill tie-out',
            drift,
            limit.dividedBy(100),
            `Statement ties to the bill; RM${drift.toFixed(2)} of per-line rounding.`
          )
    )
  }

  // 2. How much of the bill still has no owner?
  const unalloc = num(input.unallocatedKwh)
  if (unalloc === null) {
    out.push(noData('unallocated', 'Unaccounted load', 'No bill, so no residual to measure.'))
  } else {
    const perDay = unalloc.dividedBy(input.daysInMonth).toDecimalPlaces(1)
    const limit = d(t.unallocatedKwhPerDay)
    out.push(
      perDay.abs().greaterThan(limit)
        ? flag(
            'unallocated',
            'Unaccounted load',
            perDay,
            limit,
            `${perDay.toFixed(0)} kWh/day is unaccounted for. ` +
              (perDay.isNegative()
                ? 'A negative residual means the named lines claim more than the bill — ' +
                  'a modelled load is set too high, or a line is counted twice.'
                : 'A load is missing from the bridge, or a standing assumption is too low.')
          )
        : ok(
            'unallocated',
            'Unaccounted load',
            perDay,
            limit,
            `${perDay.toFixed(0)} kWh/day unaccounted, within tolerance.`
          )
    )
  }

  // 3. Is the coldroom measured, or recovered from a stale price?
  //
  // Note the `!== true`. An absent flag is absence of evidence, and an earlier
  // draft of this check read it as evidence of absence — an empty month came
  // back "Coldroom read from its sub-meter", which was both false and exactly
  // the failure this sheet exists to catch.
  if (input.coldroomPresent !== true) {
    out.push(
      noData(
        'coldroom-source',
        'Coldroom measurement',
        'No coldroom figures for this month. The whole coldroom load is sitting ' +
          'inside the unaccounted residual above, and every figure derived from ' +
          'it is absent rather than zero.'
      )
    )
  } else if (input.coldroomBackInferred) {
    out.push(
      flag(
        'coldroom-source',
        'Coldroom measurement',
        null,
        null,
        'Coldroom kWh was recovered by dividing the ringgit compilations by the ' +
          'frozen RM0.484/kWh factor, not read from the sub-meter. Every coldroom ' +
          'figure this month inherits that rate. Read the sub-meter.'
      )
    )
  } else {
    out.push(
      ok('coldroom-source', 'Coldroom measurement', null, null, 'Coldroom read from its sub-meter.')
    )
  }

  // 4. Is reselling power to tenants still profitable?
  const crMargin = num(input.coldroomMarginRm)
  if (crMargin === null) {
    out.push(noData('coldroom-margin', 'Coldroom margin', 'No coldroom figures for this month.'))
  } else {
    out.push(
      crMargin.isNegative()
        ? flag(
            'coldroom-margin',
            'Coldroom margin',
            crMargin,
            d(0),
            `Tenant recharges are RM${crMargin.abs().toFixed(2)} below what the power cost. ` +
              'The tenant rate is now under the blended tariff — reprice or absorb it knowingly.'
          )
        : ok(
            'coldroom-margin',
            'Coldroom margin',
            crMargin,
            d(0),
            `RM${crMargin.toFixed(2)} recovered above cost.`
          )
    )
  }

  // 5. How much ice is going out free?
  const foc = num(input.focShare)
  if (foc === null) {
    out.push(
      noData('foc-share', 'FOC share', 'No FOC quantities recorded, or no sold ledger to compare against.')
    )
  } else {
    const limit = d(t.focShare)
    out.push(
      foc.greaterThan(limit)
        ? flag(
            'foc-share',
            'FOC share',
            foc,
            limit,
            `${foc.times(100).toFixed(1)}% of blocks moved went out free. ` +
              'Confirm whether these are defects or shrinkage — the remedy differs.'
          )
        : ok('foc-share', 'FOC share', foc, limit, `${foc.times(100).toFixed(1)}% of blocks moved.`)
    )
  }

  // 6. Does the block ledger balance?
  const gap = num(input.ledgerGapUnits)
  if (gap === null) {
    out.push(
      noData(
        'ledger-gap',
        'Block ledger gap',
        'No sold-block count for this month, so made-less-sold-less-free cannot be struck.'
      )
    )
  } else {
    const limit = d(t.ledgerGapUnits)
    out.push(
      gap.abs().greaterThan(limit)
        ? flag(
            'ledger-gap',
            'Block ledger gap',
            gap,
            limit,
            `${gap.toFixed(0)} blocks made are neither sold nor recorded free. ` +
              'This is a control question, not a costing one.'
          )
        : ok('ledger-gap', 'Block ledger gap', gap, limit, `${gap.toFixed(0)} blocks unexplained.`)
    )
  }

  // 7 and 8. Are the two metered lines drifting?
  for (const [key, label, value, limit, hint] of [
    [
      'tube-intensity',
      'Tube plant intensity',
      num(input.tubeKwhPerKg),
      d(t.tubeKwhPerKg),
      'Tube ice has run 0.133-0.136 kWh/kg all year.',
    ],
    [
      'pool-intensity',
      'Big pool intensity',
      num(input.poolKwhPerKg),
      d(t.poolKwhPerKg),
      'Big pool including the compressor has run 0.128-0.141 kWh/kg all year.',
    ],
  ] as const) {
    if (value === null) {
      out.push(noData(key, label, 'No production or no metered consumption for this line.'))
      continue
    }
    out.push(
      value.greaterThan(limit)
        ? flag(
            key,
            label,
            value,
            limit,
            `${value.toFixed(4)} kWh/kg is above the band. ${hint} ` +
              'Check for missed production entry before suspecting the plant.'
          )
        : ok(key, label, value, limit, `${value.toFixed(4)} kWh/kg.`)
    )
  }

  // 9. Did the tariff move enough to explain a cost jump on its own?
  const rate = num(input.ratePerKwh)
  const prior = num(input.priorRatePerKwh)
  if (rate === null || prior === null || prior.isZero()) {
    out.push(
      noData('rate-jump', 'Tariff move', 'No prior month rate to compare against.')
    )
  } else {
    const move = rate.minus(prior).dividedBy(prior).toDecimalPlaces(4)
    const limit = d(t.rateJump)
    out.push(
      move.abs().greaterThan(limit)
        ? flag(
            'rate-jump',
            'Tariff move',
            move,
            limit,
            `The blended rate moved ${move.times(100).toFixed(1)}% on last month. ` +
              'Cost per kg moves with it. Flat kWh/kg alongside this is tariff, ' +
              'not the plant — say so before anyone reads it the other way.'
          )
        : ok('rate-jump', 'Tariff move', move, limit, `${move.times(100).toFixed(1)}% on last month.`)
    )
  }

  // 10. Does counter cash agree with counter units priced out?
  const cash = num(input.counterCashRm)
  const priced = num(input.counterPricedRm)
  if (cash === null || priced === null) {
    out.push(
      noData(
        'counter-reconciliation',
        'Counter reconciliation',
        'Counter unit sales are not recorded for this month, so cash cannot be ' +
          'reconciled against what was sold.'
      )
    )
  } else {
    const diff = cash.minus(priced)
    const limit = d(t.counterReconciliationRm)
    out.push(
      diff.abs().greaterThan(limit)
        ? flag(
            'counter-reconciliation',
            'Counter reconciliation',
            diff,
            limit,
            `Counter cash differs from units priced out by RM${diff.toFixed(2)}. ` +
              'Either a price epoch is wrong or units are missing from the ledger.'
          )
        : ok(
            'counter-reconciliation',
            'Counter reconciliation',
            diff,
            limit,
            `Cash and units agree to RM${diff.abs().toFixed(2)}.`
          )
    )
  }

  // 11. Did any day go uncosted?
  if (input.daysWithoutRate !== undefined && input.daysWithoutRate > 0) {
    out.push(
      flag(
        'uncosted-days',
        'Uncosted days',
        d(input.daysWithoutRate),
        d(0),
        `${input.daysWithoutRate} day(s) have consumption recorded but no rate to cost it ` +
          'with. They are left uncosted rather than guessed; confirm the bill to close them.'
      )
    )
  } else if (input.daysWithoutRate === 0) {
    out.push(ok('uncosted-days', 'Uncosted days', d(0), d(0), 'Every day with data carries a rate.'))
  }

  return out
}

/** A month is closeable when nothing is flagged. NO_DATA blocks it too. */
export function closeable(results: CheckResult[]): boolean {
  return results.every((r) => r.verdict === 'OK')
}

export const countBy = (results: CheckResult[], verdict: CheckVerdict): number =>
  results.filter((r) => r.verdict === verdict).length
