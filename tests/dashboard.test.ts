/**
 * The dashboard's coldroom banner.
 *
 * It says, in one line, which of the three sources this month's coldroom
 * figures rest on — and it has to say the same thing `coldroomSplit()` would.
 * Twice it did not: once reporting the coldroom absent from a month that was
 * fully keyed, and once reporting a register-backed month as back-inferred.
 * Both times the banner enumerated fewer sources than the engine ranks.
 */
import { describe, it, expect } from 'vitest'
import { coldroomBridgeState } from '@/lib/dashboard'

const state = (register: boolean, wholeMeter: boolean, ringgit: boolean) =>
  coldroomBridgeState({ register, wholeMeter, ringgit })

describe('which source backs the coldroom this month', () => {
  it('names the register first, as coldroomSplit() does', () => {
    expect(state(true, false, false)).toBe('REGISTER')
    expect(state(true, true, true)).toBe('REGISTER')
  })

  it('falls to the whole-meter total when there is no register', () => {
    expect(state(false, true, false)).toBe('WHOLE_METER')
    expect(state(false, true, true)).toBe('WHOLE_METER')
  })

  it('only calls it back-inferred when the ringgit is all there is', () => {
    expect(state(false, false, true)).toBe('BACK_INFERRED')
  })

  it('reports an empty month as absent, not as any kind of reading', () => {
    expect(state(false, false, false)).toBe('ABSENT')
  })

  /**
   * The regression itself. June 2026 has 29 rooms on the register AND a ringgit
   * compilation carrying no kWh of its own; its stored lines say METERED. A
   * banner reading "back-inferred ... inherits that stale rate" over metered
   * figures is a false alarm, and a false alarm is how an operator learns to
   * stop reading the banner at all.
   */
  it('does not cry back-inference over a month that is on the register', () => {
    expect(state(true, false, true)).toBe('REGISTER')
    expect(state(true, false, true)).not.toBe('BACK_INFERRED')
  })

  /**
   * The mirror of the -1 meter-id bug: a register-only month — which is every
   * month the office keys on /monthly/[month]/coldroom without also filing a
   * ringgit compilation — must not read as "nothing entered".
   */
  it('does not report a register-only month as missing from the bridge', () => {
    expect(state(true, false, false)).not.toBe('ABSENT')
  })
})
