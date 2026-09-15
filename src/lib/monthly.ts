/**
 * The inputs that arrive once a month rather than once a day.
 *
 * Almost everything in this system is keyed daily, and that is the right shape
 * for a plant that runs every day. Two things are not: the coldroom, which
 * reaches the office as a compilation of ringgit, and the water, which arrives
 * as a delivery tonnage and a meter reading. Forcing either into the daily
 * screen would mean inventing a daily figure — and an invented daily figure
 * that looks keyed is exactly what this rebuild exists to stop.
 *
 * So they get a screen of their own, one row per month, and the recompute
 * spreads them across the days it needs to.
 */
import { PrismaClient } from '@prisma/client'
import { Decimal, d } from './money'
import { coldroomSplit } from './site-energy'
import { Assumptions } from './domain'

const prisma = new PrismaClient()

const asMonthDate = (month: string) => new Date(`${month}-01T00:00:00.000Z`)
const iso = (x: Date) => x.toISOString().slice(0, 10)

export interface MonthlyInputs {
  month: string
  coldroom: {
    /** Blank means "not read", which is not the same as zero. */
    meteredKwh: string
    ratonoRm: string
    yemintRm: string
    iceStoreInvoicedRm: string
    note: string
  }
  water: {
    tonnes: string
    retailM3: string
    note: string
  }
  /** What the entered figures currently imply, shown live beside the fields. */
  derived: {
    coldroomTotalKwh: string | null
    tenantKwh: string | null
    iceStoreKwh: string | null
    backInferred: boolean
    basis: string | null
    waterKwh: string | null
  }
  reference: {
    legacyFactor: string
    tenantRate: string
    waterPerTonne: string
    iceFeedPerTonne: string
  }
  /** Months that already have a coldroom or water row, for the picker. */
  monthsWithData: string[]
}

const str = (v: Decimal | null | undefined) => (v === null || v === undefined ? '' : v.toString())

export async function loadMonth(month: string): Promise<MonthlyInputs> {
  const [coldroom, water, assumptionRows, allColdroom, allWater] = await Promise.all([
    prisma.coldroomMonthly.findUnique({ where: { periodMonth: asMonthDate(month) } }),
    prisma.waterDelivery.findUnique({ where: { periodMonth: asMonthDate(month) } }),
    prisma.costAssumption.findMany(),
    prisma.coldroomMonthly.findMany({ select: { periodMonth: true } }),
    prisma.waterDelivery.findMany({ select: { periodMonth: true } }),
  ])

  const assumptions = new Assumptions(
    assumptionRows.map((a) => ({
      key: a.key,
      effectiveFrom: iso(a.effectiveFrom),
      value: a.value.toString(),
      measured: a.measured,
    }))
  )
  const at = `${month}-01`
  const legacyFactor = assumptions.at('coldroom_legacy_factor_rm_per_kwh', at)
  const tenantRate = assumptions.at('tenant_billing_rate_rm_per_kwh', at)
  const waterPerTonne = assumptions.at('water_kwh_per_tonne', at)
  const iceFeedPerTonne = assumptions.at('water_ice_feed_kwh_per_tonne', at)

  let derived: MonthlyInputs['derived'] = {
    coldroomTotalKwh: null,
    tenantKwh: null,
    iceStoreKwh: null,
    backInferred: false,
    basis: null,
    waterKwh: null,
  }
  if (coldroom) {
    const split = coldroomSplit(
      {
        meteredKwh: coldroom.meteredKwh ? coldroom.meteredKwh.toString() : null,
        ratonoRm: coldroom.ratonoRm.toString(),
        yemintRm: coldroom.yemintRm.toString(),
        iceStoreInvoicedRm: coldroom.iceStoreInvoicedRm.toString(),
      },
      legacyFactor,
      tenantRate
    )
    derived = {
      ...derived,
      coldroomTotalKwh: split.totalKwh.toFixed(2),
      tenantKwh: split.tenantKwh.toFixed(2),
      iceStoreKwh: split.iceStoreKwh.toFixed(2),
      backInferred: split.backInferred,
      basis: split.totalBasis,
    }
  }
  if (water) {
    derived.waterKwh = d(water.tonnes)
      .plus(water.retailM3)
      .times(waterPerTonne)
      .toFixed(2)
  }

  const monthsWithData = [
    ...new Set([
      ...allColdroom.map((r) => iso(r.periodMonth).slice(0, 7)),
      ...allWater.map((r) => iso(r.periodMonth).slice(0, 7)),
    ]),
  ].sort()

  return {
    month,
    coldroom: {
      meteredKwh: str(coldroom?.meteredKwh as Decimal | null | undefined),
      ratonoRm: str(coldroom?.ratonoRm as Decimal | undefined),
      yemintRm: str(coldroom?.yemintRm as Decimal | undefined),
      iceStoreInvoicedRm: str(coldroom?.iceStoreInvoicedRm as Decimal | undefined),
      note: coldroom?.note ?? '',
    },
    water: {
      tonnes: str(water?.tonnes as Decimal | undefined),
      retailM3: str(water?.retailM3 as Decimal | undefined),
      note: water?.note ?? '',
    },
    derived,
    reference: {
      legacyFactor: legacyFactor.toFixed(4),
      tenantRate: tenantRate.toFixed(4),
      waterPerTonne: waterPerTonne.toFixed(4),
      iceFeedPerTonne: iceFeedPerTonne.toFixed(4),
    },
    monthsWithData,
  }
}

export { prisma as monthlyPrisma, asMonthDate }
