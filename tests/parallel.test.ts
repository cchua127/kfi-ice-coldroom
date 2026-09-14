import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { findSheet, compareMaster, LEGACY, readWorkbook, type SystemDay } from '@/lib/parallel'
import { d } from '@/lib/money'

/** A minimal Daily Rekod Ais sheet: day 1 only, in the real column positions. */
async function sheetWith(name: string, row: Record<number, number>) {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet(name)
  for (let r = 1; r <= 5; r++) ws.addRow([])
  const cells: (number | null)[] = []
  for (let c = 1; c <= 15; c++) cells.push(row[c] ?? null)
  ws.addRow(cells)
  return wb
}

const systemDay = (over: Partial<SystemDay> = {}): SystemDay => ({
  day: 1,
  cash: d('5195.20'), outsideSales: d('1147.40'),
  totalKg: d('27025'), tubeKg: d('5225'),
  bigPoolPlusBimcKg: d('21800'), smallPoolKg: null,
  tubeKwh: d('710'), bigPoolKwh: d('1300'),
  ...over,
})

/** Day 1 September 2026 as the master sheet actually holds it. */
const SEPT_DAY_1 = {
  1: 1, 2: 5195.2, 3: 1147.4, 5: 27025, 6: 1348,
  10: 5225, 11: 21800, 12: 0, 13: 344, 14: 1004, 15: 0,
}

describe('finding the month in a dirty workbook', () => {
  it.each([
    ['aug ', '2026-08'],   // trailing space
    ['mac', '2026-03'],    // Mac for March
    ['sept', '2026-09'],
    ['dec25', '2025-12'],
    ['july', '2026-07'],
  ])('matches sheet %s to %s', async (name, month) => {
    const wb = await sheetWith(name, {})
    expect(findSheet(wb, month)?.name).toBe(name)
  })

  it('prefers sept over sep when a workbook holds both', async () => {
    const wb = new ExcelJS.Workbook()
    wb.addWorksheet('sep')
    wb.addWorksheet('sept')
    expect(findSheet(wb, '2026-09')?.name).toBe('sept')
  })

  it('says which sheets it found when none resolves', async () => {
    const wb = await sheetWith('summary', {})
    const r = compareMaster(wb, '2026-08', [])
    expect(r.diffs).toEqual([])
    expect(r.notes[0]).toMatch(/No sheet .* resolves to 2026-08/)
    expect(r.notes[0]).toMatch(/"summary"/)
  })
})

describe('comparing a clean day', () => {
  it('agrees on every field when the two sides match', async () => {
    const wb = await sheetWith('sept', SEPT_DAY_1)
    const r = compareMaster(wb, '2026-09', [systemDay()])
    expect(r.differed).toBe(0)
    expect(r.missing).toBe(0)
    expect(r.matched).toBeGreaterThan(6)
  })

  it('maps the lumped Big Pool column onto both lines', async () => {
    // The legacy column holds big pool and the China machine added together;
    // comparing it against big pool alone would show a difference every day.
    const wb = await sheetWith('sept', SEPT_DAY_1)
    const r = compareMaster(wb, '2026-09', [systemDay()])
    const row = r.diffs.find((x) => x.field === 'Big pool + BIMC kg')!
    expect(row.sheet).toBe(21800)
    expect(row.verdict).toBe('MATCH')
    expect(row.derivation).toMatch(/both lines added together/)
  })

  it('recovers consumption by inverting the legacy formula', async () => {
    // The sheet never stored kWh — its "kWh" columns hold ringgit at a frozen
    // tariff — so the only way to check a meter reading is to invert that.
    const wb = await sheetWith('sept', SEPT_DAY_1)
    const r = compareMaster(wb, '2026-09', [systemDay()])

    const tube = r.diffs.find((x) => x.field === 'Tube kWh')!
    expect(tube.sheet).toBeCloseTo(344 / 0.484, 1) // 710.74 against a true 710
    expect(tube.verdict).toBe('MATCH')
    expect(tube.derivation).toMatch(/frozen 0.484/)

    const big = r.diffs.find((x) => x.field === 'Big pool kWh')!
    expect(big.sheet).toBeCloseTo(1004 / (0.484 * 1.2) - 429, 1)
    expect(big.verdict).toBe('MATCH')
    expect(big.derivation).toMatch(/429 kWh booking/)
  })

  it('keeps the legacy constants named rather than inline', () => {
    expect(LEGACY.tariffRmPerKwh.toString()).toBe('0.484')
    expect(LEGACY.bigPoolKwhBooking.toString()).toBe('429')
    expect(LEGACY.bigPoolLoader.toString()).toBe('1.2')
  })
})

describe('reporting a real difference', () => {
  it('flags a figure that genuinely disagrees', async () => {
    const wb = await sheetWith('sept', { ...SEPT_DAY_1, 3: 1291.7 })
    const r = compareMaster(wb, '2026-09', [systemDay()])
    const row = r.diffs.find((x) => x.field === 'Sales outside')!
    expect(row.verdict).toBe('DIFFERS')
    expect(row.difference).toBeCloseTo(144.3, 1)
  })

  it('treats a sheet zero against no row here as agreement', async () => {
    // The small pool stopped in January. Reporting "0 against nothing" on every
    // idle line every day would bury the differences that matter.
    const wb = await sheetWith('sept', SEPT_DAY_1)
    const r = compareMaster(wb, '2026-09', [systemDay({ smallPoolKg: null })])
    expect(r.diffs.find((x) => x.field === 'Small pool kg')?.verdict).toBe('MATCH')
  })

  it('reports a day the system has but the sheet does not', async () => {
    const wb = await sheetWith('sept', { ...SEPT_DAY_1, 2: 0, 5: 0, 10: 0, 11: 0 })
    const r = compareMaster(wb, '2026-09', [systemDay()])
    expect(r.differed).toBeGreaterThan(0)
  })
})

describe('what is deliberately not compared', () => {
  it('explains each excluded column rather than silently skipping it', async () => {
    const wb = await sheetWith('sept', SEPT_DAY_1)
    const r = compareMaster(wb, '2026-09', [systemDay()])
    expect(r.excluded.length).toBe(3)
    expect(r.excluded.map((e) => e.reason).join(' ')).toMatch(/ringgit at the frozen 0.484/)
    expect(r.excluded.map((e) => e.reason).join(' ')).toMatch(/hardcoded 13/)
  })
})

describe('legacy file formats', () => {
  it('returns null for a workbook it cannot read, rather than throwing', async () => {
    expect(await readWorkbook(Buffer.from('not a workbook'))).toBeNull()
  })
})
