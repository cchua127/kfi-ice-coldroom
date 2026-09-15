import { describe, it, expect } from 'vitest'
import {
  validateMeter, validateProduction, validateCash, validateSale,
  validateAgainstBill, hasBlocking, needsNote, trailingMean,
  validateColdroomMonth, validateWaterMonth,
} from '@/lib/validation'

const meter = (over: Partial<Parameters<typeof validateMeter>[0]> = {}) =>
  validateMeter({
    meterCode: 'TUBE', label: 'Tube', closing: 2137640, priorClosing: 2136930,
    priorDate: '2026-08-31', digits: 7, ...over,
  })

describe('meter readings', () => {
  it('accepts a normal day', () => {
    expect(meter()).toEqual([])
  })

  it('blocks a closing below the previous reading', () => {
    // The legacy sheets turned exactly this into -2,151,320.
    const issues = meter({ closing: 0 })
    expect(hasBlocking(issues)).toBe(true)
    expect(issues[0].message).toMatch(/below the previous reading/)
  })

  it('allows it once a rollover is confirmed', () => {
    const issues = meter({ closing: 90, priorClosing: 9999950, rolloverConfirmed: true })
    expect(hasBlocking(issues)).toBe(false)
  })

  it('rejects a rollover confirmed on what is really a keying slip', () => {
    // 500 down to 400 is not a register going all the way round; treating it as
    // one would book 9,999,900 kWh in a day.
    const issues = meter({ closing: 400, priorClosing: 500, rolloverConfirmed: true })
    expect(hasBlocking(issues)).toBe(true)
    expect(issues[0].message).toMatch(/not plausible/)
  })

  it('warns, without blocking, on a day more than 40% off the recent mean', () => {
    const issues = meter({ closing: 2138930, trailingMean: 700 }) // 2,000 kWh
    expect(hasBlocking(issues)).toBe(false)
    expect(needsNote(issues)).toBe(true)
    expect(issues[0].message).toMatch(/above the recent daily average/)
  })

  it('stays quiet inside the 40% band', () => {
    expect(meter({ closing: 2137830, trailingMean: 700 })).toEqual([]) // 900 kWh
  })

  it('explains rather than blocks when there is no earlier reading', () => {
    const issues = meter({ priorClosing: null })
    expect(hasBlocking(issues)).toBe(false)
    expect(issues[0].message).toMatch(/will resolve once the previous day is entered/)
  })
})

describe('production', () => {
  const baris = (qty: number, kosong: number) =>
    validateProduction({
      line: 'BIG_POOL', label: 'Baris', unitCode: 'BARIS',
      quantity: qty, tongKosong: kosong, blocksPerBaris: 8,
    })

  it('accepts empty cans up to the cans actually filled', () => {
    expect(baris(19, 4)).toEqual([])
    expect(baris(2, 16)).toEqual([])
  })

  it('blocks more empty cans than were filled', () => {
    const issues = baris(2, 17)
    expect(hasBlocking(issues)).toBe(true)
    expect(issues[0].message).toMatch(/cannot exceed what was filled/)
  })

  it('blocks FOC greater than production', () => {
    const issues = validateProduction({
      line: 'SMALL_POOL', label: 'Small tong', unitCode: 'SMALL_TONG',
      quantity: 138, focQuantity: 200,
    })
    expect(hasBlocking(issues)).toBe(true)
  })

  it('blocks negative quantities', () => {
    expect(hasBlocking(validateProduction({
      line: 'TUBE', label: 'Bag', unitCode: 'BAG', quantity: -1,
    }))).toBe(true)
  })
})

describe('cash', () => {
  it('accepts a normal day', () => {
    expect(validateCash({ shift1: 2616.2, shift2: 2579 })).toEqual([])
  })

  it('warns on a zero day that is not a holiday, without blocking', () => {
    const issues = validateCash({ shift1: 0, shift2: 0 })
    expect(hasBlocking(issues)).toBe(false)
    expect(needsNote(issues)).toBe(true)
  })

  it('stays quiet on a holiday', () => {
    expect(validateCash({ shift1: 0, shift2: 0, isHoliday: true })).toEqual([])
  })
})

describe('outside sales', () => {
  it('ignores a row that has not been started', () => {
    expect(validateSale({ index: 0, customer: null, product: null, quantity: null, unitPrice: null }))
      .toEqual([])
  })

  it('requires customer, product and quantity once a row is started', () => {
    const issues = validateSale({ index: 0, customer: 'Sydney', product: null, quantity: null, unitPrice: null })
    expect(issues.map((i) => i.message)).toEqual(['Choose a product.', 'Enter a quantity.'])
  })
})

describe('against the bill', () => {
  it('blocks sub-meter consumption above the billed site total', () => {
    // The sub-meters are a subset of the site by construction, so this can only
    // be a keying error.
    expect(hasBlocking(validateAgainstBill(200000, 181336))).toBe(true)
  })

  it('accepts the normal case, where the site is much larger', () => {
    expect(validateAgainstBill(102040, 181336)).toEqual([])
  })
})

describe('trailing mean', () => {
  it('divides by the values that exist, not a fixed window', () => {
    expect(trailingMean([700, 800, 900])?.toString()).toBe('800')
  })

  it('uses only the most recent window', () => {
    expect(trailingMean([1, 1, 1, 1, 1, 1, 1, 700, 800], 2)?.toString()).toBe('750')
  })

  it('returns null with nothing to average', () => {
    expect(trailingMean([])).toBeNull()
  })
})

describe('the coldroom month', () => {
  const base = { legacyFactor: '0.484', tenantRate: '0.543' }
  const run = (over: Partial<Parameters<typeof validateColdroomMonth>[0]>) =>
    validateColdroomMonth({
      meteredKwh: null, ratonoRm: null, yemintRm: null, iceStoreInvoicedRm: null,
      ...base, ...over,
    })

  it('treats a blank meter reading and a zero as different things', () => {
    // Blank means "not read" and sends the month down the back-inference path.
    const blank = run({ ratonoRm: '14025.84', yemintRm: '12611.10' })
    expect(blank.filter((i) => i.severity === 'ERROR')).toHaveLength(0)
    expect(blank.find((i) => i.field === 'coldroom.meteredKwh')?.message).toMatch(/BACK-INFERRED/)

    // Zero claims the rooms drew nothing, which for -18C storage is not a
    // thing that happens, and would be treated downstream as a measurement.
    const zero = run({ meteredKwh: '0' })
    expect(zero.some((i) => i.severity === 'ERROR')).toBe(true)
    expect(zero[0].message).toMatch(/Leave the field BLANK/)
  })

  it('accepts a metered month without warning about the stale factor', () => {
    expect(run({ meteredKwh: '55035', iceStoreInvoicedRm: '3153.75' })).toHaveLength(0)
  })

  it('catches D10-D12 larger than the whole-room meter', () => {
    const issues = run({ meteredKwh: '1000', iceStoreInvoicedRm: '5430' })
    expect(issues.some((i) => i.severity === 'ERROR')).toBe(true)
    expect(issues[0].message).toMatch(/more than the/)
  })

  it('refuses an invoiced ice store with nothing to subtract it from', () => {
    const issues = run({ iceStoreInvoicedRm: '3153.75' })
    expect(issues.some((i) => i.severity === 'ERROR')).toBe(true)
    expect(issues[0].message).toMatch(/come out negative/)
  })

  it('warns, without blocking, when the month is left empty', () => {
    const issues = run({})
    expect(hasBlocking(issues)).toBe(false)
    expect(issues[0].message).toMatch(/unaccounted residual/)
  })

  it('rejects negatives on every figure', () => {
    for (const field of ['ratonoRm', 'yemintRm', 'iceStoreInvoicedRm'] as const) {
      expect(run({ [field]: '-1' }).some((i) => i.severity === 'ERROR')).toBe(true)
    }
  })
})

describe('the water month', () => {
  it('questions a large step against last month without blocking it', () => {
    const issues = validateWaterMonth({ tonnes: '18000', retailM3: '2450', priorTonnes: '11958' })
    expect(hasBlocking(issues)).toBe(false)
    expect(issues[0].message).toMatch(/51% away/)
  })

  it('passes a normal month quietly', () => {
    expect(
      validateWaterMonth({ tonnes: '11958', retailM3: '2450', priorTonnes: '11687' })
    ).toHaveLength(0)
  })

  it('does not compare against a month that has no figure', () => {
    expect(
      validateWaterMonth({ tonnes: '11958', retailM3: '2450', priorTonnes: null })
    ).toHaveLength(0)
  })

  it('rejects a negative delivery', () => {
    expect(
      validateWaterMonth({ tonnes: '-1', retailM3: null }).some((i) => i.severity === 'ERROR')
    ).toBe(true)
  })
})
