/**
 * The behaviours the owner's template cannot exercise, because it has no
 * sub-meter readings, no uncosted days and no way to be partly filled in.
 *
 * tests/workbook-template.test.ts proves the arithmetic agrees with the sheet.
 * This proves the things that go wrong when the sheet's happy path does not
 * hold — which is most months, in practice.
 */
import { describe, it, expect } from 'vitest'
import { d } from '@/lib/money'
import { Assumptions } from '@/lib/domain'
import {
  coldroomSplit,
  waterKwh,
  flatDailyKwh,
  spreadOverDays,
  siteStatement,
  DEFAULT_COUNTS_AS_ICE,
} from '@/lib/site-energy'
import { recomputeEnergyUses, summariseMonths, type DailyLineCostRow } from '@/lib/cost-recompute'
import type { DailyRate } from '@/lib/cost-engine'
import { monthCloseChecks, closeable, countBy } from '@/lib/checks'
import { channelMargin, pasarKg, sellableKg, machineEfficiency, focWatch } from '@/lib/analytics'

const assumptions = new Assumptions([
  { key: 'brine_compressor_kwh_per_day', effectiveFrom: '2026-01-01', value: '340' },
  { key: 'office_cctv_kwh_per_day', effectiveFrom: '2026-01-01', value: '36' },
  { key: 'crusher_kwh_per_day', effectiveFrom: '2026-01-01', value: '10' },
  { key: 'water_kwh_per_tonne', effectiveFrom: '2026-01-01', value: '0.65' },
  { key: 'water_ice_feed_kwh_per_tonne', effectiveFrom: '2026-01-01', value: '0.45' },
  { key: 'coldroom_legacy_factor_rm_per_kwh', effectiveFrom: '2026-01-01', value: '0.484' },
  { key: 'tenant_billing_rate_rm_per_kwh', effectiveFrom: '2026-01-01', value: '0.543' },
])

const rate = (date: string, basis: DailyRate['basis'] = 'CONFIRMED_BILL'): DailyRate => ({
  date,
  ratePerKwh: basis === 'NO_RATE' ? d(0) : d('0.52071'),
  status: basis === 'CONFIRMED_BILL' ? 'FINAL' : 'PROVISIONAL',
  basis,
})

const junRates = Array.from({ length: 30 }, (_, i) =>
  rate(`2026-06-${String(i + 1).padStart(2, '0')}`)
)

describe('the coldroom, measured or recovered', () => {
  it('prefers the sub-meter, and says the number was measured', () => {
    const split = coldroomSplit(
      { meteredKwh: '50000', ratonoRm: '16782.70', yemintRm: '9013.05', iceStoreInvoicedRm: '3153.75' },
      '0.484',
      '0.543'
    )
    expect(split.totalKwh.toString()).toBe('50000')
    expect(split.source).toBe('METERED')
    expect(split.backInferred).toBe(false)
    expect(split.totalBasis).toBe('coldroom sub-meter')
    // The ringgit compilations are ignored entirely for the total — a reading
    // that exists must never be blended with a rate-derived estimate.
    expect(split.totalKwh.toNumber()).not.toBeCloseTo(53297, 0)
  })

  it('still splits D10-D12 out by invoice when the room is metered', () => {
    const split = coldroomSplit({ meteredKwh: '50000', iceStoreInvoicedRm: '5430' }, '0.484', '0.543')
    expect(split.iceStoreKwh.toString()).toBe('10000')
    expect(split.tenantKwh.toString()).toBe('40000')
  })

  it('brands the back-inferred path loudly enough to reach a report', () => {
    const split = coldroomSplit({ ratonoRm: '1000', yemintRm: '0' }, '0.484', '0.543')
    expect(split.backInferred).toBe(true)
    expect(split.totalBasis).toContain('BACK-INFERRED')
    expect(split.totalBasis).toContain('0.4840')
    expect(split.totalBasis).toContain('no sub-meter reading on file')
  })

  it('never returns a negative tenant figure when D10-D12 exceeds the total', () => {
    // A keying error, not a physical possibility. Clamped rather than
    // propagated: a negative kWh line would read as generation.
    const split = coldroomSplit({ meteredKwh: '100', iceStoreInvoicedRm: '5430' }, '0.484', '0.543')
    expect(split.tenantKwh.toString()).toBe('0')
  })

  it('refuses to divide by a zero rate rather than returning infinity', () => {
    expect(() => coldroomSplit({ ratonoRm: '1000' }, '0', '0.543')).toThrow(/non-zero/)
    expect(() => coldroomSplit({ ratonoRm: '1000' }, '0.484', '0')).toThrow(/non-zero/)
  })
})

describe('water, at two intensities', () => {
  it('separates delivered water from the water that becomes ice', () => {
    const [delivered, feed] = waterKwh(
      { tonnes: '1000', retailM3: '200', iceKg: '500000' },
      '0.65',
      '0.45'
    )
    expect(delivered.kwh.toString()).toBe('780')
    expect(feed.kwh.toString()).toBe('225')
  })

  it('treats a cubic metre as a tonne, and says so in the basis', () => {
    const [delivered] = waterKwh({ tonnes: '0', retailM3: '100' }, '0.65', '0.45')
    expect(delivered.kwh.toString()).toBe('65')
    expect(delivered.basis).toContain('100.00 t')
  })
})

describe('spreading a monthly figure over days', () => {
  it('sums back to the monthly figure exactly, remainder and all', () => {
    const spread = spreadOverDays('1000', ['2026-06-01', '2026-06-02', '2026-06-03'])
    const total = [...spread.values()].reduce((a, v) => a.plus(v), d(0))
    expect(total.toString()).toBe('1000')
    // 333.33 + 333.33 + 333.34 — the remainder lands on the last day rather
    // than being dropped.
    expect(spread.get('2026-06-03')!.toString()).toBe('333.34')
  })

  it('returns nothing for an empty range rather than dividing by zero', () => {
    expect(spreadOverDays('1000', []).size).toBe(0)
  })
})

describe('the site statement', () => {
  const statement = () =>
    siteStatement({
      billedKwh: '100000',
      billedRm: '52071',
      productionLines: [
        { code: 'TUBE', label: 'Tube', kwh: '30000', source: 'METERED', basis: 'sub-meter' },
        { code: 'BIG_POOL', label: 'Big pool', kwh: '35000', source: 'METERED', basis: 'sub-meter' },
      ],
      energyUses: [
        { useCode: 'BRINE_COMPRESSOR', kwh: d('10200'), kwhSource: 'MODELLED', basis: '340 kWh/day' },
        { useCode: 'COLDROOM_TENANT', kwh: d('15000'), kwhSource: 'MODELLED', basis: 'back-inferred' },
      ],
    })

  it('reports the residual as a line of its own and never folds it into ice', () => {
    const s = statement()
    expect(s.accountedKwh.toString()).toBe('90200')
    expect(s.unallocatedKwh.toString()).toBe('9800')
    // Ice is tube + pool + compressor. The residual is nowhere in it.
    expect(s.iceKwh.toString()).toBe('75200')
    expect(s.lines.some((l) => l.key === 'unallocated')).toBe(false)
  })

  it('counts the compressor as ice and the tenant coldroom as not', () => {
    const byKey = Object.fromEntries(statement().lines.map((l) => [l.key, l]))
    expect(byKey.BRINE_COMPRESSOR.countsAsIce).toBe(true)
    expect(byKey.COLDROOM_TENANT.countsAsIce).toBe(false)
  })

  it('lets the owner’s convention override the seeded default', () => {
    // Ice-feed water is ON by default now (owner decision, docs §10.3). The
    // override has to work in BOTH directions, so this turns it off — that is
    // the direction the workbook-template test depends on.
    const s = siteStatement({
      billedKwh: '100000',
      billedRm: '52071',
      productionLines: [],
      energyUses: [
        { useCode: 'WATER_ICE_FEED', kwh: d('400'), kwhSource: 'MODELLED', basis: 'feed' },
      ],
      countsAsIce: { WATER_ICE_FEED: false },
    })
    expect(DEFAULT_COUNTS_AS_ICE.WATER_ICE_FEED).toBe(true)
    expect(s.iceKwh.toString()).toBe('0')
  })

  it('ties to the bill in kWh exactly, and in ringgit to within rounding', () => {
    const s = statement()
    expect(s.tieOutKwh.toString()).toBe('0')
    expect(Math.abs(s.unexplainedRm.toNumber())).toBeLessThan(0.05)
  })

  it('survives a month with no bill without dividing by zero', () => {
    const s = siteStatement({
      billedKwh: '0',
      billedRm: '0',
      productionLines: [{ code: 'TUBE', label: 'Tube', kwh: '30000', source: 'METERED', basis: 'm' }],
      energyUses: [],
    })
    expect(s.ratePerKwh.toString()).toBe('0')
    expect(s.lines[0].share).toBeNull()
    expect(s.unallocatedKwh.toString()).toBe('-30000')
  })
})

describe('recomputing the non-production consumers', () => {
  const lineCosts: DailyLineCostRow[] = [
    {
      costDate: '2026-06-01',
      line: 'TUBE',
      kwh: d('1000'),
      kwhSource: 'METERED',
      kg: d('8000'),
      focKg: d('0'),
      ratePerKwh: d('0.52071'),
      costRm: d('520.71'),
      status: 'FINAL',
      rateBasis: 'CONFIRMED_BILL',
      rateAvailable: true,
      spansDays: 1,
      fromConvention: false,
    },
  ]

  it('charges the standing loads on every day in the range', () => {
    const rows = recomputeEnergyUses({
      from: '2026-06-01',
      to: '2026-06-30',
      rates: junRates,
      assumptions,
      lineCosts,
      uses: ['BRINE_COMPRESSOR'],
    })
    expect(rows).toHaveLength(30)
    expect(rows[0].kwh.toString()).toBe('340')
    expect(rows[0].basis).toContain('standing load')
  })

  it('strikes ice-feed water against the ice each day actually made', () => {
    const rows = recomputeEnergyUses({
      from: '2026-06-01',
      to: '2026-06-30',
      rates: junRates,
      assumptions,
      lineCosts,
      uses: ['WATER_ICE_FEED'],
    })
    // One production day, so one row — not a month-long smear.
    expect(rows).toHaveLength(1)
    expect(rows[0].costDate).toBe('2026-06-01')
    expect(rows[0].kwh.toString()).toBe('3.6') // 8 t x 0.45
  })

  it('spreads the coldroom month and sums back to the month’s total', () => {
    const rows = recomputeEnergyUses({
      from: '2026-06-01',
      to: '2026-06-30',
      rates: junRates,
      assumptions,
      lineCosts,
      coldroom: [{ month: '2026-06', ratonoRm: '14025.84', yemintRm: '12611.10', iceStoreInvoicedRm: '3153.75' }],
      uses: ['COLDROOM_TENANT', 'COLDROOM_ICE_STORE'],
    })
    const tenant = rows.filter((r) => r.useCode === 'COLDROOM_TENANT')
    expect(tenant).toHaveLength(30)
    const total = tenant.reduce((a, r) => a.plus(r.kwh), d(0))
    // 55,035 total less 5,808.01 for D10-D12.
    expect(total.toNumber()).toBeCloseTo(49226.99, 1)
    expect(tenant[0].basis).toContain('spread evenly over 30 day(s)')
  })

  it('records an uncosted day rather than pricing it at zero', () => {
    const rows = recomputeEnergyUses({
      from: '2026-06-01',
      to: '2026-06-01',
      rates: [rate('2026-06-01', 'NO_RATE')],
      assumptions,
      lineCosts: [],
      uses: ['OFFICE_CCTV'],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].kwh.toString()).toBe('36')
    expect(rows[0].rateAvailable).toBe(false)
    expect(rows[0].rateBasis).toBe('NO_RATE')
    expect(rows[0].costRm.toString()).toBe('0')
  })

  it('emits nothing for a day with no rate series entry at all', () => {
    const rows = recomputeEnergyUses({
      from: '2026-06-01',
      to: '2026-06-30',
      rates: [rate('2026-06-01')],
      assumptions,
      lineCosts: [],
      uses: ['CRUSHER'],
    })
    expect(rows).toHaveLength(1)
  })
})

describe('cost of ice now carries its support plant', () => {
  const lineCosts: DailyLineCostRow[] = [
    {
      costDate: '2026-06-01',
      line: 'TUBE',
      kwh: d('1000'),
      kwhSource: 'METERED',
      kg: d('8000'),
      focKg: d('0'),
      ratePerKwh: d('0.5'),
      costRm: d('500'),
      status: 'FINAL',
      rateBasis: 'CONFIRMED_BILL',
      rateAvailable: true,
      spansDays: 1,
      fromConvention: false,
    },
  ]

  it('adds the compressor and D10-D12, and leaves the tenant coldroom out', () => {
    const energyUses = recomputeEnergyUses({
      from: '2026-06-01',
      to: '2026-06-01',
      rates: [rate('2026-06-01')],
      assumptions,
      lineCosts,
      coldroom: [{ month: '2026-06', ratonoRm: '4840', yemintRm: '0', iceStoreInvoicedRm: '543' }],
    })

    const withSupport = summariseMonths(lineCosts, { energyUses })[0]
    const without = summariseMonths(lineCosts)[0]

    // 340 compressor + 1,000 D10-D12 + 3.6 ice-feed water, and nothing from
    // the 9,000 tenant kWh.
    expect(withSupport.supportKwh.toString()).toBe('1343.6')
    expect(withSupport.iceKwh.toString()).toBe('2343.6')
    expect(without.iceKwh.toString()).toBe('1000')
    expect(withSupport.rmPerKg!.greaterThan(without.rmPerKg!)).toBe(true)
  })

  it('honours a countsAsIce override rather than hardcoding the convention', () => {
    const energyUses = recomputeEnergyUses({
      from: '2026-06-01',
      to: '2026-06-01',
      rates: [rate('2026-06-01')],
      assumptions,
      lineCosts,
      uses: ['WATER_ICE_FEED'],
    })
    const on = summariseMonths(lineCosts, { energyUses })[0]
    const off = summariseMonths(lineCosts, { energyUses, countsAsIce: { WATER_ICE_FEED: false } })[0]
    expect(on.supportKwh.toString()).toBe('3.6')
    expect(off.supportKwh.toString()).toBe('0')
  })
})

describe('the demand side', () => {
  it('derives pasar kilograms by difference, and never below zero', () => {
    expect(pasarKg('800000', '135000').toString()).toBe('665000')
    expect(pasarKg('100', '500').toString()).toBe('0')
  })

  it('counts bought-in ice as sellable and gives away FOC', () => {
    expect(sellableKg('900000', '50000', '10000').toString()).toBe('860000')
  })

  it('ranks channels on realised price against the electricity in a kilogram', () => {
    const summary = channelMargin(
      [
        { channel: 'Pasar', revenueRm: '178527.60', kg: '682340.5' },
        { channel: 'TCC', revenueRm: '8862', kg: '42200' },
        { channel: 'Crush', revenueRm: '3268.80', kg: null },
      ],
      '0.0699',
      '61468.74'
    )
    expect(summary.rows[0].realisedRmPerKg!.toFixed(4)).toBe('0.2616')
    expect(summary.rows[0].marginOverElectricity!.toFixed(4)).toBe('0.1917')
    // No kilograms means no realised price. Not a zero, not an estimate.
    expect(summary.rows[2].realisedRmPerKg).toBeNull()
    expect(summary.rows[2].marginOverElectricity).toBeNull()
    expect(summary.electricityShareOfSales!.toFixed(4)).toBe('0.3224')
  })

  it('returns no cost comparison at all when the month has no rate', () => {
    const summary = channelMargin([{ channel: 'Pasar', revenueRm: '100', kg: '1000' }], null)
    expect(summary.rows[0].marginOverElectricity).toBeNull()
    expect(summary.electricityShareOfSales).toBeNull()
  })

  it('leaves the ledger gap null when nothing records what was sold', () => {
    const watch = focWatch({
      producedUnits: '6000',
      soldUnits: null,
      focUnits: '1433',
      kgPerUnit: '45',
      kwhPerUnit: '5',
      ratePerKwh: '0.52071',
    })
    expect(watch.ledgerGapUnits).toBeNull()
    expect(watch.focShareOfMoved).toBeNull()
    expect(watch.revenueForgoneRm).toBeNull()
    // The electricity in the giveaway does not need a sold count.
    expect(watch.electricityInFocRm.toString()).toBe('3730.89')
  })

  it('reports gross and net intensity without picking between them', () => {
    const eff = machineEfficiency(
      { line: 'BIMC', label: 'China', kwh: '30000', producedKg: '270000', focKg: '64485', kwhSource: 'MODELLED' },
      '0.52071'
    )
    expect(eff.kwhPerKg!.toFixed(6)).toBe('0.111111')
    expect(eff.netKwhPerKg!.toFixed(6)).toBe('0.145975')
    expect(eff.sellableKg.toString()).toBe('205515')
  })

  it('returns null rather than zero for a line that made nothing', () => {
    const eff = machineEfficiency(
      { line: 'TUBE', label: 'Tube', kwh: '1000', producedKg: '0', kwhSource: 'METERED' },
      '0.5'
    )
    expect(eff.kwhPerKg).toBeNull()
    expect(eff.rmPerKg).toBeNull()
  })
})

describe('the month-close checks', () => {
  const healthy = {
    month: '2026-06',
    daysInMonth: 30,
    unexplainedRm: '0.03',
    tieOutKwh: '0',
    unallocatedKwh: '2919.81',
    coldroomMarginRm: '1097.29',
    coldroomBackInferred: false,
    coldroomPresent: true,
    focShare: '0.10',
    ledgerGapUnits: '12',
    tubeKwhPerKg: '0.1355',
    poolKwhPerKg: '0.1344',
    ratePerKwh: '0.52071',
    priorRatePerKwh: '0.50860',
    counterCashRm: '1000',
    counterPricedRm: '1000',
    daysWithoutRate: 0,
  }

  it('passes a clean month', () => {
    const results = monthCloseChecks(healthy)
    expect(closeable(results)).toBe(true)
    expect(countBy(results, 'FLAG')).toBe(0)
  })

  it('refuses to call a missing figure a pass', () => {
    const results = monthCloseChecks({ month: '2026-09', daysInMonth: 30 })
    expect(closeable(results)).toBe(false)
    expect(countBy(results, 'OK')).toBe(0)
    expect(countBy(results, 'NO_DATA')).toBeGreaterThan(5)
    // The wording has to say what is missing, not just that something is.
    expect(results[0].detail).toContain('No confirmed TNB bill')
  })

  it('flags a back-inferred coldroom even when every figure looks fine', () => {
    const results = monthCloseChecks({ ...healthy, coldroomBackInferred: true })
    const check = results.find((r) => r.key === 'coldroom-source')!
    expect(check.verdict).toBe('FLAG')
    expect(check.detail).toContain('RM0.484/kWh')
    expect(closeable(results)).toBe(false)
  })

  it('reads a negative residual as over-modelling, not under-metering', () => {
    const results = monthCloseChecks({ ...healthy, unallocatedKwh: '-90000' })
    const check = results.find((r) => r.key === 'unallocated')!
    expect(check.verdict).toBe('FLAG')
    expect(check.detail).toContain('claim more than the bill')
  })

  it('flags the coldroom the month the tenant rate goes underwater', () => {
    const results = monthCloseChecks({ ...healthy, coldroomMarginRm: '-412.50' })
    const check = results.find((r) => r.key === 'coldroom-margin')!
    expect(check.verdict).toBe('FLAG')
    expect(check.detail).toContain('reprice')
  })

  it('separates a tariff move from a plant problem', () => {
    const results = monthCloseChecks({ ...healthy, ratePerKwh: '0.60', priorRatePerKwh: '0.50' })
    const check = results.find((r) => r.key === 'rate-jump')!
    expect(check.verdict).toBe('FLAG')
    expect(check.detail).toContain('not the plant')
  })

  it('flags an uncosted day rather than letting it pass as free electricity', () => {
    const results = monthCloseChecks({ ...healthy, daysWithoutRate: 3 })
    const check = results.find((r) => r.key === 'uncosted-days')!
    expect(check.verdict).toBe('FLAG')
    expect(check.detail).toContain('left uncosted rather than guessed')
  })

  it('takes an overridden threshold rather than burying it', () => {
    const tight = monthCloseChecks({ ...healthy, thresholds: { unallocatedKwhPerDay: 50 } })
    expect(tight.find((r) => r.key === 'unallocated')!.verdict).toBe('FLAG')
  })

  it('flags the FOC rate the template’s own months run at', () => {
    // January 2026 ran 19.8% of blocks moved; the threshold is 15%.
    const results = monthCloseChecks({ ...healthy, focShare: '0.198212' })
    const check = results.find((r) => r.key === 'foc-share')!
    expect(check.verdict).toBe('FLAG')
    expect(check.detail).toContain('19.8%')
  })
})
