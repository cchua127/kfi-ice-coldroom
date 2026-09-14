import { describe, it, expect } from 'vitest'
import fixtures from './fixtures/tnb-bills.json'
import { reconstructBill, siteRate, basePerKwh, RATE_CARD_2025_07 } from '@/lib/tariff'
import { validateParsedBill, hasBlockingFinding } from '@/lib/bill-validation'
import { d } from '@/lib/money'

// Fixtures are extracted directly from the six bill PDFs on file, not typed by
// hand. If TNB changes a rate or a layout, these are what will catch it.
type Fixture = (typeof fixtures)[number]

describe('rate card', () => {
  it('sums the non-AFA per-kWh components to 0.4868', () => {
    expect(basePerKwh().toString()).toBe('0.4868')
  })

  it('prices the retail charge flat, not per kWh', () => {
    expect(RATE_CARD_2025_07.retailFlat.toString()).toBe('20')
  })
})

describe.each(fixtures as Fixture[])(
  'bill $accountNo $periodStart',
  (f) => {
    const built = reconstructBill({
      kwh: f.kwh,
      afaRatePerKwh: f.afaRatePerKwh,
      previousBalanceRm: f.previousBalanceRm,
      roundingRm: f.roundingRm,
    })

    // Each printed component individually — a break tells you which line moved.
    it('reproduces Tenaga', () => expect(built.energyRm.toFixed(2)).toBe(f.energyRm))
    it('reproduces AFA', () => expect(built.afaRm.toFixed(2)).toBe(f.afaRm))
    it('reproduces Kapasiti', () => expect(built.capacityRm.toFixed(2)).toBe(f.capacityRm))
    it('reproduces Caj Rangkaian', () => expect(built.networkRm.toFixed(2)).toBe(f.networkRm))
    it('reproduces Caj Peruncitan', () => expect(built.retailRm.toFixed(2)).toBe(f.retailRm))
    it('reproduces Rebat', () => expect(built.rebateRm.toFixed(2)).toBe(f.rebateRm))

    it('reproduces Caj Penggunaan Bulan Semasa', () =>
      expect(built.currentUsageRm.toFixed(2)).toBe(f.currentUsageRm))

    // The subtle one: 1.6% on a base that excludes AFA and the RM20 retail charge.
    it('reproduces KWTBB on the correct base', () =>
      expect(built.kwtbbRm.toFixed(2)).toBe(f.kwtbbRm))

    it('reproduces Caj Semasa', () =>
      expect(built.currentChargesRm.toFixed(2)).toBe(f.currentChargesRm))

    it('reproduces Jumlah Bil after rounding', () =>
      expect(built.totalRm.toFixed(2)).toBe(f.totalRm))

    it('sums the kWh meter rows to billed consumption', () => {
      const kwhRows = f.meterReadings.filter((r) => r.unit === 'kWh')
      expect(kwhRows.length).toBe(2)
      const summed = kwhRows.reduce((a, r) => a.plus(d(r.usage)), d(0))
      expect(summed.toString()).toBe(d(f.kwh).toString())
    })

    it('passes validation with no blocking finding', () => {
      const findings = validateParsedBill(
        { ...f, accountNo: f.accountNo } as never,
        { knownAccountNos: ['220275147610', '220278867506'] }
      )
      expect(findings.filter((x) => x.severity === 'ERROR')).toEqual([])
      expect(hasBlockingFinding(findings)).toBe(false)
    })
  }
)

describe('site rate', () => {
  const byPeriod = (start: string) =>
    (fixtures as Fixture[])
      .filter((f) => f.periodStart === start)
      .map((f) => ({ kwh: f.kwh, currentChargesRm: f.currentChargesRm }))

  // Costing uses the site rate because the lines are not cleanly separable by
  // account. These are the figures the build spec quotes.
  it.each([
    ['2026-06-01', '0.52071'],
    ['2026-07-01', '0.53071'],
    ['2026-08-01', '0.53279'],
  ])('blends both accounts for %s to %s RM/kWh', (start, expected) => {
    const bills = byPeriod(start)
    expect(bills.length).toBe(2)
    expect(siteRate(bills).toString()).toBe(expected)
  })

  it('is materially above the retired 0.484 frozen rate', () => {
    const aug = siteRate(byPeriod('2026-08-01'))
    const understatement = aug.dividedBy('0.484').minus(1).times(100)
    expect(understatement.toNumber()).toBeGreaterThan(10)
  })
})

describe('validation', () => {
  const base = fixtures[0] as Fixture
  const ctx = { knownAccountNos: ['220275147610', '220278867506'] }

  it('rejects an unknown account', () => {
    const f = validateParsedBill({ ...base, accountNo: '999' } as never, ctx)
    expect(f.some((x) => x.code === 'UNKNOWN_ACCOUNT')).toBe(true)
  })

  it('flags a changed unit rate as a suspected tariff revision, not a new number', () => {
    const f = validateParsedBill({ ...base, energyRate: '0.2800' } as never, ctx)
    const hit = f.find((x) => x.code === 'TARIFF_REVISION_SUSPECTED')
    expect(hit?.expected).toBe('0.2703')
    expect(hit?.severity).toBe('ERROR')
  })

  it('reports a reconstruction break as a field-level diff in sen', () => {
    const f = validateParsedBill({ ...base, kwtbbRm: '999.99' } as never, ctx)
    const hit = f.find((x) => x.code === 'RECONSTRUCTION_BREAK' && x.field === 'kwtbbRm')
    expect(hit).toBeDefined()
    expect(hit?.expected).toBe('531.25')
  })

  it('catches a period that overlaps a confirmed bill', () => {
    const f = validateParsedBill(base as never, {
      ...ctx,
      priorBills: [{ periodStart: '2026-05-15', periodEnd: '2026-06-14', kwh: '68000' }],
    })
    expect(f.some((x) => x.code === 'PERIOD_OVERLAP')).toBe(true)
  })

  it('warns, with a note required, when consumption jumps more than 15%', () => {
    const f = validateParsedBill(base as never, {
      ...ctx,
      priorBills: [{ periodStart: '2026-05-01', periodEnd: '2026-05-31', kwh: '40000' }],
    })
    const hit = f.find((x) => x.code === 'KWH_JUMP')
    expect(hit?.severity).toBe('WARN')
    expect(hit?.requiresNote).toBe(true)
  })

  it('does not alert on max demand or declared load — they carry no charge here', () => {
    const f = validateParsedBill(
      { ...base, maxDemandKw: '375', declaredKw: '80.5' } as never,
      ctx
    )
    expect(f.some((x) => /DEMAND|DECLARED/i.test(x.code))).toBe(false)
  })
})

describe('negative AFA', () => {
  // January 2026 billed -4.99 sen/kWh. No PDF on file yet, so this proves the
  // sign handling arithmetically until one arrives.
  it('treats a negative AFA as a rebate and lowers the KWTBB base accordingly', () => {
    const built = reconstructBill({ kwh: 68207, afaRatePerKwh: '-0.0499' })
    expect(built.afaRm.isNegative()).toBe(true)
    expect(built.afaRm.toFixed(2)).toBe('-3403.53')
    // Base excludes AFA, so removing a negative AFA raises it above usage.
    expect(built.kwtbbBaseRm.greaterThan(built.currentUsageRm)).toBe(true)
    expect(built.totalRm.lessThan(d('32000'))).toBe(true)
  })
})
