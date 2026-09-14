'use server'

import { PrismaClient } from '@prisma/client'
import { Decimal, d } from '@/lib/money'
import { requireUser } from '@/lib/session'
import { readWorkbook, compareMaster, type ParallelResult, type SystemDay } from '@/lib/parallel'

const prisma = new PrismaClient()
const iso = (x: Date) => x.toISOString().slice(0, 10)

export interface CheckOutcome {
  ok: boolean
  result?: ParallelResult
  message?: string
}

/** What the database holds for a month, shaped for comparison. */
async function systemMonth(month: string): Promise<SystemDay[]> {
  const start = new Date(`${month}-01T00:00:00.000Z`)
  const [y, m] = month.split('-').map(Number)
  const end = new Date(Date.UTC(y, m, 0, 23, 59, 59))

  const [costs, lines, cash, sales, readings, meters] = await Promise.all([
    prisma.dailyLineCost.findMany({ where: { costDate: { gte: start, lte: end } } }),
    prisma.productionLine.findMany(),
    prisma.cashSalesDaily.findMany({ where: { saleDate: { gte: start, lte: end } } }),
    prisma.outsideSale.findMany({ where: { saleDate: { gte: start, lte: end } } }),
    prisma.meterReading.findMany({
      where: { readingDate: { gte: new Date(start.getTime() - 86400000), lte: end } },
      orderBy: { readingDate: 'asc' },
    }),
    prisma.meter.findMany(),
  ])

  const lineCode = Object.fromEntries(lines.map((l) => [l.id, l.code as string]))
  const meterCode = Object.fromEntries(meters.map((x) => [x.id, x.code]))
  const day = (x: Date) => Number(iso(x).slice(8, 10))

  // Consumption per day, measured against the previous reading, exactly as the
  // cost engine does it.
  const kwh = new Map<string, Map<number, Decimal>>()
  for (const code of ['TUBE', 'BIG_POOL']) {
    const own = readings
      .filter((r) => meterCode[r.meterId] === code)
      .sort((a, b) => (a.readingDate < b.readingDate ? -1 : 1))
    const perDay = new Map<number, Decimal>()
    for (let i = 1; i < own.length; i++) {
      if (iso(own[i].readingDate).slice(0, 7) !== month) continue
      const delta = d(own[i].closing.toString()).minus(own[i - 1].closing.toString())
      if (!delta.isNegative()) perDay.set(day(own[i].readingDate), delta)
    }
    kwh.set(code, perDay)
  }

  const days = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const out: SystemDay[] = []

  for (let n = 1; n <= days; n++) {
    const dayCosts = costs.filter((c) => day(c.costDate) === n)
    const c = cash.find((x) => day(x.saleDate) === n)
    const daySales = sales.filter((x) => day(x.saleDate) === n)
    if (!dayCosts.length && !c && !daySales.length) continue

    const kgFor = (code: string) => {
      const rows = dayCosts.filter((x) => lineCode[x.lineId] === code)
      return rows.length ? rows.reduce<Decimal>((a, x) => a.plus(x.kg), d(0)) : null
    }
    const bigPool = kgFor('BIG_POOL')
    const bimc = kgFor('BIMC')

    out.push({
      day: n,
      cash: c ? d(c.shift1.toString()).plus(c.shift2.toString()) : null,
      outsideSales: daySales.length
        ? daySales.reduce<Decimal>((a, x) => a.plus(x.amount.toString()), d(0))
        : null,
      totalKg: dayCosts.length
        ? dayCosts.reduce<Decimal>((a, x) => a.plus(x.kg), d(0))
        : null,
      tubeKg: kgFor('TUBE'),
      bigPoolPlusBimcKg:
        bigPool || bimc ? (bigPool ?? d(0)).plus(bimc ?? d(0)) : null,
      smallPoolKg: kgFor('SMALL_POOL'),
      tubeKwh: kwh.get('TUBE')?.get(n) ?? null,
      bigPoolKwh: kwh.get('BIG_POOL')?.get(n) ?? null,
    })
  }
  return out
}

export async function runParallelCheck(formData: FormData): Promise<CheckOutcome> {
  await requireUser()
  const month = String(formData.get('month') ?? '')
  if (!/^\d{4}-\d{2}$/.test(month)) return { ok: false, message: 'Choose a month.' }

  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: 'Choose the Daily Rekod Ais workbook.' }
  }

  const wb = await readWorkbook(Buffer.from(await file.arrayBuffer()))
  if (!wb) {
    return {
      ok: false,
      message:
        `"${file.name}" could not be read. This check handles the modern .xlsx ` +
        `format; a legacy .xls file needs saving as .xlsx first. Daily Rekod Ais ` +
        `is already .xlsx, and its columns carry the cash and outside-sales ` +
        `figures from the two .xls books anyway.`,
    }
  }

  return { ok: true, result: compareMaster(wb, month, await systemMonth(month)) }
}
