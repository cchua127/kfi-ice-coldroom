/**
 * Stage 2: turn extracted cells into records, with every known trap handled.
 *
 * The master workbook (`Daily rekod Ais`) is deliberately NOT a source. It is a
 * roll-up of the detail files with the same numbers re-typed by hand, so
 * importing it would double-count. It is the parallel-run comparison target.
 */
import type { Workbook, Sheet } from './extract-types'
import { num, str, cellAt } from './extract-types'
import { resolveSheet, type ResolvedSheet } from './sheet-names'
import { findMonthMarker, mapCustomerColumns, unknownCustomerLabels } from './layout'

export type IssueLevel = 'ERROR' | 'WARN' | 'INFO'

export interface Issue {
  level: IssueLevel
  workbook: string
  sheet: string
  row?: number
  code: string
  message: string
}

export interface MeterReadingRecord {
  meterCode: 'TUBE' | 'BIG_POOL' | 'SMALL_POOL'
  readingDate: string
  closing: number
  /**
   * Derived from a row's "Mula" rather than read as that day's "Akhir". Only
   * ever used to give the earliest day in a series its opening; a real closing
   * for the same date always wins.
   */
  fromOpening?: boolean
}

export interface ProductionRecord {
  line: 'TUBE' | 'BIG_POOL' | 'BIMC' | 'SMALL_POOL'
  prodDate: string
  unitCode: 'BAG' | 'TONG' | 'BARIS' | 'SMALL_TONG' | 'BLOK'
  quantity: number
  focQuantity?: number
  tongKosong?: number
  quantitySource?: 'COUNTED' | 'CONVENTION'
  note?: string
}

export interface CashRecord {
  saleDate: string
  shift1: number
  shift2: number
}

export interface OutsideSaleRecord {
  saleDate: string
  customer: string
  /** Null when the customer is new and nobody has said which product they buy. */
  product: string | null
  quantity: number
  /** Unit price as printed in the sheet header, for dating the price list. */
  sheetUnitPrice?: number
  /** What the sheet itself shows, for the dry-run diff. Not necessarily loaded. */
  sheetAmount?: number
  note?: string
}

export interface PurchaseRecord {
  buyDate: string
  supplier: string
  doNo?: string
  quantity: number
  sheetAmount?: number
}

export interface ColdroomReadingRecord {
  /** 'YYYY-MM'. */
  periodMonth: string
  /** 1-based position in the month's register. Part of the key — see below. */
  rowNo: number
  roomCode: string
  tenantLabel: string | null
  ownUse: boolean
  openingKwh: number
  closingKwh: number
  rateRmPerKwh: number
  usageGroup: number | null
  /** What the sheet itself shows, for the dry-run diff. Never loaded. */
  sheetUsage?: number
  sheetAmount?: number
}

export interface ParseResult {
  resolved: ResolvedSheet[]
  meterReadings: MeterReadingRecord[]
  production: ProductionRecord[]
  cash: CashRecord[]
  outsideSales: OutsideSaleRecord[]
  purchases: PurchaseRecord[]
  coldroomReadings: ColdroomReadingRecord[]
  issues: Issue[]
}

const empty = (): ParseResult => ({
  resolved: [], meterReadings: [], production: [], cash: [],
  outsideSales: [], purchases: [], coldroomReadings: [], issues: [],
})

const merge = (a: ParseResult, b: ParseResult): ParseResult => ({
  resolved: [...a.resolved, ...b.resolved],
  meterReadings: [...a.meterReadings, ...b.meterReadings],
  production: [...a.production, ...b.production],
  cash: [...a.cash, ...b.cash],
  outsideSales: [...a.outsideSales, ...b.outsideSales],
  purchases: [...a.purchases, ...b.purchases],
  coldroomReadings: [...a.coldroomReadings, ...b.coldroomReadings],
  issues: [...a.issues, ...b.issues],
})

const pad = (n: number) => String(n).padStart(2, '0')
const isoDay = (month: string, day: number) => `${month}-${pad(day)}`

const daysInMonth = (month: string): number => {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

interface SheetContext {
  wb: Workbook
  sheetName: string
  sheet: Sheet
  month: string
  issues: Issue[]
  out: ParseResult
}

/**
 * Walks a workbook, resolving each sheet's month from the sheet's own marker
 * before falling back to its name. The fallback alone would have put the
 * Oct'25 and Nov'25 ice-purchase sheets a year out.
 */
function eachSheet(
  wb: Workbook,
  defaultYear: number,
  handler: (ctx: SheetContext) => void,
  skip?: (name: string) => boolean
): ParseResult {
  const out = empty()
  for (const [sheetName, sheet] of Object.entries(wb.sheets)) {
    if (skip?.(sheetName)) continue
    const resolved = resolveSheet(sheetName, {
      monthCellIso: findMonthMarker(sheet),
      defaultYear,
    })
    out.resolved.push(resolved)

    if (resolved.conflict) {
      out.issues.push({
        level: 'ERROR', workbook: wb.workbook, sheet: sheetName,
        code: 'SHEET_MONTH_CONFLICT', message: resolved.conflict,
      })
      continue
    }
    if (!resolved.month) {
      out.issues.push({
        level: 'ERROR', workbook: wb.workbook, sheet: sheetName,
        code: 'SHEET_MONTH_UNRESOLVED',
        message: `Could not resolve a month for sheet "${sheetName}".`,
      })
      continue
    }
    if (resolved.source === 'NAME') {
      out.issues.push({
        level: 'WARN', workbook: wb.workbook, sheet: sheetName,
        code: 'SHEET_MONTH_FROM_NAME',
        message:
          `Sheet "${sheetName}" carries no month marker; year inferred as ` +
          `${resolved.month}. Confirm before loading.`,
      })
    }

    const ctx: SheetContext = { wb, sheetName, sheet, month: resolved.month, issues: [], out }
    handler(ctx)
    out.issues.push(...ctx.issues)
  }
  return out
}

/**
 * Meter book shared shape: the tube and pool sheets all run day-per-row with a
 * Mula/Akhir pair. A blank Akhir on an unfilled row is normal for the current
 * month — the legacy sheets turned it into `0 - opening` and carried
 * seven-figure negatives, so here it is simply skipped.
 */
function readMeterDays(
  ctx: SheetContext,
  opts: {
    firstRow: number
    dayCol: string
    /** "Akhir" — the day's closing register value. */
    closingCol: string
    /** "Mula" — the day's opening, which is the prior day's closing. */
    openingCol: string
    meterCode: MeterReadingRecord['meterCode']
  },
  out: ParseResult
) {
  const last = daysInMonth(ctx.month)
  let firstFilled: { day: number; opening: number } | null = null

  for (let i = 0; i < last; i++) {
    const row = opts.firstRow + i
    const day = num(ctx.sheet, row, opts.dayCol)
    if (day === null || day < 1 || day > last) continue
    const closing = num(ctx.sheet, row, opts.closingCol)
    if (closing === null || closing === 0) continue

    if (!firstFilled) {
      const opening = num(ctx.sheet, row, opts.openingCol)
      if (opening !== null && opening > 0) firstFilled = { day, opening }
    }
    out.meterReadings.push({
      meterCode: opts.meterCode,
      readingDate: isoDay(ctx.month, day),
      closing,
    })
  }

  // The first row's Mula is a real reading — the register as it stood at the
  // end of the previous day. Without it the earliest day in the whole series
  // has no opening and its consumption is silently dropped. On the tube meter
  // that is 1 January 2026, which report R6 records as a 10 kWh idle day.
  if (firstFilled) {
    const prior = new Date(`${isoDay(ctx.month, firstFilled.day)}T00:00:00Z`)
    prior.setUTCDate(prior.getUTCDate() - 1)
    out.meterReadings.push({
      meterCode: opts.meterCode,
      readingDate: prior.toISOString().slice(0, 10),
      closing: firstFilled.opening,
      fromOpening: true,
    })
  }
}

// ---------------------------------------------------------------------------
// Meter - tube ice - elec.  Data rows 8-38. Month marker B5.
//   A day | C kWh | D bags | F tong | H total kg | N Mula | O Akhir | P =O-N
// ---------------------------------------------------------------------------
export function parseTube(wb: Workbook, defaultYear = 2026): ParseResult {
  return eachSheet(wb, defaultYear, (ctx) => {
    const out = ctx.out
    readMeterDays(ctx, { firstRow: 8, dayCol: 'A', closingCol: 'O', openingCol: 'N', meterCode: 'TUBE' }, out)
    const last = daysInMonth(ctx.month)
    for (let i = 0; i < last; i++) {
      const row = 8 + i
      const day = num(ctx.sheet, row, 'A')
      if (day === null || day < 1 || day > last) continue
      const date = isoDay(ctx.month, day)
      const bags = num(ctx.sheet, row, 'D')
      const tong = num(ctx.sheet, row, 'F')
      if (bags === null && tong === null) continue
      if (bags !== null) {
        out.production.push({ line: 'TUBE', prodDate: date, unitCode: 'BAG', quantity: bags })
      }
      if (tong !== null) {
        out.production.push({ line: 'TUBE', prodDate: date, unitCode: 'TONG', quantity: tong })
      }
      // Cross-check against the sheet's own kg, which carries the in-cell sums
      // like `27+30` already evaluated by Excel.
      const sheetKg = num(ctx.sheet, row, 'H')
      const computed = (bags ?? 0) * 12.5 + (tong ?? 0) * 100
      if (sheetKg !== null && Math.abs(sheetKg - computed) > 0.01) {
        ctx.issues.push({
          level: 'WARN', workbook: wb.workbook, sheet: ctx.sheetName, row,
          code: 'TUBE_KG_MISMATCH',
          message: `Sheet kg ${sheetKg} but bags/tong give ${computed}.`,
        })
      }
    }
  })
}

// ---------------------------------------------------------------------------
// meter BIG POOL vs elec.  Data rows 6-36. Month marker B3.
//   A day | C kWh | E baris | G BIMC count | H tong kosong
//   I big tong kg | J small tong kg | S Mula | T Akhir
//
// G is the literal constant 200 on every row of every sheet: a mould count, not
// a harvest count. Imported as CONVENTION so it can never pass for measured.
// ---------------------------------------------------------------------------
export function parseBigPool(wb: Workbook, defaultYear = 2026): ParseResult {
  return eachSheet(wb, defaultYear, (ctx) => {
    const out = ctx.out
    readMeterDays(ctx, { firstRow: 6, dayCol: 'A', closingCol: 'T', openingCol: 'S', meterCode: 'BIG_POOL' }, out)
    const last = daysInMonth(ctx.month)
    const bimcSeen = new Set<number>()
    for (let i = 0; i < last; i++) {
      const row = 6 + i
      const day = num(ctx.sheet, row, 'A')
      if (day === null || day < 1 || day > last) continue
      const date = isoDay(ctx.month, day)

      const baris = num(ctx.sheet, row, 'E')
      const tongKosong = num(ctx.sheet, row, 'H') ?? 0
      if (baris !== null && baris > 0) {
        out.production.push({
          line: 'BIG_POOL', prodDate: date, unitCode: 'BARIS',
          quantity: baris, tongKosong,
        })
      }
      const bimc = num(ctx.sheet, row, 'G')
      if (bimc !== null && bimc > 0) {
        bimcSeen.add(bimc)
        out.production.push({
          line: 'BIMC', prodDate: date, unitCode: 'SMALL_TONG',
          quantity: bimc, quantitySource: 'CONVENTION',
          note: 'Booked from the flat per-day figure in the legacy sheet, not counted.',
        })
      }
    }
    if (bimcSeen.size === 1) {
      ctx.issues.push({
        level: 'INFO', workbook: wb.workbook, sheet: ctx.sheetName,
        code: 'BIMC_FLAT_CONVENTION',
        message:
          `BIMC quantity is the constant ${[...bimcSeen][0]} on every day of this ` +
          `sheet. Imported as CONVENTION, not COUNTED.`,
      })
    }
  })
}

// ---------------------------------------------------------------------------
// meter SMALL POOL vs elec.  Two sheet kinds.
//
// Daily sheets (`jan`, `dec25`), rows 6-36, month marker B3:
//   A day | C kWh | D small baris | F big baris | T Mula | U Akhir
//   K=38 kg per small block (NOT 45 — that is the China machine)
//
// Ledger sheets (`jan-baris`), rows 6+, month marker B2: TWO rows per date, one
// BIG and one SMALL — they are block types, not shifts. FOC is recorded here
// and nowhere else in the supplied workbooks.
//   A date | J small baris | L big baris | N FOC blocks | O total blocks
// ---------------------------------------------------------------------------
export function parseSmallPool(wb: Workbook, defaultYear = 2026): ParseResult {
  const out = empty()
  const foc = new Map<string, { small: number; big: number }>()

  // Ledger sheets first, so FOC is available when the daily rows are built.
  for (const [sheetName, sheet] of Object.entries(wb.sheets)) {
    const resolved = resolveSheet(sheetName, {
      monthCellIso: findMonthMarker(sheet),
      defaultYear,
    })
    if (!resolved.isBarisLedger || !resolved.month) continue
    out.resolved.push(resolved)
    for (let row = 6; row <= sheet.maxRow; row++) {
      const day = num(sheet, row, 'A')
      if (day === null || day < 1 || day > 31) continue
      const date = isoDay(resolved.month, day)
      const smallBaris = num(sheet, row, 'J') ?? 0
      const bigBaris = num(sheet, row, 'L') ?? 0
      const focBlocks = num(sheet, row, 'N') ?? 0
      if (focBlocks === 0) continue
      const cur = foc.get(date) ?? { small: 0, big: 0 }
      if (smallBaris > 0) cur.small += focBlocks
      else if (bigBaris > 0) cur.big += focBlocks
      foc.set(date, cur)
    }
    out.issues.push({
      level: 'INFO', workbook: wb.workbook, sheet: sheetName,
      code: 'FOC_LEDGER',
      message:
        'Shift ledger read for FOC. Two rows per date are BIG and SMALL block ' +
        'types, not two shifts.',
    })
  }

  const res = eachSheet(wb, defaultYear, (ctx) => {
    readMeterDays(
      ctx, { firstRow: 6, dayCol: 'A', closingCol: 'U', openingCol: 'T', meterCode: 'SMALL_POOL' }, ctx.out
    )
    const last = daysInMonth(ctx.month)
    for (let i = 0; i < last; i++) {
      const row = 6 + i
      const day = num(ctx.sheet, row, 'A')
      if (day === null || day < 1 || day > last) continue
      const date = isoDay(ctx.month, day)
      const smallBaris = num(ctx.sheet, row, 'D')
      const bigBaris = num(ctx.sheet, row, 'F')
      const f = foc.get(date)
      if (smallBaris !== null && smallBaris > 0) {
        ctx.out.production.push({
          line: 'SMALL_POOL', prodDate: date, unitCode: 'SMALL_TONG',
          quantity: smallBaris * 23, focQuantity: f?.small ?? 0,
          note: '23 small blocks per baris; 38 kg per block',
        })
      }
      if (bigBaris !== null && bigBaris > 0) {
        ctx.out.production.push({
          line: 'SMALL_POOL', prodDate: date, unitCode: 'BLOK',
          quantity: bigBaris * 8, focQuantity: f?.big ?? 0,
        })
      }
    }
  }, (name) => resolveSheet(name, { defaultYear }).isBarisLedger)
  return merge(out, res)
}

// ---------------------------------------------------------------------------
// daily cash ice.  Data rows 5-35. Month marker K1.
//   A day | B shift 1 | C shift 2 | D total
// E Pro Sheet Rpt, F Fatman, G total, O Ratono and P Dif are excluded entirely
// per owner instruction — not imported, not displayed, not reconciled against.
// ---------------------------------------------------------------------------
export function parseCash(wb: Workbook, defaultYear = 2026): ParseResult {
  return eachSheet(wb, defaultYear, (ctx) => {
    const out = ctx.out
    const last = daysInMonth(ctx.month)
    for (let i = 0; i < last; i++) {
      const row = 5 + i
      const day = num(ctx.sheet, row, 'A')
      if (day === null || day < 1 || day > last) continue
      const s1 = num(ctx.sheet, row, 'B')
      const s2 = num(ctx.sheet, row, 'C')
      if ((s1 ?? 0) === 0 && (s2 ?? 0) === 0) continue
      const date = isoDay(ctx.month, day)
      out.cash.push({ saleDate: date, shift1: s1 ?? 0, shift2: s2 ?? 0 })

      const sheetTotal = num(ctx.sheet, row, 'D')
      if (sheetTotal !== null && Math.abs(sheetTotal - ((s1 ?? 0) + (s2 ?? 0))) > 0.01) {
        ctx.issues.push({
          level: 'WARN', workbook: wb.workbook, sheet: ctx.sheetName, row,
          code: 'CASH_TOTAL_MISMATCH',
          message: `Sheet total ${sheetTotal} but shifts sum to ${(s1 ?? 0) + (s2 ?? 0)}.`,
        })
      }
    }
  })
}

// ---------------------------------------------------------------------------
// Ice Purchase & sales outside.  Data rows 6-36. Month marker N2 ("Sept'26").
//   B day | C/D Ocean Ice DO + qty | F Sydney | H TCC
//   J Good Taste free text `blok/crush` | L Burger | K sheet RM | N row total
// ---------------------------------------------------------------------------

/**
 * Reverses Excel's silent conversion of a `blok/crush` entry into a date.
 * `"7/57"` was read as July 1957 and stored as 1957-07-01, losing the data.
 * Month maps back to blok, two-digit year back to crush.
 */
export function reverseGoodTasteDate(iso: string): { blok: number; crush: number } | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const [, year, month, day] = m
  if (Number(day) !== 1) return null
  const crush = Number(year) % 100
  const blok = Number(month)
  if (!Number.isFinite(blok) || !Number.isFinite(crush)) return null
  return { blok, crush }
}

/** Parses `"7/55"`, `"8.5/68"`, or a corrupted date cell. */
export function parseGoodTaste(cellValue: string, isDate: boolean):
  | { blok: number; crush: number; recovered: boolean }
  | null {
  if (isDate) {
    const r = reverseGoodTasteDate(cellValue)
    return r ? { ...r, recovered: true } : null
  }
  const m = cellValue.trim().match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/)
  if (!m) return null
  return { blok: Number(m[1]), crush: Number(m[2]), recovered: false }
}

export function parseIcePurchase(wb: Workbook, defaultYear = 2026): ParseResult {
  return eachSheet(wb, defaultYear, (ctx) => {
    const out = ctx.out
    const columns = mapCustomerColumns(ctx.sheet)
    if (!columns.length) {
      ctx.issues.push({
        level: 'ERROR', workbook: wb.workbook, sheet: ctx.sheetName,
        code: 'NO_CUSTOMER_COLUMNS',
        message: 'No customer header columns recognised on this sheet.',
      })
      return
    }

    // Customers come and go between months. Anything unrecognised is reported
    // rather than guessed at — mapping it to the wrong product would corrupt
    // revenue silently.
    for (const label of unknownCustomerLabels(ctx.sheet)) {
      ctx.issues.push({
        level: 'WARN', workbook: wb.workbook, sheet: ctx.sheetName,
        code: 'UNRECOGNISED_HEADER',
        message: `Header "${label}" is not a known customer. Ignored.`,
      })
    }

    for (const c of columns) {
      if (c.customer && !['Ocean Ice', 'Sydney', 'TCC', 'Good Taste', 'Burger'].includes(c.customer)) {
        ctx.issues.push({
          level: 'WARN', workbook: wb.workbook, sheet: ctx.sheetName,
          code: 'NEW_CUSTOMER',
          message:
            `"${c.label}" appears in this month but is not in the seeded customer ` +
            `list. Quantities are read; the product they buy needs confirming ` +
            `before they can be loaded.`,
        })
      }
    }

    const last = daysInMonth(ctx.month)
    for (let i = 0; i < last; i++) {
      const row = 6 + i
      const day = num(ctx.sheet, row, 'B')
      if (day === null || day < 1 || day > last) continue
      const date = isoDay(ctx.month, day)

      for (const c of columns) {
        if (!c.customer) continue

        if (c.customer === 'Ocean Ice') {
          const q = num(ctx.sheet, row, c.quantityCol)
          if (q === null || q === 0) continue
          out.purchases.push({
            buyDate: date, supplier: 'Ocean Ice',
            doNo: str(ctx.sheet, row, 'C') ?? undefined,
            quantity: q,
            sheetAmount: num(ctx.sheet, row, c.amountCol) ?? undefined,
          })
          continue
        }

        // Good Taste records two products in one free-text cell.
        if (c.isFreeTextPair) {
          const cell = cellAt(ctx.sheet, row, c.quantityCol)
          if (!cell || cell.v === null || cell.v === '' || cell.v === 0) continue
          const parsed = parseGoodTaste(String(cell.v), cell.t === 'date')
          if (!parsed) {
            ctx.issues.push({
              level: 'ERROR', workbook: wb.workbook, sheet: ctx.sheetName, row,
              code: 'FREE_TEXT_PAIR_UNPARSED',
              message: `Could not read ${c.customer} quantity ${JSON.stringify(cell.v)}.`,
            })
            continue
          }
          if (parsed.recovered) {
            ctx.issues.push({
              level: 'WARN', workbook: wb.workbook, sheet: ctx.sheetName, row,
              code: 'DATE_CORRUPTION_RECOVERED',
              message:
                `Cell held the date ${cell.v}; Excel converted the original entry. ` +
                `Recovered to blok ${parsed.blok} / crush ${parsed.crush}. Confirm.`,
            })
          }
          const sheetRm = num(ctx.sheet, row, c.amountCol) ?? undefined
          if (parsed.blok > 0) {
            out.outsideSales.push({
              saleDate: date, customer: c.customer, product: 'BIG_BLOCK',
              quantity: parsed.blok,
              note: parsed.recovered ? 'Recovered from a date-corrupted cell' : undefined,
            })
          }
          if (parsed.crush > 0) {
            out.outsideSales.push({
              saleDate: date, customer: c.customer, product: 'CRUSH',
              quantity: parsed.crush, sheetAmount: sheetRm,
              note: parsed.recovered ? 'Recovered from a date-corrupted cell' : undefined,
            })
          }
          continue
        }

        const q = num(ctx.sheet, row, c.quantityCol)
        if (q === null || q === 0) continue
        out.outsideSales.push({
          saleDate: date,
          customer: c.customer,
          // Sydney buys the 12.5 kg unit — a bag, despite the "block" label on
          // the price list. TCC and Burger buy 100 kg blocks. Owner-confirmed.
          product:
            c.customer === 'Sydney' ? 'BAG'
            : c.customer === 'TCC' || c.customer === 'Burger' ? 'BIG_BLOCK'
            : null,
          quantity: q,
          sheetUnitPrice: c.unitPrice ?? undefined,
          sheetAmount: num(ctx.sheet, row, c.amountCol) ?? undefined,
        })
      }
    }
  })
}



// ---------------------------------------------------------------------------
// E-2026 — the coldroom meter register. Ten sheets: dec25, jan..aug, plus a
// per-room 2025 summary the loader ignores.
//
// The trap here is `dec25`. Every other sheet runs
//   A room | B tenant | C current | D last | E usage | F rate | G use1 | H use2 | I amt
// but dec25 carries an extra "Inv No" column, shifting the meters to D/E and
// everything after it one to the right. A fixed column map would read December's
// tenant column as its meter and import nonsense. So every column here is found
// by its LABEL, per the rule in src/lib/import/layout.ts.
//
// A room code is NOT unique within a month: two physically different rooms are
// both labelled "D5" in every sheet, and a room whose tenant changes mid-month
// appears twice. Rows are therefore keyed by position, never by room code.
// ---------------------------------------------------------------------------

/** Column positions for one sheet, resolved from its own header labels. */
interface ColdroomCols {
  room: string
  tenant: string | null
  current: string
  last: string
  rate: string | null
  usage: string | null
  amount: string | null
  group1: string | null
  group2: string | null
  headerRow: number
}

const COL_ORDER = (() => {
  const out: string[] = []
  for (let i = 0; i < 26; i++) out.push(String.fromCharCode(65 + i))
  for (let i = 0; i < 26; i++)
    for (let j = 0; j < 26; j++)
      out.push(String.fromCharCode(65 + i) + String.fromCharCode(65 + j))
  return out
})()

/** First cell in the first `rows` rows whose text matches. */
function findLabel(
  sheet: Sheet,
  test: RegExp,
  rows = 6
): { row: number; col: string } | null {
  for (let r = 1; r <= rows; r++) {
    const row = sheet.cells[String(r)]
    if (!row) continue
    for (const col of Object.keys(row).sort((a, b) => COL_ORDER.indexOf(a) - COL_ORDER.indexOf(b))) {
      const v = row[col].v
      if (typeof v === 'string' && test.test(v.trim())) return { row: r, col }
    }
  }
  return null
}

function coldroomColumns(sheet: Sheet): ColdroomCols | null {
  const current = findLabel(sheet, /^current\s*meter/i)
  const last = findLabel(sheet, /^last\s*meter/i)
  if (!current || !last) return null
  const roomHdr = findLabel(sheet, /^cold\s*room/i)
  return {
    room: roomHdr?.col ?? 'A',
    tenant: findLabel(sheet, /^tenants?\b/i)?.col ?? null,
    current: current.col,
    last: last.col,
    rate: findLabel(sheet, /^rate\b/i)?.col ?? null,
    usage: findLabel(sheet, /^total\s*usage/i)?.col ?? null,
    amount: findLabel(sheet, /^amt\b/i)?.col ?? null,
    group1: findLabel(sheet, /^usage\s*1$/i)?.col ?? null,
    group2: findLabel(sheet, /^usage\s*2$/i)?.col ?? null,
    headerRow: Math.max(current.row, last.row),
  }
}

/**
 * Whether a register row is KFI's own consumption rather than a tenant's.
 *
 * Exported and named because it is the single rule that decides whether a
 * roomful of electricity is cost of ice or a recharge — and because it is a
 * DEPARTURE from the source workbook, not a reading of it.
 *
 * The workbook decides own use by LOT CODE. Every sheet carries a "Less : Own
 * Use" footer labelled LOT D10 / LOT D11 / LOT D12, resolved positionally. That
 * works until a room changes hands: in March 2026 the cell labelled "LOT D12"
 * points at the Zaidah Ibrahim row (1,653 kWh) and the row whose tenant column
 * reads KFI (76 kWh) is referenced by nothing. The footer is hand-maintained —
 * December's has four lines, one for a room with no tenant and one mistyped
 * "LOT 11" — so pointing at the wrong row is a thing it can do.
 *
 * Asking who occupied the room agrees with that footer in eight of the nine
 * months on file and corrects it in the ninth. See docs §11.3.
 */
export const isOwnUseTenant = (label: string | null): boolean =>
  /^kfi\b/i.test((label ?? '').trim())

/**
 * The rooms the workbook's own-use footer names. Reported against, never relied
 * on: this is the convention the footer encodes, and the point of keeping it is
 * to be able to say where the convention and the occupant disagree.
 */
export const CONVENTIONAL_OWN_USE_ROOMS = ['D10', 'D11', 'D12']

export function parseColdroomMeter(wb: Workbook, defaultYear = 2026): ParseResult {
  return eachSheet(
    wb,
    defaultYear,
    (ctx) => {
      const out = ctx.out
      const cols = coldroomColumns(ctx.sheet)
      if (!cols) {
        ctx.issues.push({
          level: 'ERROR', workbook: wb.workbook, sheet: ctx.sheetName,
          code: 'COLDROOM_NO_HEADER',
          message:
            `Could not find "Current meter" and "Last meter" headers on sheet ` +
            `"${ctx.sheetName}". Columns are resolved by label, so the sheet ` +
            `cannot be read positionally as a fallback.`,
        })
        return
      }

      let rowNo = 0
      for (let r = cols.headerRow + 1; r <= ctx.sheet.maxRow; r++) {
        const code = str(ctx.sheet, r, cols.room)
        // The register runs A1..D12; anything longer is a footer label such as
        // "Less :  Own Use" or the ICPT history block at the foot of the sheet.
        if (!code || !/^[A-Za-z]{1,2}\d{1,2}$/.test(code)) continue

        const closing = num(ctx.sheet, r, cols.current)
        const opening = num(ctx.sheet, r, cols.last)
        if (closing === null || opening === null) continue

        const rate = cols.rate ? num(ctx.sheet, r, cols.rate) : null
        if (rate === null) {
          ctx.issues.push({
            level: 'ERROR', workbook: wb.workbook, sheet: ctx.sheetName, row: r,
            code: 'COLDROOM_NO_RATE',
            message: `Room ${code} has no rate. The row is skipped rather than ` +
              `costed at a guessed rate.`,
          })
          continue
        }

        if (closing < opening) {
          ctx.issues.push({
            level: 'ERROR', workbook: wb.workbook, sheet: ctx.sheetName, row: r,
            code: 'COLDROOM_NEGATIVE_USAGE',
            message:
              `Room ${code}: closing ${closing} is below opening ${opening}. A ` +
              `register rollover or a keying error — resolve it before loading.`,
          })
          continue
        }

        const tenant = cols.tenant ? str(ctx.sheet, r, cols.tenant) : null
        const ownUse = isOwnUseTenant(tenant)
        const group =
          cols.group1 && num(ctx.sheet, r, cols.group1) !== null ? 1
          : cols.group2 && num(ctx.sheet, r, cols.group2) !== null ? 2
          : null

        rowNo++
        out.coldroomReadings.push({
          periodMonth: ctx.month,
          rowNo,
          roomCode: code.toUpperCase(),
          tenantLabel: tenant,
          ownUse,
          openingKwh: opening,
          closingKwh: closing,
          rateRmPerKwh: rate,
          usageGroup: group,
          sheetUsage: cols.usage ? (num(ctx.sheet, r, cols.usage) ?? undefined) : undefined,
          sheetAmount: cols.amount ? (num(ctx.sheet, r, cols.amount) ?? undefined) : undefined,
        })

        // The sheet stores usage and amount as well as the two registers. They
        // are recomputed rather than read, so the stored pair is free evidence:
        // a disagreement means the sheet's own arithmetic has been overtyped.
        const usage = closing - opening
        const sheetUsage = cols.usage ? num(ctx.sheet, r, cols.usage) : null
        if (sheetUsage !== null && Math.abs(sheetUsage - usage) > 0.01) {
          ctx.issues.push({
            level: 'WARN', workbook: wb.workbook, sheet: ctx.sheetName, row: r,
            code: 'COLDROOM_USAGE_MISMATCH',
            message:
              `Room ${code}: sheet shows ${sheetUsage} kWh but the registers ` +
              `give ${usage}. The registers are loaded.`,
          })
        }
        const sheetAmount = cols.amount ? num(ctx.sheet, r, cols.amount) : null
        if (sheetAmount !== null && Math.abs(sheetAmount - usage * rate) > 0.01) {
          ctx.issues.push({
            level: 'WARN', workbook: wb.workbook, sheet: ctx.sheetName, row: r,
            code: 'COLDROOM_AMOUNT_MISMATCH',
            message:
              `Room ${code}: sheet shows RM${sheetAmount} but ${usage} x ` +
              `${rate} is RM${(usage * rate).toFixed(2)}.`,
          })
        }

        // Charging KFI's own rooms is a convention the office follows, not a
        // fact about who used them. Where the two part company, say so — this
        // is what the owner's cost template got wrong in March 2026.
        if (CONVENTIONAL_OWN_USE_ROOMS.includes(code.toUpperCase()) !== ownUse) {
          ctx.issues.push({
            level: 'INFO', workbook: wb.workbook, sheet: ctx.sheetName, row: r,
            code: 'COLDROOM_OWN_USE_DIVERGES',
            message:
              `Room ${code} is ${ownUse ? 'occupied by KFI but is not one of ' +
              'the conventional own-use rooms' : `one of KFI's own-use rooms but is let to ` +
              `"${tenant ?? 'nobody named'}"`}. ` +
              `${usage} kWh follows the occupant, not the room code.`,
          })
        }
      }

      if (!rowNo) {
        ctx.issues.push({
          level: 'WARN', workbook: wb.workbook, sheet: ctx.sheetName,
          code: 'COLDROOM_NO_ROWS',
          message: `No register rows found on sheet "${ctx.sheetName}".`,
        })
      }
    },
    // The `ave` sheet is a per-room annual summary of the same readings. Loading
    // it would double-count, exactly as the master workbook would.
    (name) => /^ave/i.test(name.trim())
  )
}

export const PARSERS: Record<string, (wb: Workbook, y?: number) => ParseResult> = {
  'meter-tube': parseTube,
  'meter-big-pool': parseBigPool,
  'meter-small-pool': parseSmallPool,
  'daily-cash-ice': parseCash,
  'ice-purchase': parseIcePurchase,
  'coldroom-meter': parseColdroomMeter,
}
