import { describe, it, expect } from 'vitest'
import icePurchase from './fixtures/import/ice-purchase.json'
import tube from './fixtures/import/meter-tube.json'
import bigPool from './fixtures/import/meter-big-pool.json'
import smallPool from './fixtures/import/meter-small-pool.json'
import cash from './fixtures/import/daily-cash-ice.json'
import { parseSheetName, resolveSheet } from '@/lib/import/sheet-names'
import {
  findMonthMarker, mapCustomerColumns, parseMonthLabel,
  parseUnitPriceLabel, canonicalCustomer, unknownCustomerLabels,
} from '@/lib/import/layout'
import {
  parseTube, parseBigPool, parseSmallPool, parseCash, parseIcePurchase,
  parseGoodTaste, reverseGoodTasteDate,
} from '@/lib/import/parsers'
import type { Workbook } from '@/lib/import/extract-types'

const wb = (x: unknown) => x as unknown as Workbook

describe('dirty sheet names', () => {
  // Every one of these is a real name from the source workbooks.
  it.each([
    ['sept', 9, null, false],
    ['aug ', 8, null, false],   // trailing space
    ['mac', 3, null, false],    // Mac = March in Bahasa Malaysia
    ['july', 7, null, false],
    ['apr1', 4, null, false],   // sheet-copy suffix, not a year
    ['dec25', 12, 25, false],   // year suffix
    ['jan-baris', 1, null, true],
    ['dec-baris ', 12, null, true],
  ])('reads %s', (name, month, year2, isLedger) => {
    const p = parseSheetName(name)
    expect(p.month).toBe(month)
    expect(p.year2).toBe(year2)
    expect(p.isBarisLedger).toBe(isLedger)
  })

  it('does not mistake the copy suffix in apr1 for a year', () => {
    expect(parseSheetName('apr1').year2).toBeNull()
  })

  it('prefers sept over sep when both would match', () => {
    expect(parseSheetName('sept').month).toBe(9)
  })
})

describe('resolving a sheet to a month', () => {
  it('lets the sheet its own month cell win over the name', () => {
    const r = resolveSheet('oct', { monthCellIso: '2025-10-01', defaultYear: 2026 })
    expect(r.month).toBe('2025-10')
    expect(r.source).toBe('CELL')
  })

  it('notes, but does not fail, a year-less name losing to its cell', () => {
    // The real case: ice-purchase `oct` and `nov` are Oct'25 and Nov'25. Name
    // inference alone would put them a full year out.
    const r = resolveSheet('oct', { monthCellIso: '2025-10-01', defaultYear: 2026 })
    expect(r.conflict).toBeUndefined()
    expect(r.note).toMatch(/carries no year/)
  })

  it('raises a real conflict when the name states a year and disagrees', () => {
    const r = resolveSheet('dec25', { monthCellIso: '2024-12-01', defaultYear: 2026 })
    expect(r.conflict).toMatch(/states 2025-12.*cell says 2024-12/)
  })

  it('falls back to the name when there is no cell at all', () => {
    const r = resolveSheet('may', { defaultYear: 2026 })
    expect(r.month).toBe('2026-05')
    expect(r.source).toBe('NAME')
  })
})

describe('month markers that move', () => {
  it.each([
    ["Sept'26", '2026-09-01'],
    ["Oct'25", '2025-10-01'],
    ["Dec'25", '2025-12-01'],
    ["Jan'26", '2026-01-01'],
  ])('parses %s', (text, iso) => expect(parseMonthLabel(text)).toBe(iso))

  it('finds the marker wherever the column shift put it', () => {
    // N2 on a 35-column sheet, T2 on the 41-column October one.
    expect(findMonthMarker(wb(icePurchase).sheets['jan'])).toBe('2026-01-01')
    expect(findMonthMarker(wb(icePurchase).sheets['oct'])).toBe('2025-10-01')
    expect(findMonthMarker(wb(icePurchase).sheets['nov'])).toBe('2025-11-01')
  })
})

describe('customer columns move between months', () => {
  const at = (sheet: string, customer: string) =>
    mapCustomerColumns(wb(icePurchase).sheets[sheet]).find((c) => c.customer === customer)

  it('tracks Good Taste as new customers push it rightwards', () => {
    expect(at('jan', 'Good Taste')?.quantityCol).toBe('J')
    expect(at('sept', 'Good Taste')?.quantityCol).toBe('J')
    expect(at('nov', 'Good Taste')?.quantityCol).toBe('N')
    expect(at('oct', 'Good Taste')?.quantityCol).toBe('P')
  })

  it('reads the dated unit price out of the header text', () => {
    // The price rise landed in JUNE 2026, not January: Sydney 3.00 -> 3.30,
    // TCC 19.00 -> 21.00, Burger 24.00 -> 26.00. Report R3 sees the same thing
    // in the cash data ("+9.4% vs Apr - June price rise realized"), and it is
    // why the build spec lists Good Taste at "RM 3.00 / 3.30" — those are the
    // old and new prices, not two products.
    expect(at('dec', 'Sydney')?.unitPrice).toBe(3.0)
    expect(at('jan', 'Sydney')?.unitPrice).toBe(3.0)
    expect(at('sept', 'Sydney')?.unitPrice).toBe(3.3)
    expect(at('jan', 'TCC')?.unitPrice).toBe(19.0)
    expect(at('sept', 'TCC')?.unitPrice).toBe(21.0)
  })

  it('puts Ocean Ice quantity after its DO number column', () => {
    const ocean = at('jan', 'Ocean Ice')
    expect(ocean?.quantityCol).toBe('D')
    expect(ocean?.unitPrice).toBe(15)
  })

  it('takes only the first occurrence of a repeated name', () => {
    // These sheets repeat TCC and The Wet World further right as working
    // columns; counting them again would double the revenue.
    const tcc = mapCustomerColumns(wb(icePurchase).sheets['jan']).filter(
      (c) => c.customer === 'TCC'
    )
    expect(tcc).toHaveLength(1)
    expect(tcc[0].quantityCol).toBe('H')
  })

  it.each([['Wai Mah (tube/crush)', 'Wai Mah'], ['Snow Theme Park', 'Snow Theme Park'],
           ['The Wet World ', 'The Wet World'], ['Hypecircus ', 'Hypecircus']])(
    'recognises %s, which is not in the build spec', (label, canonical) => {
      expect(canonicalCustomer(label)).toBe(canonical)
    })

  it('does not report working columns as unknown customers', () => {
    const unknown = unknownCustomerLabels(wb(icePurchase).sheets['jan'])
    expect(unknown).not.toContain('KFI')
    expect(unknown).not.toContain('dif')
    expect(unknown).not.toContain('crush')
  })

  it.each([['3.30/unit ', 3.3], ['21.00/unit ', 21], ['15/unit', 15], ['RM', null]])(
    'reads price label %s', (text, expected) =>
      expect(parseUnitPriceLabel(text)).toBe(expected))
})

describe('Good Taste quantities', () => {
  it.each([
    ['7/55', 7, 55],
    ['8.5/68', 8.5, 68],
    ['6.5/55', 6.5, 55],
  ])('parses %s', (text, blok, crush) => {
    expect(parseGoodTaste(text, false)).toEqual({ blok, crush, recovered: false })
  })

  it('reverses the cell Excel turned into a date', () => {
    // "7/57" was read as July 1957 and stored as 1957-07-01. Month back to
    // blok, two-digit year back to crush.
    expect(reverseGoodTasteDate('1957-07-01')).toEqual({ blok: 7, crush: 57 })
    expect(parseGoodTaste('1957-07-01', true)).toEqual({ blok: 7, crush: 57, recovered: true })
  })

  it('refuses a date that is not a day-one conversion artefact', () => {
    expect(reverseGoodTasteDate('1957-07-15')).toBeNull()
  })

  it('recovers the corrupted September row and flags it for confirmation', () => {
    const r = parseIcePurchase(wb(icePurchase))
    const issue = r.issues.find((i) => i.code === 'DATE_CORRUPTION_RECOVERED')
    expect(issue?.sheet).toBe('sept')
    expect(issue?.message).toMatch(/blok 7 \/ crush 57/)
    const sales = r.outsideSales.filter(
      (s) => s.saleDate === '2026-09-08' && s.customer === 'Good Taste'
    )
    expect(sales.map((s) => [s.product, s.quantity])).toEqual([
      ['BIG_BLOCK', 7], ['CRUSH', 57],
    ])
  })
})

describe('meter books', () => {
  it('reads the tube closing and production for 1 September', () => {
    const r = parseTube(wb(tube))
    const reading = r.meterReadings.find((m) => m.readingDate === '2026-09-01')
    expect(reading).toEqual({ meterCode: 'TUBE', readingDate: '2026-09-01', closing: 2137640 })
    const prod = r.production.filter((p) => p.prodDate === '2026-09-01')
    expect(prod).toEqual([
      { line: 'TUBE', prodDate: '2026-09-01', unitCode: 'BAG', quantity: 58 },
      { line: 'TUBE', prodDate: '2026-09-01', unitCode: 'TONG', quantity: 45 },
    ])
  })

  it('takes Excel\'s evaluated value for an in-cell sum like 27+30', () => {
    // Row 12 holds `=27+30` for bags and `=5+88` for tong.
    const r = parseTube(wb(tube))
    const prod = r.production.filter((p) => p.prodDate === '2026-09-05')
    expect(prod.find((p) => p.unitCode === 'BAG')?.quantity).toBe(57)
    expect(prod.find((p) => p.unitCode === 'TONG')?.quantity).toBe(93)
  })

  it('skips an unfilled row rather than carrying a negative', () => {
    // Row 21 has a Mula but no Akhir; the legacy sheet computed -2,151,320.
    const r = parseTube(wb(tube))
    expect(r.meterReadings.some((m) => m.readingDate === '2026-09-14')).toBe(false)
    expect(r.meterReadings.every((m) => m.closing > 0)).toBe(true)
  })

  it('captures the first row\'s Mula so the earliest day is not lost', () => {
    // Without this the very first day of the series has no opening and its
    // consumption vanishes. On the tube meter that is 1 January 2026 — 10 kWh,
    // which report R6 independently records as an idle day.
    const r = parseTube(wb(tube))
    const derived = r.meterReadings.find((m) => m.fromOpening)
    expect(derived).toMatchObject({
      meterCode: 'TUBE', readingDate: '2026-08-31', closing: 2136930,
    })
  })

  it('does not let an opening-derived reading displace a real closing', () => {
    const r = parseTube(wb(tube))
    const derivedDates = r.meterReadings.filter((m) => m.fromOpening).map((m) => m.readingDate)
    const realDates = r.meterReadings.filter((m) => !m.fromOpening).map((m) => m.readingDate)
    for (const d of derivedDates) expect(realDates).not.toContain(d)
  })

  it('separates big pool baris from the BIMC count, and marks BIMC a convention', () => {
    const r = parseBigPool(wb(bigPool))
    const day1 = r.production.filter((p) => p.prodDate === '2026-09-01')
    const bp = day1.find((p) => p.line === 'BIG_POOL')
    const bimc = day1.find((p) => p.line === 'BIMC')
    expect(bp).toMatchObject({ unitCode: 'BARIS', quantity: 16, tongKosong: 0 })
    expect(bimc).toMatchObject({ unitCode: 'SMALL_TONG', quantity: 200, quantitySource: 'CONVENTION' })
    expect(r.issues.some((i) => i.code === 'BIMC_FLAT_CONVENTION')).toBe(true)
  })

  it('reads small pool FOC from the ledger sheet', () => {
    // The two rows per date are BIG and SMALL block types, not two shifts.
    const r = parseSmallPool(wb(smallPool))
    const day1 = r.production.filter((p) => p.prodDate === '2026-01-01')
    const small = day1.find((p) => p.unitCode === 'SMALL_TONG')
    expect(small).toMatchObject({ line: 'SMALL_POOL', quantity: 138, focQuantity: 49 })
    const big = day1.find((p) => p.unitCode === 'BLOK')
    expect(big).toMatchObject({ quantity: 8, focQuantity: 0 })
  })
})

describe('cash book', () => {
  it('reads both shifts and ignores the excluded columns', () => {
    const r = parseCash(wb(cash))
    const day1 = r.cash.find((c) => c.saleDate === '2026-09-01')
    expect(day1).toEqual({ saleDate: '2026-09-01', shift1: 2616.2, shift2: 2579 })
    // Pro Sheet Rpt (3531.2) and Fatman (1664) must appear nowhere.
    const values = r.cash.flatMap((c) => [c.shift1, c.shift2])
    expect(values).not.toContain(1664)
  })

  it('resolves apr1 despite the sheet-copy suffix', () => {
    const r = parseCash(wb(cash))
    expect(r.resolved.find((s) => s.sheetName === 'apr1')?.month).toBe('2026-04')
  })
})

describe('the master workbook is not a source', () => {
  it('has no parser, because importing it would double-count', async () => {
    const { PARSERS } = await import('@/lib/import/parsers')
    expect(Object.keys(PARSERS)).not.toContain('daily-rekod-ais')
  })
})
