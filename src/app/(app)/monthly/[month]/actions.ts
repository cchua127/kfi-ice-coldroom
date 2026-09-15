'use server'

import { revalidatePath } from 'next/cache'
import { monthlyPrisma as prisma, asMonthDate } from '@/lib/monthly'
import { requireStaff } from '@/lib/session'
import { Assumptions } from '@/lib/domain'
import {
  validateColdroomMonth,
  validateWaterMonth,
  hasBlocking,
  type Issue,
} from '@/lib/validation'

const iso = (x: Date) => x.toISOString().slice(0, 10)

export interface MonthPayload {
  month: string
  coldroom: {
    meteredKwh: string
    ratonoRm: string
    yemintRm: string
    iceStoreInvoicedRm: string
    note: string
  }
  water: { tonnes: string; retailM3: string; note: string }
}

export interface MonthSaveResult {
  ok: boolean
  issues: Issue[]
  savedAt?: string
}

/** Blank stays blank. Only an explicit figure becomes a number. */
const num = (v: string | undefined | null): string | null =>
  v === undefined || v === null || v.trim() === '' ? null : v.trim()

const prevMonth = (m: string) => {
  const [y, mm] = m.split('-').map(Number)
  return new Date(Date.UTC(y, mm - 2, 1)).toISOString().slice(0, 7)
}

/**
 * Save one month's coldroom and water.
 *
 * The client runs the same rules for immediate feedback; this copy decides.
 *
 * A row is DELETED rather than zeroed when every field is cleared. Leaving a
 * row of zeros behind would read as "the coldroom drew nothing this month",
 * which is a measurement, when what the user meant was "there is nothing here".
 * The recompute then drops the daily rows with it.
 */
export async function saveMonth(payload: MonthPayload): Promise<MonthSaveResult> {
  await requireStaff()
  const month = payload.month
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return { ok: false, issues: [{ severity: 'ERROR', field: 'month', message: 'Bad month.' }] }
  }

  const assumptionRows = await prisma.costAssumption.findMany()
  const assumptions = new Assumptions(
    assumptionRows.map((a) => ({
      key: a.key,
      effectiveFrom: iso(a.effectiveFrom),
      value: a.value.toString(),
      measured: a.measured,
    }))
  )
  const at = `${month}-01`

  const prior = await prisma.waterDelivery.findUnique({
    where: { periodMonth: asMonthDate(prevMonth(month)) },
  })

  const issues: Issue[] = [
    ...validateColdroomMonth({
      meteredKwh: num(payload.coldroom.meteredKwh),
      ratonoRm: num(payload.coldroom.ratonoRm),
      yemintRm: num(payload.coldroom.yemintRm),
      iceStoreInvoicedRm: num(payload.coldroom.iceStoreInvoicedRm),
      legacyFactor: assumptions.at('coldroom_legacy_factor_rm_per_kwh', at),
      tenantRate: assumptions.at('tenant_billing_rate_rm_per_kwh', at),
    }),
    ...validateWaterMonth({
      tonnes: num(payload.water.tonnes),
      retailM3: num(payload.water.retailM3),
      priorTonnes: prior ? prior.tonnes.toString() : null,
    }),
  ]
  if (hasBlocking(issues)) return { ok: false, issues }

  const periodMonth = asMonthDate(month)
  const cr = payload.coldroom
  const coldroomEmpty =
    !num(cr.meteredKwh) && !num(cr.ratonoRm) && !num(cr.yemintRm) && !num(cr.iceStoreInvoicedRm)
  const waterEmpty = !num(payload.water.tonnes) && !num(payload.water.retailM3)

  if (coldroomEmpty) {
    await prisma.coldroomMonthly.deleteMany({ where: { periodMonth } })
  } else {
    const data = {
      meteredKwh: num(cr.meteredKwh),
      ratonoRm: num(cr.ratonoRm) ?? '0',
      yemintRm: num(cr.yemintRm) ?? '0',
      iceStoreInvoicedRm: num(cr.iceStoreInvoicedRm) ?? '0',
      note: cr.note.trim() || null,
    }
    await prisma.coldroomMonthly.upsert({
      where: { periodMonth },
      create: { periodMonth, ...data },
      update: data,
    })
  }

  if (waterEmpty) {
    await prisma.waterDelivery.deleteMany({ where: { periodMonth } })
  } else {
    const data = {
      tonnes: num(payload.water.tonnes) ?? '0',
      retailM3: num(payload.water.retailM3) ?? '0',
      note: payload.water.note.trim() || null,
    }
    await prisma.waterDelivery.upsert({
      where: { periodMonth },
      create: { periodMonth, ...data },
      update: data,
    })
  }

  revalidatePath(`/monthly/${month}`)
  // Nothing downstream has moved yet: these figures reach the reports only
  // through the recompute, which is a deliberate step rather than a side
  // effect of typing. The screen says so.
  return { ok: true, issues, savedAt: new Date().toISOString() }
}
