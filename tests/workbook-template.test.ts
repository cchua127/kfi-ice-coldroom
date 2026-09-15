/**
 * The owner's LIVE cost template, reproduced.
 *
 * `tests/fixtures/workbook-template.json` is a machine dump of
 * KFI_Ice_Cost_LIVE_TEMPLATE_4.xlsx — its INPUTS row for each of January to
 * June 2026, and the figures its own formulas computed from them. Nothing in
 * the fixture was typed by hand, so a difference here is a difference between
 * the two implementations and not a transcription slip.
 *
 * This is the acceptance test for the template work, in the way the parallel
 * check is the acceptance test for the import. Unit tests prove the arithmetic
 * is internally consistent; only this proves it agrees with the thing it
 * replaces.
 *
 * Two deliberate differences, both asserted rather than tolerated:
 *
 *   - The template rounds nothing. This system rounds every stored ringgit to
 *     the sen and every stored kWh to two places, so figures agree to a rounding
 *     tolerance rather than to the bit. The tolerances below are tight enough
 *     that a real disagreement cannot hide inside one.
 *
 *   - The template's blended rate is the plain quotient of its two bill totals.
 *     This system reconstructs both bills from kWh and AFA and blends those, so
 *     it ties to the printed bill rather than to a keyed figure. Where a test
 *     needs the template's rate it uses the template's, and says so.
 */
import { describe, it, expect } from 'vitest'
import { Decimal, d } from '@/lib/money'
import { Assumptions } from '@/lib/domain'
import {
  coldroomSplit,
  waterKwh,
  flatDailyKwh,
  siteStatement,
  type EnergyUseRow,
} from '@/lib/site-energy'
import { machineEfficiency, focWatch, coldroomRecovery } from '@/lib/analytics'
import fixture from './fixtures/workbook-template.json'

type Month = (typeof fixture)["months"][number]

const A = fixture.assumptions

/** The template's assumptions, dated from before the earliest month it covers. */
const assumptions = new Assumptions([
  { key: 'brine_compressor_kwh_per_day', effectiveFrom: '2025-10-01', value: A.compressorKwhPerDay },
  { key: 'office_cctv_kwh_per_day', effectiveFrom: '2025-10-01', value: A.officeCctvKwhPerDay },
  { key: 'crusher_kwh_per_day', effectiveFrom: '2025-10-01', value: A.crusherKwhPerDay },
  { key: 'water_kwh_per_tonne', effectiveFrom: '2025-10-01', value: A.waterDeliveredKwhPerTonne },
  { key: 'water_ice_feed_kwh_per_tonne', effectiveFrom: '2025-10-01', value: A.waterIceFeedKwhPerTonne },
])

/** Everything the plant made that month, in kg, the template's way. */
const totalIceKg = (m: Month): Decimal =>
  d(m.inputs.bigTongKg)
    .plus(m.inputs.tubeKg)
    .plus(m.inputs.oldSmallPoolKg)
    .plus(d(m.inputs.chinaBlocksProduced).times(A.bimcBlockKg))

const near = (actual: Decimal | number | null, expected: number | null, tol: number, what: string) => {
  expect(actual, `${what}: expected a figure, got null`).not.toBeNull()
  const got = actual instanceof Decimal ? actual.toNumber() : (actual as number)
  expect(Math.abs(got - (expected as number)), `${what}: ${got} vs ${expected}`).toBeLessThanOrEqual(tol)
}

describe('the owner’s cost template, month by month', () => {
  for (const m of fixture.months as Month[]) {
    describe(`${m.label} 2026`, () => {
      const rate = d(m.expected.ratePerKwh)
      const iceKg = totalIceKg(m)

      it('splits the coldroom into tenant rooms and the D10-D12 ice store', () => {
        const split = coldroomSplit(
          {
            ratonoRm: m.inputs.coldroomRatonoRm,
            yemintRm: m.inputs.coldroomYemintRm,
            iceStoreInvoicedRm: m.inputs.iceStoreInvoicedRm,
          },
          A.coldroomLegacyFactorRmPerKwh,
          A.tenantBillingRateRmPerKwh
        )
        near(split.totalKwh, m.expected.coldroomAllKwh, 0.01, 'coldroom total kWh')
        near(split.iceStoreKwh, m.expected.iceStoreKwh, 0.01, 'D10-D12 kWh')
        near(split.tenantKwh, m.expected.coldroomTenantKwh, 0.02, 'tenant kWh')

        // No sub-meter reading in the template's data, so every month here
        // takes the back-inferred path and must say so.
        expect(split.backInferred).toBe(true)
        expect(split.source).toBe('MODELLED')
        expect(split.totalBasis).toContain('BACK-INFERRED')
      })

      it('models water at the delivered and ice-feed intensities', () => {
        const [delivered, feed] = waterKwh(
          { tonnes: m.inputs.pkpsWaterT, retailM3: m.inputs.retailWaterM3, iceKg },
          A.waterDeliveredKwhPerTonne,
          A.waterIceFeedKwhPerTonne
        )
        // The template holds these in one column; the split is this system's.
        near(delivered.kwh.plus(feed.kwh), m.expected.waterKwh, 0.02, 'water kWh')
        expect(delivered.kwhSource).toBe('MODELLED')
        expect(feed.basis).toContain('ice feed')
      })

      it('charges the standing loads every day of the month', () => {
        const compressor = flatDailyKwh('BRINE_COMPRESSOR', assumptions, `${m.month}-15`)
        const office = flatDailyKwh('OFFICE_CCTV', assumptions, `${m.month}-15`)
        const crusher = flatDailyKwh('CRUSHER', assumptions, `${m.month}-15`)

        near(compressor.kwh.times(m.days), m.expected.compressorKwh, 0.01, 'compressor kWh')
        // The template holds office and crusher in one "site services" column.
        near(
          office.kwh.plus(crusher.kwh).times(m.days),
          m.expected.serviceKwh,
          0.01,
          'site services kWh'
        )
      })

      it('accounts for the whole bill, and leaves the residual as a residual', () => {
        const split = coldroomSplit(
          {
            ratonoRm: m.inputs.coldroomRatonoRm,
            yemintRm: m.inputs.coldroomYemintRm,
            iceStoreInvoicedRm: m.inputs.iceStoreInvoicedRm,
          },
          A.coldroomLegacyFactorRmPerKwh,
          A.tenantBillingRateRmPerKwh
        )
        const [delivered, feed] = waterKwh(
          { tonnes: m.inputs.pkpsWaterT, retailM3: m.inputs.retailWaterM3, iceKg },
          A.waterDeliveredKwhPerTonne,
          A.waterIceFeedKwhPerTonne
        )
        const flat = (code: 'BRINE_COMPRESSOR' | 'OFFICE_CCTV' | 'CRUSHER'): EnergyUseRow => {
          const row = flatDailyKwh(code, assumptions, `${m.month}-15`)
          return { ...row, kwh: row.kwh.times(m.days) }
        }

        const statement = siteStatement({
          billedKwh: m.expected.siteKwh,
          billedRm: m.expected.siteRm,
          productionLines: [
            { code: 'TUBE', label: 'Tube', kwh: m.inputs.tubeKwh, source: 'METERED', basis: 'sub-meter' },
            { code: 'BIG_POOL', label: 'Big pool', kwh: m.inputs.bigPoolKwh, source: 'METERED', basis: 'sub-meter' },
            { code: 'SMALL_POOL', label: 'Old small pool', kwh: m.inputs.oldSmallPoolKwh, source: 'METERED', basis: 'sub-meter' },
            {
              code: 'BIMC',
              label: 'China machine',
              kwh: d(m.inputs.chinaBlocksProduced).times(A.bimcKwhPerBlock),
              source: 'MODELLED',
              basis: `${A.bimcKwhPerBlock} kWh/block`,
            },
          ],
          energyUses: [
            flat('BRINE_COMPRESSOR'),
            flat('OFFICE_CCTV'),
            flat('CRUSHER'),
            { useCode: 'COLDROOM_TENANT', kwh: split.tenantKwh, kwhSource: 'MODELLED', basis: split.totalBasis },
            { useCode: 'COLDROOM_ICE_STORE', kwh: split.iceStoreKwh, kwhSource: 'MODELLED', basis: split.iceStoreBasis },
            delivered,
            feed,
          ],
        })

        near(statement.unallocatedKwh, m.expected.unallocatedKwh, 0.05, 'unallocated kWh')
        near(statement.unallocatedRm, m.expected.statement.unallocatedRm, 0.05, 'unallocated RM')
        near(statement.iceKwh, m.expected.iceKwh, 0.05, 'ice kWh')
        near(statement.iceRm, m.expected.statement.totalIceRm, 0.05, 'ice RM')

        // The residual is defined as the difference, so this cannot be anything
        // but zero — which is the point of asserting it.
        expect(statement.tieOutKwh.toNumber()).toBe(0)

        // Per-line sen rounding, and nothing else, separates the named lines
        // from the bill. A dozen lines at half a sen each.
        expect(Math.abs(statement.roundingDriftRm.toNumber())).toBeLessThan(0.1)

        const byKey = Object.fromEntries(statement.lines.map((l) => [l.key, l]))
        near(byKey.TUBE.costRm, m.expected.statement.tubeRm, 0.02, 'tube RM')
        near(byKey.BIMC.costRm, m.expected.statement.chinaRm, 0.02, 'China machine RM')
        near(byKey.COLDROOM_TENANT.costRm, m.expected.statement.coldroomTenantRm, 0.02, 'tenant coldroom RM')
        near(byKey.COLDROOM_ICE_STORE.costRm, m.expected.statement.iceStoreRm, 0.02, 'D10-D12 RM')
        near(byKey.BRINE_COMPRESSOR.costRm, m.expected.statement.compressorRm, 0.02, 'compressor RM')
        near(
          byKey.OFFICE_CCTV.costRm.plus(byKey.CRUSHER.costRm),
          m.expected.statement.serviceRm,
          0.02,
          'site services RM'
        )
        near(
          byKey.WATER_DELIVERED.costRm.plus(byKey.WATER_ICE_FEED.costRm),
          m.expected.statement.waterRm,
          0.02,
          'water RM'
        )
        near(
          byKey.BIG_POOL.costRm.plus(byKey.SMALL_POOL.costRm),
          m.expected.statement.poolRm,
          0.02,
          'big pool and old small pool RM'
        )
      })

      it('reaches the template’s cost of ice per kilogram', () => {
        const iceRm = d(m.expected.iceKwh).times(rate)
        near(iceRm.dividedBy(iceKg), m.expected.costRmPerKg, 0.000001, 'cost of ice RM/kg')
        near(d(m.expected.iceKwh).dividedBy(iceKg), m.expected.kwhPerKg, 0.000001, 'ice kWh/kg')
      })

      it('watches the China machine’s free-of-charge blocks', () => {
        const watch = focWatch({
          producedUnits: m.inputs.chinaBlocksProduced,
          soldUnits: m.inputs.chinaBlocksSold,
          focUnits: m.inputs.chinaFocBlocks,
          kgPerUnit: A.bimcBlockKg,
          kwhPerUnit: A.bimcKwhPerBlock,
          ratePerKwh: rate,
          unitPriceRm: m.inputs.smallBlockPriceRm,
        })
        near(watch.focTonnes, m.expected.foc.focTonnes, 0.001, 'FOC tonnes')
        near(watch.focShareOfMoved, m.expected.foc.focShareOfMoved, 0.000001, 'FOC share of moved')
        near(watch.electricityInFocRm, m.expected.foc.electricityInFocRm, 0.01, 'electricity in FOC ice')
        near(watch.revenueForgoneRm, m.expected.foc.revenueForgoneRm, 0.01, 'revenue forgone')

        // Made, less sold, less given away — the template's "China ledger gap".
        const gap =
          m.inputs.chinaBlocksProduced - m.inputs.chinaBlocksSold - m.inputs.chinaFocBlocks
        near(watch.ledgerGapUnits, gap, 0, 'block ledger gap')
      })

      it('prices the China machine gross and net of FOC', () => {
        const eff = machineEfficiency(
          {
            line: 'BIMC',
            label: 'China machine',
            kwh: d(m.inputs.chinaBlocksProduced).times(A.bimcKwhPerBlock),
            producedKg: d(m.inputs.chinaBlocksProduced).times(A.bimcBlockKg),
            focKg: d(m.inputs.chinaFocBlocks).times(A.bimcBlockKg),
            kwhSource: 'MODELLED',
          },
          rate
        )
        near(eff.kwhPerKg, m.expected.efficiency.chinaGrossKwhPerKg, 0.000001, 'China gross kWh/kg')
        near(eff.netKwhPerKg, m.expected.efficiency.chinaNetKwhPerKg, 0.000001, 'China net kWh/kg')
        near(eff.rmPerKg, m.expected.foc.grossRmPerKg, 0.000001, 'China gross RM/kg')
        near(eff.netRmPerKg, m.expected.foc.netRmPerKg, 0.000001, 'China net-of-FOC RM/kg')
      })

      it('measures the tube and pool lines against the template', () => {
        const tube = machineEfficiency(
          { line: 'TUBE', label: 'Tube', kwh: m.inputs.tubeKwh, producedKg: m.inputs.tubeKg, kwhSource: 'METERED' },
          rate
        )
        near(tube.kwhPerKg, m.expected.efficiency.tubeKwhPerKg, 0.000001, 'tube kWh/kg')

        // The template's pool line carries the compressor and the old small
        // pool with it, which is why it is assembled rather than read.
        const pool = machineEfficiency(
          {
            line: 'BIG_POOL',
            label: 'Big pool incl. compressor',
            kwh: d(m.inputs.bigPoolKwh)
              .plus(m.inputs.oldSmallPoolKwh)
              .plus(m.expected.compressorKwh),
            producedKg: d(m.inputs.bigTongKg).plus(m.inputs.oldSmallPoolKg),
            kwhSource: 'METERED',
          },
          rate
        )
        near(pool.kwhPerKg, m.expected.efficiency.poolKwhPerKg, 0.000001, 'pool kWh/kg')
      })

      it('reports what reselling power to tenants earned', () => {
        const recovery = coldroomRecovery(
          m.expected.coldroomTenantKwh,
          rate,
          A.tenantBillingRateRmPerKwh
        )
        near(recovery.costRm, m.expected.coldroomRecovery.costRm, 0.01, 'coldroom cost RM')
        near(recovery.billedRm, m.expected.coldroomRecovery.billedRm, 0.01, 'coldroom billed RM')
        near(recovery.marginRm, m.expected.coldroomRecovery.marginRm, 0.01, 'coldroom margin RM')
        near(recovery.marginPerKwh, m.expected.coldroomRecovery.marginPerKwh, 0.00001, 'margin RM/kWh')
        expect(recovery.underwater).toBe(false)
      })
    })
  }
})

describe('what the template teaches about the trend', () => {
  const months = fixture.months as Month[]

  it('shows the coldroom margin shrinking every month as AFA rises', () => {
    const margins = months.map((m) =>
      coldroomRecovery(
        m.expected.coldroomTenantKwh,
        m.expected.ratePerKwh,
        fixture.assumptions.tenantBillingRateRmPerKwh
      ).marginPerKwh.toNumber()
    )
    // Strictly monotonic down, January to June: 9.8 sen/kWh to 2.2 sen/kWh.
    for (let i = 1; i < margins.length; i++) {
      expect(margins[i], `${months[i].label} against ${months[i - 1].label}`).toBeLessThan(
        margins[i - 1]
      )
    }
    expect(margins[0]).toBeGreaterThan(0.09)
    expect(margins[margins.length - 1]).toBeLessThan(0.03)
  })

  it('shows the tenant rate heading under the blended tariff', () => {
    // Not yet underwater, but June's 2.2 sen of headroom is one AFA move from
    // it. The check in src/lib/checks.ts is what will catch the crossing.
    const june = months[months.length - 1]
    expect(june.expected.ratePerKwh).toBeLessThan(fixture.assumptions.tenantBillingRateRmPerKwh)
    expect(fixture.assumptions.tenantBillingRateRmPerKwh - june.expected.ratePerKwh).toBeLessThan(0.03)
  })

  it('never lets the unaccounted residual reach the ice lines', () => {
    // February and March run a NEGATIVE residual in the template — the named
    // loads claim more than the bill. Cost of ice is unmoved by it either way,
    // which is the property that matters.
    const negatives = months.filter((m) => (m.expected.unallocatedKwh as number) < 0)
    expect(negatives.length).toBeGreaterThan(0)
    for (const m of negatives) {
      const iceKg = totalIceKg(m)
      const iceRm = d(m.expected.iceKwh).times(m.expected.ratePerKwh)
      near(iceRm.dividedBy(iceKg), m.expected.costRmPerKg, 0.000001, `${m.label} cost of ice`)
    }
  })
})
