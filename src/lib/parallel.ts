/**
 * Parallel check.
 *
 * Pick a month, upload the workbook she is still keeping by hand, and see
 * field by field where it and the database disagree. Anything that differs is
 * either a spreadsheet error or an import error, and both are worth knowing.
 *
 * The design decision that makes this screen useful rather than noise: some
 * columns are EXPECTED to differ, because the rebuilt system deliberately
 * computes them another way. Those are mapped or explained rather than shown
 * red every single day — a screen that cries wolf thirty times a month gets
 * ignored, and then a real break goes unseen.
 */
import ExcelJS from 'exceljs'
import { Decimal, d } from './money'

/** The constants frozen into the legacy sheets. Named, so nothing here is magic. */
export const LEGACY = {
  /** The pre-July-2025 tariff hardcoded into every row of every meter file. */
  tariffRmPerKwh: d('0.484'),
  /** Flat daily booking added to the big pool meter to stand in for the China machine. */
  bigPoolKwhBooking: d('429'),
  /** Blanket gross-up on big pool cost, for loads outside its sub-meter. */
  bigPoolLoader: d('1.2'),
} as const

export type Verdict = 'MATCH' | 'DIFFERS' | 'MISSING_HERE' | 'MISSING_THERE'

export interface FieldDiff {
  day: number
  field: string
  /** How the figure was obtained from the sheet, when it was not read directly. */
  derivation?: string
  sheet: number | null
  system: number | null
  difference: number | null
  verdict: Verdict
  tolerance: number
}

export interface ParallelResult {
  month: string
  sheetName: string
  /** Rows compared, in sheet order. */
  diffs: FieldDiff[]
  matched: number
  differed: number
  missing: number
  /** Columns deliberately not compared, and why. */
  excluded: { field: string; reason: string }[]
  notes: string[]
}

export interface SystemDay {
  day: number
  cash: Decimal | null
  outsideSales: Decimal | null
  totalKg: Decimal | null
  tubeKg: Decimal | null
  /** Big pool and BIMC together — the legacy column holds the two added up. */
  bigPoolPlusBimcKg: Decimal | null
  smallPoolKg: Decimal | null
  tubeKwh: Decimal | null
  bigPoolKwh: Decimal | null
}

/** Cached formula results come back as `{ result }`; plain cells as a number. */
function cellNumber(ws: ExcelJS.Worksheet, row: number, col: number): number | null {
  const v = ws.getCell(row, col).value
  const raw =
    v && typeof v === 'object' && 'result' in v
      ? (v as { result: unknown }).result
      : v
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) {
    return Number(raw)
  }
  return null
}

/**
 * Finds the sheet for a month. Names are dirty — `'aug '` with a trailing
 * space, `mac` for March — so match the way the importer does.
 */
export function findSheet(wb: ExcelJS.Workbook, month: string): ExcelJS.Worksheet | null {
  const names: Record<number, string[]> = {
    1: ['jan'], 2: ['feb'], 3: ['mac', 'mar'], 4: ['apr'], 5: ['may', 'mei'],
    6: ['jun'], 7: ['july', 'jul'], 8: ['aug', 'ogos'], 9: ['sept', 'sep'],
    10: ['oct', 'okt'], 11: ['nov'], 12: ['dec', 'dis'],
  }
  const wanted = names[Number(month.slice(5, 7))] ?? []
  let best: ExcelJS.Worksheet | null = null
  let bestLen = 0
  for (const ws of wb.worksheets) {
    const clean = ws.name.trim().toLowerCase().replace(/[^a-z]/g, '')
    for (const w of wanted) {
      if (clean === w && w.length > bestLen) { best = ws; bestLen = w.length }
    }
  }
  return best
}

/**
 * The Daily Rekod Ais layout. Data rows start at 6 for day 1.
 *   B cash · C sales outside · E total kg · F "total kWh" (actually ringgit)
 *   J tube kg · K big pool kg (BIMC added in) · L small pool kg
 *   M/N/O per-line ringgit, headed "kWh"
 */
const MASTER = {
  firstRow: 6,
  dayCol: 1, cash: 2, outside: 3, totalKg: 5, totalRm: 6,
  tubeKg: 10, bigPoolKg: 11, smallPoolKg: 12,
  tubeRm: 13, bigPoolRm: 14, smallPoolRm: 15,
} as const

const TOLERANCE = {
  money: 0.01,
  kg: 0.5,
  /** The legacy ringgit columns are rounded to whole ringgit, so inverting the
   *  formula recovers kWh only to about one unit. */
  kwhInverted: 2,
}

const compare = (
  day: number, field: string, sheet: number | null, system: number | null,
  tolerance: number, derivation?: string
): FieldDiff => {
  // A sheet zero against no row here means the same thing — nothing was
  // produced — and reporting it as a difference on every idle line, every day,
  // would bury the differences that matter.
  const bothEmpty =
    (sheet === null || sheet === 0) && (system === null || system === 0)
  const verdict: Verdict =
    bothEmpty ? 'MATCH'
      : sheet === null ? 'MISSING_THERE'
      : system === null ? 'MISSING_HERE'
      : Math.abs(sheet - system) <= tolerance ? 'MATCH'
      : 'DIFFERS'
  return {
    day, field, sheet, system,
    difference: sheet !== null && system !== null ? Number((sheet - system).toFixed(4)) : null,
    verdict, tolerance, derivation,
  }
}

export function compareMaster(
  wb: ExcelJS.Workbook,
  month: string,
  system: SystemDay[]
): ParallelResult {
  const ws = findSheet(wb, month)
  if (!ws) {
    return {
      month, sheetName: '',
      diffs: [], matched: 0, differed: 0, missing: 0, excluded: [],
      notes: [
        `No sheet in this workbook resolves to ${month}. Sheets found: ` +
          wb.worksheets.map((w) => JSON.stringify(w.name)).join(', ') + '.',
      ],
    }
  }

  const byDay = new Map(system.map((s) => [s.day, s]))
  const days = new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)
  ).getUTCDate()

  const num = (v: Decimal | null | undefined) => (v ? Number(v) : null)
  const diffs: FieldDiff[] = []

  for (let day = 1; day <= days; day++) {
    const row = MASTER.firstRow + day - 1
    if (cellNumber(ws, row, MASTER.dayCol) !== day) continue
    const s = byDay.get(day)

    const sheetCash = cellNumber(ws, row, MASTER.cash)
    const sheetOutside = cellNumber(ws, row, MASTER.outside)
    const sheetTotalKg = cellNumber(ws, row, MASTER.totalKg)
    const sheetTubeKg = cellNumber(ws, row, MASTER.tubeKg)
    const sheetBigKg = cellNumber(ws, row, MASTER.bigPoolKg)
    const sheetSmallKg = cellNumber(ws, row, MASTER.smallPoolKg)

    // Nothing on the sheet and nothing here: not a row worth reporting.
    if (
      sheetCash === null && sheetTotalKg === null && !s
    ) continue

    diffs.push(compare(day, 'Cash daily', sheetCash, num(s?.cash), TOLERANCE.money))
    diffs.push(compare(day, 'Sales outside', sheetOutside, num(s?.outsideSales), TOLERANCE.money))
    diffs.push(compare(day, 'Total kg', sheetTotalKg, num(s?.totalKg), TOLERANCE.kg))
    diffs.push(compare(day, 'Tube kg', sheetTubeKg, num(s?.tubeKg), TOLERANCE.kg))
    // The legacy "Big Pool" column is big pool and the China machine added
    // together, so it is compared against the pair rather than shown as a
    // difference every day of the month.
    diffs.push(compare(
      day, 'Big pool + BIMC kg', sheetBigKg, num(s?.bigPoolPlusBimcKg), TOLERANCE.kg,
      'the legacy Big Pool column holds both lines added together'
    ))
    diffs.push(compare(day, 'Small pool kg', sheetSmallKg, num(s?.smallPoolKg), TOLERANCE.kg))

    // The ringgit columns are kWh times a frozen tariff, so inverting that
    // arithmetic recovers the consumption the sheet was built from. It is the
    // only way to check the meter readings against a sheet that never stored them.
    const tubeRm = cellNumber(ws, row, MASTER.tubeRm)
    if (tubeRm !== null) {
      diffs.push(compare(
        day, 'Tube kWh', Number(d(tubeRm).dividedBy(LEGACY.tariffRmPerKwh).toFixed(2)),
        num(s?.tubeKwh), TOLERANCE.kwhInverted,
        `sheet ringgit ${tubeRm} divided by the frozen ${LEGACY.tariffRmPerKwh} tariff`
      ))
    }
    const bigRm = cellNumber(ws, row, MASTER.bigPoolRm)
    if (bigRm !== null) {
      const inverted = d(bigRm)
        .dividedBy(LEGACY.tariffRmPerKwh.times(LEGACY.bigPoolLoader))
        .minus(LEGACY.bigPoolKwhBooking)
      diffs.push(compare(
        day, 'Big pool kWh', Number(inverted.toFixed(2)), num(s?.bigPoolKwh),
        TOLERANCE.kwhInverted,
        `sheet ringgit ${bigRm} divided by ${LEGACY.tariffRmPerKwh} and the ` +
          `${LEGACY.bigPoolLoader} loader, less the ${LEGACY.bigPoolKwhBooking} kWh booking`
      ))
    }
  }

  return {
    month,
    sheetName: ws.name,
    diffs,
    matched: diffs.filter((x) => x.verdict === 'MATCH').length,
    differed: diffs.filter((x) => x.verdict === 'DIFFERS').length,
    missing: diffs.filter((x) => x.verdict.startsWith('MISSING')).length,
    excluded: [
      {
        field: 'Total kWh, and the per-line kWh columns',
        reason:
          'These hold ringgit at the frozen 0.484 tariff, not kilowatt hours. ' +
          'They are inverted back to consumption above rather than compared directly.',
      },
      {
        field: '% Kwh/sales and RM Kwh/kg',
        reason:
          'Ratio columns, recomputed here from monthly totals. The sheet sums ' +
          'them down the column, which is not a quantity that can be compared.',
      },
      {
        field: 'Rows 39 to 42',
        reason:
          'Totals and prior-month averages. The sheet divides by a hardcoded 13 ' +
          'and chains to the previous month, so neither figure is comparable.',
      },
    ],
    notes: [],
  }
}

export async function readWorkbook(buf: Buffer): Promise<ExcelJS.Workbook | null> {
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer)
  } catch {
    return null
  }
  // Legacy .xls opens with no worksheets rather than throwing.
  return wb.worksheets.length ? wb : null
}
