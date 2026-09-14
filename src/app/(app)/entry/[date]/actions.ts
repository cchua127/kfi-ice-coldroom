'use server'

import { revalidatePath } from 'next/cache'
import { Prisma } from '@prisma/client'
import { entryPrisma as prisma, asDate } from '@/lib/entry'
import { requireStaff } from '@/lib/session'
import {
  validateMeter, validateProduction, validateCash, validateSale,
  hasBlocking, type Issue,
} from '@/lib/validation'
import { d } from '@/lib/money'

export interface DayPayload {
  date: string
  meters: { meterCode: string; closing: string; rollover: boolean; note?: string }[]
  production: {
    line: string; unitCode: string; quantity: string
    tongKosong?: string; focQuantity?: string
  }[]
  cash: { shift1: string; shift2: string; note?: string }
  sales: { customer: string; product: string; quantity: string; unitPrice: string }[]
  purchases: { supplier: string; doNo?: string; quantity: string; unitPrice: string }[]
}

export interface SaveResult {
  ok: boolean
  issues: Issue[]
  savedAt?: string
}

const num = (v: string | undefined | null): string | null =>
  v === undefined || v === null || v.trim() === '' ? null : v.trim()

/**
 * Saves one day. The client runs the same rules for immediate feedback, but
 * this copy is the one that decides — a form post is not a trusted input.
 */
export async function saveDay(payload: DayPayload): Promise<SaveResult> {
  const user = await requireStaff()
  const date = payload.date
  const issues: Issue[] = []

  // Re-read the prior readings here rather than trusting what the form carried.
  const meters = await prisma.meter.findMany({ where: { active: true } })
  const metersByCode = Object.fromEntries(meters.map((m) => [m.code, m]))

  for (const m of payload.meters) {
    const meter = metersByCode[m.meterCode]
    if (!meter) continue
    const closing = num(m.closing)
    if (closing === null) continue
    const prior = await prisma.meterReading.findFirst({
      where: { meterId: meter.id, readingDate: { lt: asDate(date) } },
      orderBy: { readingDate: 'desc' },
    })
    issues.push(
      ...validateMeter({
        meterCode: m.meterCode,
        label: m.meterCode,
        closing,
        priorClosing: prior ? prior.closing.toString() : null,
        priorDate: prior ? prior.readingDate.toISOString().slice(0, 10) : null,
        digits: meter.digits,
        rolloverConfirmed: m.rollover,
      })
    )
  }

  const blocksPerBaris = await prisma.costAssumption.findFirst({
    where: { key: 'blocks_per_baris', effectiveFrom: { lte: asDate(date) } },
    orderBy: { effectiveFrom: 'desc' },
  })

  for (const p of payload.production) {
    const quantity = num(p.quantity)
    if (quantity === null) continue
    issues.push(
      ...validateProduction({
        line: p.line,
        label: `${p.line} ${p.unitCode}`,
        unitCode: p.unitCode,
        quantity,
        tongKosong: num(p.tongKosong),
        focQuantity: num(p.focQuantity),
        blocksPerBaris: blocksPerBaris?.value.toString() ?? '8',
      })
    )
  }

  issues.push(
    ...validateCash({
      shift1: num(payload.cash.shift1),
      shift2: num(payload.cash.shift2),
      note: payload.cash.note ?? null,
    })
  )

  payload.sales.forEach((s, index) =>
    issues.push(
      ...validateSale({
        index,
        customer: s.customer || null,
        product: s.product || null,
        quantity: num(s.quantity),
        unitPrice: num(s.unitPrice),
      })
    )
  )

  if (hasBlocking(issues)) return { ok: false, issues }

  const lines = await prisma.productionLine.findMany()
  const lineId = Object.fromEntries(lines.map((l) => [l.code as string, l.id]))
  const customers = await prisma.customer.findMany()
  const customerId = Object.fromEntries(customers.map((c) => [c.name, c.id]))
  const products = await prisma.product.findMany()
  const productId = Object.fromEntries(products.map((p) => [p.code, p.id]))

  await prisma.$transaction(async (tx) => {
    for (const m of payload.meters) {
      const meter = metersByCode[m.meterCode]
      const closing = num(m.closing)
      if (!meter) continue
      if (closing === null) {
        await tx.meterReading.deleteMany({
          where: { meterId: meter.id, readingDate: asDate(date) },
        })
        continue
      }
      await tx.meterReading.upsert({
        where: { readingDate_meterId: { readingDate: asDate(date), meterId: meter.id } },
        create: {
          readingDate: asDate(date), meterId: meter.id,
          closing: new Prisma.Decimal(closing), rollover: m.rollover,
          note: m.note ?? null, enteredBy: user.id,
        },
        update: {
          closing: new Prisma.Decimal(closing), rollover: m.rollover,
          note: m.note ?? null, enteredBy: user.id,
        },
      })
    }

    for (const p of payload.production) {
      const id = lineId[p.line]
      const quantity = num(p.quantity)
      if (!id) continue
      const key = {
        prodDate_lineId_shift_unitCode: {
          prodDate: asDate(date), lineId: id, shift: 'UNSPLIT' as const,
          unitCode: p.unitCode as never,
        },
      }
      if (quantity === null) {
        await tx.productionDaily.deleteMany({
          where: { prodDate: asDate(date), lineId: id, unitCode: p.unitCode as never },
        })
        continue
      }
      const data = {
        quantity: new Prisma.Decimal(quantity),
        tongKosong: new Prisma.Decimal(num(p.tongKosong) ?? '0'),
        focQuantity: new Prisma.Decimal(num(p.focQuantity) ?? '0'),
      }
      await tx.productionDaily.upsert({
        where: key,
        create: {
          prodDate: asDate(date), lineId: id, shift: 'UNSPLIT',
          unitCode: p.unitCode as never, ...data,
        },
        update: data,
      })
    }

    const s1 = num(payload.cash.shift1)
    const s2 = num(payload.cash.shift2)
    if (s1 === null && s2 === null) {
      await tx.cashSalesDaily.deleteMany({ where: { saleDate: asDate(date) } })
    } else {
      const data = {
        shift1: new Prisma.Decimal(s1 ?? '0'),
        shift2: new Prisma.Decimal(s2 ?? '0'),
        note: payload.cash.note ?? null,
      }
      await tx.cashSalesDaily.upsert({
        where: { saleDate: asDate(date) },
        create: { saleDate: asDate(date), ...data },
        update: data,
      })
    }

    // Sales and purchases are replaced wholesale: the form holds the full set
    // for the day, so a row removed there must disappear here.
    await tx.outsideSale.deleteMany({ where: { saleDate: asDate(date) } })
    for (const s of payload.sales) {
      const cid = customerId[s.customer]
      const pid = productId[s.product]
      const quantity = num(s.quantity)
      if (!cid || !pid || quantity === null) continue
      const unitPrice = new Prisma.Decimal(num(s.unitPrice) ?? '0')
      await tx.outsideSale.create({
        data: {
          saleDate: asDate(date), customerId: cid, productId: pid,
          quantity: new Prisma.Decimal(quantity), unitPrice,
          amount: unitPrice.times(new Prisma.Decimal(quantity)),
        },
      })
    }

    await tx.icePurchase.deleteMany({ where: { buyDate: asDate(date) } })
    for (const p of payload.purchases) {
      const sid = customerId[p.supplier]
      const quantity = num(p.quantity)
      if (!sid || quantity === null) continue
      const unitPrice = new Prisma.Decimal(num(p.unitPrice) ?? '0')
      await tx.icePurchase.create({
        data: {
          buyDate: asDate(date), supplierId: sid, doNo: p.doNo || null,
          quantity: new Prisma.Decimal(quantity), unitPrice,
          amount: unitPrice.times(new Prisma.Decimal(quantity)),
        },
      })
    }

    await tx.changeLog.create({
      data: {
        tableName: 'day_entry', rowPk: date, action: 'UPDATE',
        after: JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue,
        changedBy: user.id,
      },
    })
  })

  revalidatePath(`/entry/${date}`)
  revalidatePath('/')
  void d
  return { ok: true, issues, savedAt: new Date().toISOString() }
}
