import { describe, it, expect } from 'vitest'
import { recompute, summariseMonths } from '@/lib/cost-recompute'
import { buildDailyRateSeries, type BillPeriod } from '@/lib/cost-engine'
import { Assumptions, productionKg, asAt, type UnitRow } from '@/lib/domain'
import bills from './fixtures/tnb-bills.json'

const UNITS: UnitRow[] = [
  { line: 'TUBE', unitCode: 'BAG', kgPerUnit: '12.5', effectiveFrom: '2022-01-01' },
  { line: 'TUBE', unitCode: 'TONG', kgPerUnit: '100', effectiveFrom: '2022-01-01' },
  { line: 'BIG_POOL', unitCode: 'BLOK', kgPerUnit: '100', effectiveFrom: '2022-01-01' },
  { line: 'BIG_POOL', unitCode: 'BARIS', kgPerUnit: null, effectiveFrom: '2022-01-01' },
  { line: 'BIMC', unitCode: 'SMALL_TONG', kgPerUnit: '45', effectiveFrom: '2025-12-01' },
  { line: 'SMALL_POOL', unitCode: 'SMALL_TONG', kgPerUnit: '38', effectiveFrom: '2022-01-01' },
]

const ASSUMPTIONS = new Assumptions([
  { key: 'blocks_per_baris', effectiveFrom: '2022-01-01', value: '8', measured: true },
  { key: 'small_pool_blocks_per_baris', effectiveFrom: '2022-01-01', value: '23', measured: true },
  { key: 'bimc_kwh_per_block', effectiveFrom: '2025-10-01', value: '5.0' },
])

const periods = (confirmed = true): BillPeriod[] =>
  bills.map((b) => ({
    accountNo: b.accountNo, periodStart: b.periodStart, periodEnd: b.periodEnd,
    kwh: b.kwh, currentChargesRm: b.currentChargesRm, confirmed,
  }))

const ratesFor = (from: string, to: string, confirmed = true) =>
  buildDailyRateSeries(from, to, { bills: periods(confirmed) })

describe('dated lookups', () => {
  it('resolves a value as at a date, not as a current value', () => {
    const rows = [
      { effectiveFrom: '2025-10-01', value: '3.00' },
      { effectiveFrom: '2026-06-01', value: '3.30' },
    ]
    expect(asAt(rows, '2026-05-31')?.value).toBe('3.00')
    expect(asAt(rows, '2026-06-01')?.value).toBe('3.30')
    expect(asAt(rows, '2025-09-30')).toBeNull()
  })

  it('refuses to default a missing assumption to zero', () => {
    // A silent zero here would understate cost and look like a real number.
    expect(() => ASSUMPTIONS.at('bimc_kwh_per_block', '2025-01-01')).toThrow(
      /No value for cost assumption/
    )
  })

  it('derives big pool kg from baris less empty cans', () => {
    // 16 baris x 8 cans = 128 blocks, x 100 kg = 12,800 kg for 1 Sept 2026.
    const kg = productionKg(UNITS, ASSUMPTIONS, {
      line: 'BIG_POOL', unitCode: 'BARIS', quantity: 16, tongKosong: 0, prodDate: '2026-09-01',
    })
    expect(kg.toString()).toBe('12800')
  })

  it('subtracts tong kosong before converting to kg', () => {
    const kg = productionKg(UNITS, ASSUMPTIONS, {
      line: 'BIG_POOL', unitCode: 'BARIS', quantity: 19, tongKosong: 4, prodDate: '2026-09-03',
    })
    expect(kg.toString()).toBe('14800') // (19 x 8 - 4) x 100
  })

  it('uses the right small-block weight for each line', () => {
    const bimc = productionKg(UNITS, ASSUMPTIONS, {
      line: 'BIMC', unitCode: 'SMALL_TONG', quantity: 200, prodDate: '2026-09-01',
    })
    const pool = productionKg(UNITS, ASSUMPTIONS, {
      line: 'SMALL_POOL', unitCode: 'SMALL_TONG', quantity: 200, prodDate: '2026-01-01',
    })
    expect(bimc.toString()).toBe('9000') // 45 kg
    expect(pool.toString()).toBe('7600') // 38 kg
  })
})

describe('recompute', () => {
  const base = {
    from: '2026-06-01', to: '2026-06-02',
    units: UNITS, assumptions: ASSUMPTIONS,
    rates: ratesFor('2026-06-01', '2026-06-02'),
  }

  it('meters a line against the previous day and costs it at the site rate', () => {
    const rows = recompute({
      ...base,
      readings: [
        { meterCode: 'TUBE', readingDate: '2026-05-31', closing: 1000000 },
        { meterCode: 'TUBE', readingDate: '2026-06-01', closing: 1000710 },
      ],
      production: [
        { line: 'TUBE', unitCode: 'BAG', prodDate: '2026-06-01', quantity: 58 },
        { line: 'TUBE', unitCode: 'TONG', prodDate: '2026-06-01', quantity: 45 },
      ],
    })
    const tube = rows.find((r) => r.line === 'TUBE' && r.costDate === '2026-06-01')!
    expect(tube.kwh.toString()).toBe('710')
    expect(tube.kwhSource).toBe('METERED')
    expect(tube.kg.toString()).toBe('5225')
    expect(tube.ratePerKwh.toString()).toBe('0.52071')
    expect(tube.costRm.toFixed(2)).toBe('369.70')
    expect(tube.status).toBe('FINAL')
    expect(tube.rateBasis).toBe('CONFIRMED_BILL')
  })

  it('models BIMC from booked blocks and marks it MODELLED', () => {
    const rows = recompute({
      ...base,
      readings: [],
      production: [{
        line: 'BIMC', unitCode: 'SMALL_TONG', prodDate: '2026-06-01',
        quantity: 200, quantitySource: 'CONVENTION',
      }],
    })
    const bimc = rows.find((r) => r.line === 'BIMC')!
    expect(bimc.kwh.toString()).toBe('1000') // 200 x 5.0
    expect(bimc.kwhSource).toBe('MODELLED')
    expect(bimc.fromConvention).toBe(true)
  })

  it('flags a day that carries a multi-day meter delta', () => {
    // Entry was missed, so one reading covers three days. Reports show it
    // rather than quietly averaging it away.
    const rows = recompute({
      ...base, to: '2026-06-04',
      rates: ratesFor('2026-06-01', '2026-06-04'),
      readings: [
        { meterCode: 'TUBE', readingDate: '2026-06-01', closing: 1000000 },
        { meterCode: 'TUBE', readingDate: '2026-06-04', closing: 1002100 },
      ],
      production: [],
    })
    const row = rows.find((r) => r.costDate === '2026-06-04')!
    expect(row.kwh.toString()).toBe('2100')
    expect(row.spansDays).toBe(3)
  })

  it('ignores a negative delta rather than carrying it', () => {
    const rows = recompute({
      ...base,
      readings: [
        { meterCode: 'TUBE', readingDate: '2026-06-01', closing: 2151320 },
        { meterCode: 'TUBE', readingDate: '2026-06-02', closing: 0 },
      ],
      production: [],
    })
    expect(rows.filter((r) => r.line === 'TUBE')).toHaveLength(0)
  })

  it('converts FOC quantity into FOC kilograms', () => {
    const rows = recompute({
      ...base,
      readings: [],
      production: [{
        line: 'SMALL_POOL', unitCode: 'SMALL_TONG', prodDate: '2026-06-01',
        quantity: 138, focQuantity: 49,
      }],
    })
    const row = rows.find((r) => r.line === 'SMALL_POOL')!
    expect(row.kg.toString()).toBe('5244') // 138 x 38
    expect(row.focKg.toString()).toBe('1862') // 49 x 38
  })
})

describe('provisional and final', () => {
  const production = [{
    line: 'TUBE' as const, unitCode: 'BAG' as const, prodDate: '2026-06-01', quantity: 58,
  }]
  const readings = [
    { meterCode: 'TUBE', readingDate: '2026-05-31', closing: 1000000 },
    { meterCode: 'TUBE', readingDate: '2026-06-01', closing: 1000710 },
  ]

  it('is provisional while the bill is unconfirmed and final once it is', () => {
    const draft = recompute({
      from: '2026-06-01', to: '2026-06-01', units: UNITS, assumptions: ASSUMPTIONS,
      readings, production, rates: ratesFor('2026-06-01', '2026-06-01', false),
    })
    const confirmed = recompute({
      from: '2026-06-01', to: '2026-06-01', units: UNITS, assumptions: ASSUMPTIONS,
      readings, production, rates: ratesFor('2026-06-01', '2026-06-01', true),
    })
    expect(draft[0].status).toBe('PROVISIONAL')
    expect(confirmed[0].status).toBe('FINAL')
    // The whole point: confirming the bill restates the cost, not the operator.
    expect(confirmed[0].costRm.equals(draft[0].costRm)).toBe(false)
  })

  it('records consumption but no cost when there is nothing to cost with', () => {
    // December 2025 has no bill and no published AFA. A zero rate must not read
    // as "electricity was free that day".
    const rows = recompute({
      from: '2025-12-01', to: '2025-12-01', units: UNITS, assumptions: ASSUMPTIONS,
      readings: [
        { meterCode: 'TUBE', readingDate: '2025-11-30', closing: 900000 },
        { meterCode: 'TUBE', readingDate: '2025-12-01', closing: 900500 },
      ],
      production: [{ line: 'TUBE', unitCode: 'BAG', prodDate: '2025-12-01', quantity: 40 }],
      rates: buildDailyRateSeries('2025-12-01', '2025-12-01', { bills: periods(true) }),
    })
    expect(rows[0].kwh.toString()).toBe('500')
    expect(rows[0].rateBasis).toBe('NO_RATE')
    expect(rows[0].rateAvailable).toBe(false)
    expect(summariseMonths(rows)[0].rmPerKg).toBeNull()
    expect(summariseMonths(rows)[0].daysWithoutRate).toBe(1)
  })
})

describe('monthly summary', () => {
  it('divides by the days that have data, not a hardcoded number', () => {
    const rows = recompute({
      from: '2026-06-01', to: '2026-06-30', units: UNITS, assumptions: ASSUMPTIONS,
      rates: ratesFor('2026-06-01', '2026-06-30'),
      readings: [
        { meterCode: 'TUBE', readingDate: '2026-05-31', closing: 1000000 },
        { meterCode: 'TUBE', readingDate: '2026-06-01', closing: 1000710 },
        { meterCode: 'TUBE', readingDate: '2026-06-02', closing: 1001430 },
      ],
      production: [
        { line: 'TUBE', unitCode: 'TONG', prodDate: '2026-06-01', quantity: 45 },
        { line: 'TUBE', unitCode: 'TONG', prodDate: '2026-06-02', quantity: 50 },
      ],
    })
    const [june] = summariseMonths(rows)
    expect(june.daysWithData).toBe(2)
    // Ratio from monthly totals, never an average of daily ratios.
    expect(june.kwhPerKg.toFixed(4)).toBe(
      june.iceKwh.dividedBy(june.iceKg).toDecimalPlaces(4).toFixed(4)
    )
  })
})
