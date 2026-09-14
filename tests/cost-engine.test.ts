import { describe, it, expect } from 'vitest'
import bills from './fixtures/tnb-bills.json'
import production from './fixtures/monthly-production.json'
import {
  buildDailyRateSeries,
  forecastSiteRate,
  meteredKwh,
  rolloverKwh,
  modelledKwh,
  siteBridge,
  costOfIce,
  lineIntensity,
  iceKgOn,
  monthlyRatio,
  meanOverDaysWithData,
  type BillPeriod,
} from '@/lib/cost-engine'
import { d } from '@/lib/money'

const BIMC_KWH_PER_BLOCK = '5.0'

const asPeriods = (confirmed = true): BillPeriod[] =>
  bills.map((b) => ({
    accountNo: b.accountNo,
    periodStart: b.periodStart,
    periodEnd: b.periodEnd,
    kwh: b.kwh,
    currentChargesRm: b.currentChargesRm,
    confirmed,
  }))

describe('line energy', () => {
  it('meters a line as closing less prior reading', () => {
    // Tube, 1 September 2026: 2,137,640 - 2,136,930 = 710 kWh.
    const l = meteredKwh('TUBE', 2137640, 2136930)
    expect(l.kwh.toString()).toBe('710')
    expect(l.source).toBe('METERED')
  })

  it('refuses a closing below the prior reading instead of carrying a negative', () => {
    // The legacy sheets produced P21 = -2,151,320 exactly this way.
    expect(() => meteredKwh('TUBE', 0, 2151320)).toThrow(/below the prior reading/)
  })

  it('applies a register rollover only when told to', () => {
    const l = rolloverKwh('TUBE', 90, 9999950, 7)
    expect(l.kwh.toString()).toBe('140')
    expect(l.basis).toMatch(/rollover/)
  })

  it('labels a modelled line so it cannot pass for a measured one', () => {
    const l = modelledKwh('BIMC', 200, BIMC_KWH_PER_BLOCK, 'kWh/block')
    expect(l.kwh.toString()).toBe('1000')
    expect(l.source).toBe('MODELLED')
    expect(l.basis).toBe('5 kWh/block')
  })
})

describe('cost of ice, computed as a sum of lines', () => {
  // These are the figures the rebuilt engine must produce, derived from the
  // meter books. They are deliberately NOT the RM0.0617-0.0699/kg band in the
  // build spec: that band comes from sheet R5, whose stated method is
  // (Total TNB - coldroom - water) / produced kg — a residual that charges every
  // unaccounted kWh to ice, which is the practice the site bridge forbids.
  const EXPECTED: Record<string, { kwhPerKg: string; rmPerKg: string; rate: string }> = {
    '2026-01': { kwhPerKg: '0.1177', rmPerKg: '0.0570', rate: '0.484' },
    '2026-02': { kwhPerKg: '0.1176', rmPerKg: '0.0569', rate: '0.484' },
    '2026-03': { kwhPerKg: '0.1146', rmPerKg: '0.0555', rate: '0.484' },
    '2026-04': { kwhPerKg: '0.1155', rmPerKg: '0.0559', rate: '0.484' },
    // May differs from the workbook's own total: row 36 (31 May) books 200 BIMC
    // blocks but its kg cell holds no formula at all, so the sheet reports zero
    // kg for that day and understates the month by 9,000 kg. Deriving kg from
    // blocks x the dated unit weight, as the importer does, is what fixes it.
    '2026-05': { kwhPerKg: '0.1164', rmPerKg: '0.0563', rate: '0.484' },
    '2026-06': { kwhPerKg: '0.1160', rmPerKg: '0.0604', rate: '0.52071' },
  }

  it('rejects the workbook kg column for BIMC where its formula is missing', () => {
    const may = production.find((x) => x.month === '2026-05')!
    // 5,800 blocks x 45 kg = 261,000, but the sheet's own column totals 252,000.
    expect(d(may.bimcBlocks).times(45).toNumber()).toBe(261000)
    expect(Number(may.bimcKg)).toBe(252000)
  })

  it.each(production)('$month ties to the meter books', (p) => {
    const want = EXPECTED[p.month]
    const lines = [
      meteredKwh('TUBE', p.tubeKwh, 0),
      meteredKwh('BIG_POOL', p.bigPoolKwh, 0),
      modelledKwh('BIMC', p.bimcBlocks, BIMC_KWH_PER_BLOCK, 'kWh/block'),
    ]
    // BIMC kg comes from the block count and the dated unit weight, never from
    // the workbook's kg column — see the May note above.
    const producedKg = d(p.tubeKg).plus(p.bigPoolKg).plus(d(p.bimcBlocks).times(45))
    const cost = costOfIce(lines, { producedKg }, want.rate)

    expect(cost.kwhPerKg.toFixed(4)).toBe(want.kwhPerKg)
    expect(cost.rmPerKg.toFixed(4)).toBe(want.rmPerKg)
    expect(cost.hasModelledLines).toBe(true)
  })

  it('lands well below the R5 residual band, which is the point of the rebuild', () => {
    const p = production.find((x) => x.month === '2026-06')!
    const lines = [
      meteredKwh('TUBE', p.tubeKwh, 0),
      meteredKwh('BIG_POOL', p.bigPoolKwh, 0),
      modelledKwh('BIMC', p.bimcBlocks, BIMC_KWH_PER_BLOCK, 'kWh/block'),
    ]
    const producedKg = d(p.tubeKg).plus(p.bigPoolKg).plus(d(p.bimcBlocks).times(45))
    const cost = costOfIce(lines, { producedKg }, '0.52071')
    // R5 "2026 restated" reports 0.0699 for June.
    expect(cost.rmPerKg.lessThan('0.0699')).toBe(true)
    const gap = d('0.0699').minus(cost.rmPerKg).dividedBy('0.0699').times(100)
    expect(gap.toNumber()).toBeGreaterThan(10)
  })
})

describe('per-line intensity', () => {
  const p = production.find((x) => x.month === '2026-06')!

  it('matches the independent tube figure in report R6', () => {
    // R6 reports 0.1355 kWh/kg for June from the same daily meter book.
    const i = lineIntensity(meteredKwh('TUBE', p.tubeKwh, 0), p.tubeKg, '0.52071')
    expect(i.kwhPerKg.toFixed(4)).toBe('0.1355')
    expect(i.source).toBe('METERED')
  })

  it('reports big pool against its own tonnage, not the lumped legacy figure', () => {
    const separated = lineIntensity(
      meteredKwh('BIG_POOL', p.bigPoolKwh, 0),
      p.bigPoolKg,
      '0.52071'
    )
    const lumped = lineIntensity(
      meteredKwh('BIG_POOL', p.bigPoolKwh, 0),
      p.legacyLumpedKg,
      '0.52071'
    )
    // The spec's 0.060 target is the lumped ratio: metered energy that excludes
    // BIMC over a tonnage that includes it.
    expect(lumped.kwhPerKg.toFixed(3)).toBe('0.060')
    expect(separated.kwhPerKg.toFixed(3)).toBe('0.106')
  })
})

describe('kg basis', () => {
  // FOC ran 25.6% of blocks moved in H1 2026, so the basis is not cosmetic.
  const input = { producedKg: 27600, focKg: 6272, unaccountedKg: 3130 }

  it('separates produced, moved and sold', () => {
    expect(iceKgOn('PRODUCED', input).toString()).toBe('27600')
    expect(iceKgOn('MOVED', input).toString()).toBe('24470')
    expect(iceKgOn('SOLD', input).toString()).toBe('18198')
  })

  it('changes cost per kg materially between bases', () => {
    const lines = [modelledKwh('BIMC', 27600 / 45, BIMC_KWH_PER_BLOCK, 'kWh/block')]
    const produced = costOfIce(lines, input, '0.52071', 'PRODUCED')
    const sold = costOfIce(lines, input, '0.52071', 'SOLD')
    expect(sold.rmPerKg.greaterThan(produced.rmPerKg)).toBe(true)
    expect(sold.basis).toBe('SOLD')
  })
})

describe('site bridge', () => {
  it('reports the residual as itself and never folds it into ice', () => {
    const lines = [
      meteredKwh('TUBE', 34680, 0),
      meteredKwh('BIG_POOL', 37360, 0),
      modelledKwh('BIMC', 6000, BIMC_KWH_PER_BLOCK, 'kWh/block'),
      modelledKwh('OFFICE', 30, 36, 'kWh/day'),
      modelledKwh('CRUSHER', 30, 10, 'kWh/day'),
    ]
    const b = siteBridge(181336, lines, '0.52071')

    const iceKwh = costOfIce(lines.slice(0, 3), { producedKg: 1 }, '0.52071').iceKwh
    expect(b.accountedKwh.greaterThan(iceKwh)).toBe(true)
    expect(b.unaccountedKwh.plus(b.accountedKwh).toString()).toBe('181336')
    expect(b.unaccountedShare.times(100).toNumber()).toBeGreaterThan(20)
    expect(b.unaccountedRm.greaterThan(0)).toBe(true)
  })
})

describe('daily rate series', () => {
  const publishedAfa = { '2026-09-01': '0.0367' }

  it('marks a day FINAL only when every account has a confirmed bill', () => {
    const series = buildDailyRateSeries('2026-06-01', '2026-06-30', {
      bills: asPeriods(true),
    })
    expect(series).toHaveLength(30)
    expect(series.every((r) => r.status === 'FINAL')).toBe(true)
    expect(series[0].ratePerKwh.toString()).toBe('0.52071')
    expect(series[0].basis).toBe('CONFIRMED_BILL')
  })

  it('leaves a day provisional when only one account is confirmed', () => {
    const periods = asPeriods(true).map((p) =>
      p.accountNo === '220278867506' ? { ...p, confirmed: false } : p
    )
    const series = buildDailyRateSeries('2026-06-01', '2026-06-05', { bills: periods })
    expect(series.every((r) => r.status === 'PROVISIONAL')).toBe(true)
  })

  it('forecasts September from the published AFA rather than carrying August', () => {
    const series = buildDailyRateSeries('2026-09-01', '2026-09-14', {
      bills: asPeriods(true),
      publishedAfa,
      estimatedKwhPerAccount: ['69507', '125536'],
    })
    expect(series.every((r) => r.status === 'PROVISIONAL')).toBe(true)
    expect(series.every((r) => r.basis === 'AFA_FORECAST')).toBe(true)
    expect(series[0].note).toMatch(/bill not yet received/)
    const rate = series[0].ratePerKwh.toNumber()
    expect(rate).toBeGreaterThan(0.53)
    expect(rate).toBeLessThan(0.535)
  })

  it('carries the last confirmed rate when no AFA is published either', () => {
    const series = buildDailyRateSeries('2026-09-01', '2026-09-03', {
      bills: asPeriods(true),
    })
    expect(series[0].basis).toBe('CARRIED_FORWARD')
    expect(series[0].ratePerKwh.toString()).toBe('0.53279') // August's site rate
  })

  it('flips provisional days to final once the bill is confirmed', () => {
    const before = buildDailyRateSeries('2026-08-01', '2026-08-31', {
      bills: asPeriods(false),
    })
    const after = buildDailyRateSeries('2026-08-01', '2026-08-31', {
      bills: asPeriods(true),
    })
    expect(before.every((r) => r.status === 'PROVISIONAL')).toBe(true)
    expect(after.every((r) => r.status === 'FINAL')).toBe(true)
  })
})

describe('forecast rate', () => {
  it('is barely sensitive to the volume estimate', () => {
    const a = forecastSiteRate('0.0367', ['69507', '125536'])
    const b = forecastSiteRate('0.0367', ['83408', '150643']) // 20% higher
    expect(a.minus(b).abs().lessThan('0.0005')).toBe(true)
  })
})

describe('ratios', () => {
  it('computes a monthly ratio from monthly totals, never from daily ratios', () => {
    // The legacy master summed its ratio columns: SUM(H6:H37) returned 0.6718,
    // which is 13 ratios added together and means nothing.
    const daily = [
      { kwh: 710, kg: 5225 },
      { kwh: 720, kg: 5675 },
      { kwh: 980, kg: 7250 },
    ]
    const summedRatios = daily.reduce((a, x) => a + x.kwh / x.kg, 0)
    const proper = monthlyRatio(
      daily.reduce((a, x) => a + x.kwh, 0),
      daily.reduce((a, x) => a + x.kg, 0)
    )
    expect(summedRatios).toBeGreaterThan(0.3)
    expect(proper.toNumber()).toBeLessThan(0.2)
  })

  it('averages over days that actually have data, not a hardcoded divisor', () => {
    // The legacy sheet divided by 13 and had to be edited by hand every day.
    const values = [5195.2, 5939.6, 6418]
    expect(meanOverDaysWithData(values).toFixed(2)).toBe('5850.93')
  })
})
