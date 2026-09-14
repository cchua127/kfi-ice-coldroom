/** Loading and saving one day's entry. */
import { PrismaClient, Prisma } from '@prisma/client'
import { d } from './money'
import { addDays, asAt } from './domain'
import { trailingMean } from './validation'

const prisma = new PrismaClient()
const iso = (x: Date) => x.toISOString().slice(0, 10)
const asDate = (s: string) => new Date(`${s}T00:00:00.000Z`)

export interface MeterRow {
  meterCode: string
  label: string
  labelBm: string
  digits: number
  closing: string | null
  priorClosing: string | null
  priorDate: string | null
  trailingMean: string | null
  rollover: boolean
}

export interface ProductionRow {
  line: string
  label: string
  unitCode: string
  unitLabel: string
  unitLabelBm: string
  kgPerUnit: string | null
  quantity: string | null
  tongKosong: string | null
  focQuantity: string | null
}

export interface SaleRow {
  customer: string | null
  product: string | null
  quantity: string | null
  unitPrice: string | null
}

export interface PurchaseRow {
  supplier: string | null
  doNo: string | null
  quantity: string | null
  unitPrice: string | null
}

export interface DayEntry {
  date: string
  meters: MeterRow[]
  production: ProductionRow[]
  cash: { shift1: string; shift2: string; note: string | null }
  sales: SaleRow[]
  purchases: PurchaseRow[]
  reference: {
    customers: { name: string; channel: string }[]
    suppliers: string[]
    products: { code: string; name: string }[]
    /** Price as at this date, keyed `customer|product`. */
    prices: Record<string, string>
    blocksPerBaris: string
  }
  /** Days of this month that already have any entry, for the calendar strip. */
  monthDaysWithData: number[]
}

const LINE_UNITS: [string, string, string, string, string][] = [
  // line, label, unitCode, English unit, BM unit
  ['TUBE', 'Tube Ice', 'BAG', 'Bags', 'Bag'],
  ['TUBE', 'Tube Ice', 'TONG', 'Tong', 'Tong'],
  ['BIG_POOL', 'Big Pool', 'BARIS', 'Rows', 'Baris'],
  ['BIMC', 'BIMC (China)', 'SMALL_TONG', 'Small tong', 'Tong Kecil'],
]

const METER_LABELS: Record<string, [string, string]> = {
  TUBE: ['Tube', 'Tiub'],
  BIG_POOL: ['Big Pool', 'Kolam Besar'],
  COLDROOM: ['Coldroom', 'Bilik Sejuk'],
}

export async function loadDay(date: string): Promise<DayEntry> {
  const month = date.slice(0, 7)
  const monthStart = asDate(`${month}-01`)
  const monthEnd = asDate(`${month}-31`)

  const [meters, lines, units, readings, production, cash, sales, purchases,
         customers, products, prices, assumptions, monthCash, monthProd] =
    await Promise.all([
      prisma.meter.findMany({ where: { active: true }, orderBy: { id: 'asc' } }),
      prisma.productionLine.findMany(),
      prisma.productionUnit.findMany(),
      prisma.meterReading.findMany({
        where: { readingDate: { lte: asDate(date) } },
        orderBy: { readingDate: 'desc' },
        take: 200,
      }),
      prisma.productionDaily.findMany({ where: { prodDate: asDate(date) } }),
      prisma.cashSalesDaily.findUnique({ where: { saleDate: asDate(date) } }),
      prisma.outsideSale.findMany({
        where: { saleDate: asDate(date) },
        include: { customer: true, product: true },
      }),
      prisma.icePurchase.findMany({
        where: { buyDate: asDate(date) },
        include: { supplier: true },
      }),
      prisma.customer.findMany({ orderBy: { name: 'asc' } }),
      prisma.product.findMany({ orderBy: { code: 'asc' } }),
      prisma.price.findMany({ include: { customer: true, product: true } }),
      prisma.costAssumption.findMany({ where: { key: 'blocks_per_baris' } }),
      prisma.cashSalesDaily.findMany({
        where: { saleDate: { gte: monthStart, lte: monthEnd } },
      }),
      prisma.productionDaily.findMany({
        where: { prodDate: { gte: monthStart, lte: monthEnd } },
      }),
    ])

  const lineById = Object.fromEntries(lines.map((l) => [l.id, l.code as string]))
  const lineIdByCode = Object.fromEntries(lines.map((l) => [l.code as string, l.id]))

  const meterRows: MeterRow[] = meters.map((m) => {
    const own = readings.filter((r) => r.meterId === m.id)
    const today = own.find((r) => iso(r.readingDate) === date)
    const earlier = own.filter((r) => iso(r.readingDate) < date)
    const prior = earlier[0] ?? null

    // Daily kWh over the recent readings, for the outlier check. Oldest first.
    const chron = [...earlier].reverse()
    const dailies: string[] = []
    for (let i = 1; i < chron.length; i++) {
      const delta = d(chron[i].closing.toString()).minus(d(chron[i - 1].closing.toString()))
      if (!delta.isNegative()) dailies.push(delta.toString())
    }
    const mean = trailingMean(dailies, 7)
    const [label, labelBm] = METER_LABELS[m.code] ?? [m.code, m.code]

    return {
      meterCode: m.code,
      label,
      labelBm,
      digits: m.digits,
      closing: today ? today.closing.toString() : null,
      priorClosing: prior ? prior.closing.toString() : null,
      priorDate: prior ? iso(prior.readingDate) : null,
      trailingMean: mean ? mean.toString() : null,
      rollover: today?.rollover ?? false,
    }
  })

  const unitRows = units.map((u) => ({
    line: lineById[u.lineId],
    unitCode: u.unitCode as string,
    kgPerUnit: u.kgPerUnit ? u.kgPerUnit.toString() : null,
    effectiveFrom: iso(u.effectiveFrom),
  }))

  const productionRows: ProductionRow[] = LINE_UNITS.map(
    ([line, label, unitCode, unitLabel, unitLabelBm]) => {
      const existing = production.find(
        (p) => lineById[p.lineId] === line && p.unitCode === unitCode
      )
      const unit = asAt(
        unitRows.filter((u) => u.line === line && u.unitCode === unitCode),
        date
      )
      return {
        line, label, unitCode, unitLabel, unitLabelBm,
        kgPerUnit: unit?.kgPerUnit ?? null,
        quantity: existing ? existing.quantity.toString() : null,
        tongKosong: existing ? existing.tongKosong.toString() : null,
        focQuantity: existing ? existing.focQuantity.toString() : null,
      }
    }
  )

  const priceMap: Record<string, string> = {}
  for (const c of customers) {
    for (const p of products) {
      const row = asAt(
        prices
          .filter((x) => x.customerId === c.id && x.productId === p.id)
          .map((x) => ({ effectiveFrom: iso(x.effectiveFrom), unitPrice: x.unitPrice })),
        date
      )
      if (row) priceMap[`${c.name}|${p.code}`] = row.unitPrice.toString()
    }
  }

  const withData = new Set<number>()
  for (const c of monthCash) withData.add(Number(iso(c.saleDate).slice(8, 10)))
  for (const p of monthProd) withData.add(Number(iso(p.prodDate).slice(8, 10)))

  void lineIdByCode
  return {
    date,
    meters: meterRows,
    production: productionRows,
    cash: {
      shift1: cash ? cash.shift1.toString() : '',
      shift2: cash ? cash.shift2.toString() : '',
      note: cash?.note ?? null,
    },
    sales: sales.map((s) => ({
      customer: s.customer.name,
      product: s.product.code,
      quantity: s.quantity.toString(),
      unitPrice: s.unitPrice.toString(),
    })),
    purchases: purchases.map((p) => ({
      supplier: p.supplier.name,
      doNo: p.doNo,
      quantity: p.quantity.toString(),
      unitPrice: p.unitPrice.toString(),
    })),
    reference: {
      customers: customers
        .filter((c) => c.channel === 'OUTSIDE')
        .map((c) => ({ name: c.name, channel: c.channel })),
      suppliers: customers.filter((c) => c.channel === 'SUPPLIER').map((c) => c.name),
      products: products.map((p) => ({ code: p.code, name: p.name })),
      prices: priceMap,
      blocksPerBaris: (
        asAt(
          assumptions.map((a) => ({ effectiveFrom: iso(a.effectiveFrom), value: a.value })),
          date
        )?.value ?? new Prisma.Decimal(8)
      ).toString(),
    },
    monthDaysWithData: [...withData].sort((a, b) => a - b),
  }
}

export const nextDay = (date: string) => addDays(date, 1)
export const prevDay = (date: string) => addDays(date, -1)

export { prisma as entryPrisma, asDate, iso }
