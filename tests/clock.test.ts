import { describe, expect, it } from 'vitest'
import { businessMonth, businessToday, formatStamp, shiftMonth } from '@/lib/clock'

/**
 * The plant runs at UTC+8 and the container runs at UTC. Every case below is
 * an instant where the two disagree — which is eight hours out of every
 * twenty-four, a window this plant staffs with a night shift.
 */
describe('businessToday', () => {
  it('is the plant date, not the UTC date, after 4pm UTC', () => {
    // 16:00Z on the 14th is already 00:00 on the 15th in Kuala Lumpur.
    const at = new Date('2026-09-14T16:00:00Z')
    expect(at.toISOString().slice(0, 10)).toBe('2026-09-14')
    expect(businessToday(at)).toBe('2026-09-15')
  })

  it('agrees with UTC for the rest of the day', () => {
    const at = new Date('2026-09-14T15:59:59Z')
    expect(businessToday(at)).toBe('2026-09-14')
  })

  it('rolls the month at the plant boundary', () => {
    // 30 June 16:30Z is 1 July at the plant. A report defaulting to "this
    // month" must open July.
    expect(businessMonth(new Date('2026-06-30T16:30:00Z'))).toBe('2026-07')
  })

  it('rolls the year at the plant boundary', () => {
    expect(businessToday(new Date('2026-12-31T17:00:00Z'))).toBe('2027-01-01')
  })

  it('a night-shift clerk keying at 1am gets that night, not the day before', () => {
    // 1am on 15 September in Kuala Lumpur is 17:00Z on the 14th.
    expect(businessToday(new Date('2026-09-14T17:00:00Z'))).toBe('2026-09-15')
  })
})

describe('shiftMonth', () => {
  it('steps back across a year boundary', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
  })
  it('steps forward across a year boundary', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
  })
  it('is a no-op at zero', () => {
    expect(shiftMonth('2026-06', 0)).toBe('2026-06')
  })
})

describe('formatStamp', () => {
  it('stamps a printed sheet in plant time', () => {
    // 16:00Z is midnight at the plant; a UTC stamp would print the 14th.
    const stamp = formatStamp('2026-09-14T16:00:00Z')
    expect(stamp).toMatch(/15 Sept? 2026/)
    expect(stamp).toContain('12:00 am')
  })
})
