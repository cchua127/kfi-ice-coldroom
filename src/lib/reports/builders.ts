/**
 * The seven reports. Each returns the same structure, so the screen, the Excel
 * file and the printout are one implementation rendered three ways.
 */
import { PrismaClient } from '@prisma/client'
import { Decimal, d } from '../money'
import { reconstructBill, siteRate } from '../tariff'
import type { Report, ReportRow, ReportSlug } from './types'
import {
  siteEnergyReport,
  efficiencyReport,
  focWatchReport,
  coldroomReport,
  salesMarginReport,
  monthCloseReport,
} from './site-reports'

const prisma = new PrismaClient()
const iso = (x: Date) => x.toISOString().slice(0, 10)
const monthStart = (m: string) => new Date(`${m}-01T00:00:00.000Z`)
const monthEnd = (m: string) => {
  const [y, mm] = m.split('-').map(Number)
  return new Date(Date.UTC(y, mm, 0, 23, 59, 59))
}
const daysIn = (m: string) => {
  const [y, mm] = m.split('-').map(Number)
  return new Date(Date.UTC(y, mm, 0)).getUTCDate()
}
const n = (v: Decimal | null | undefined) => (v === null || v === undefined ? null : Number(v))
const ratio = (a: Decimal, b: Decimal) => (b.isZero() ? null : Number(a.dividedBy(b)))

const prevMonth = (m: string) => {
  const [y, mm] = m.split('-').map(Number)
  const dt = new Date(Date.UTC(y, mm - 2, 1))
  return dt.toISOString().slice(0, 7)
}

/** Every daily figure for a month, keyed by day. */
async function dailies(month: string) {
  const [costs, lines, production, cash, sales, purchases, readings, meters] =
    await Promise.all([
      prisma.dailyLineCost.findMany({
        where: { costDate: { gte: monthStart(month), lte: monthEnd(month) } },
      }),
      prisma.productionLine.findMany(),
      prisma.productionDaily.findMany({
        where: { prodDate: { gte: monthStart(month), lte: monthEnd(month) } },
      }),
      prisma.cashSalesDaily.findMany({
        where: { saleDate: { gte: monthStart(month), lte: monthEnd(month) } },
      }),
      prisma.outsideSale.findMany({
        where: { saleDate: { gte: monthStart(month), lte: monthEnd(month) } },
        include: { customer: true, product: true },
      }),
      prisma.icePurchase.findMany({
        where: { buyDate: { gte: monthStart(month), lte: monthEnd(month) } },
        include: { supplier: true },
      }),
      prisma.meterReading.findMany({
        where: {
          readingDate: {
            gte: new Date(monthStart(month).getTime() - 86400000),
            lte: monthEnd(month),
          },
        },
        orderBy: { readingDate: 'asc' },
      }),
      prisma.meter.findMany(),
    ])
  const lineCode = Object.fromEntries(lines.map((l) => [l.id, l.code as string]))
  const meterCode = Object.fromEntries(meters.map((m) => [m.id, m.code]))
  return { costs, lineCode, production, cash, sales, purchases, readings, meterCode }
}

const statusOf = (costs: { status: string; rateBasis: string }[]) => {
  if (!costs.length) return undefined
  if (costs.every((c) => c.rateBasis === 'NO_RATE')) return 'NO_RATE' as const
  const anyProvisional = costs.some((c) => c.status === 'PROVISIONAL')
  const anyFinal = costs.some((c) => c.status === 'FINAL')
  return anyProvisional && anyFinal ? ('MIXED' as const)
    : anyProvisional ? ('PROVISIONAL' as const) : ('FINAL' as const)
}

// ---------------------------------------------------------------------------
// 1. Daily Rekod Ais — the master layout, column for column, plus what it never had
// ---------------------------------------------------------------------------
async function dailyRekod(month: string): Promise<Report> {
  const { costs, lineCode, cash, sales } = await dailies(month)
  const days = daysIn(month)

  const byDay = new Map<number, typeof costs>()
  for (const c of costs) {
    const day = Number(iso(c.costDate).slice(8, 10))
    byDay.set(day, [...(byDay.get(day) ?? []), c])
  }
  const cashByDay = new Map(cash.map((c) => [Number(iso(c.saleDate).slice(8, 10)), c]))
  const salesByDay = new Map<number, Decimal>()
  for (const s of sales) {
    const day = Number(iso(s.saleDate).slice(8, 10))
    salesByDay.set(day, (salesByDay.get(day) ?? d(0)).plus(s.amount))
  }

  const rows: ReportRow[] = []
  const t = {
    cash: d(0), outside: d(0), kg: d(0), rm: d(0), kwh: d(0),
    tube: d(0), big: d(0), bimc: d(0), small: d(0),
  }
  let daysWithData = 0

  for (let day = 1; day <= days; day++) {
    const dayCosts = byDay.get(day) ?? []
    const c = cashByDay.get(day)
    const outside = salesByDay.get(day) ?? d(0)
    if (!dayCosts.length && !c && outside.isZero()) continue
    daysWithData++

    const cashTotal = c ? d(c.shift1).plus(c.shift2) : d(0)
    const totalSales = cashTotal.plus(outside)
    const kgFor = (code: string) =>
      dayCosts.filter((x) => lineCode[x.lineId] === code)
        .reduce<Decimal>((a, x) => a.plus(x.kg), d(0))
    const kg = dayCosts.reduce<Decimal>((a, x) => a.plus(x.kg), d(0))
    const kwh = dayCosts.reduce<Decimal>((a, x) => a.plus(x.kwh), d(0))
    const rm = dayCosts.reduce<Decimal>((a, x) => a.plus(x.costRm), d(0))

    t.cash = t.cash.plus(cashTotal); t.outside = t.outside.plus(outside)
    t.kg = t.kg.plus(kg); t.rm = t.rm.plus(rm); t.kwh = t.kwh.plus(kwh)
    t.tube = t.tube.plus(kgFor('TUBE')); t.big = t.big.plus(kgFor('BIG_POOL'))
    t.bimc = t.bimc.plus(kgFor('BIMC')); t.small = t.small.plus(kgFor('SMALL_POOL'))

    rows.push({
      cells: {
        day,
        cash: Number(cashTotal), outside: Number(outside), totalSales: Number(totalSales),
        kg: Number(kg), kwh: Number(kwh), rm: Number(rm),
        kwhPerRm: totalSales.isZero() ? null : ratio(kwh, totalSales),
        kwhPerKg: ratio(kwh, kg),
        rmPerKg: ratio(rm, kg),
        tube: Number(kgFor('TUBE')), big: Number(kgFor('BIG_POOL')),
        bimc: Number(kgFor('BIMC')), small: Number(kgFor('SMALL_POOL')),
      },
    })
  }

  const totalSales = t.cash.plus(t.outside)
  // A ratio row is computed from the totals, never by summing the daily ratios.
  // The legacy sheet did the latter and printed 0.6718 for a column of 13.
  rows.push({
    emphasis: true,
    cells: {
      day: 'TOTAL',
      cash: Number(t.cash), outside: Number(t.outside), totalSales: Number(totalSales),
      kg: Number(t.kg), kwh: Number(t.kwh), rm: Number(t.rm),
      kwhPerRm: totalSales.isZero() ? null : ratio(t.kwh, totalSales),
      kwhPerKg: ratio(t.kwh, t.kg), rmPerKg: ratio(t.rm, t.kg),
      tube: Number(t.tube), big: Number(t.big), bimc: Number(t.bimc), small: Number(t.small),
    },
  })
  // And the average divides by the days that actually have data.
  if (daysWithData) {
    const div = (x: Decimal) => Number(x.dividedBy(daysWithData))
    rows.push({
      emphasis: true,
      cells: {
        day: `Average of ${daysWithData} days`,
        cash: div(t.cash), outside: div(t.outside), totalSales: div(totalSales),
        kg: div(t.kg), kwh: div(t.kwh), rm: div(t.rm),
        kwhPerRm: null, kwhPerKg: null, rmPerKg: null,
        tube: div(t.tube), big: div(t.big), bimc: div(t.bimc), small: div(t.small),
      },
    })
  }

  return {
    meta: {
      slug: 'daily-rekod', name: 'Daily Rekod Ais', period: month,
      generatedAt: new Date().toISOString(), status: statusOf(costs),
    },
    tables: [{
      title: 'Daily Rekod Ais',
      subtitle: 'The master sheet, column for column, with the figures it never carried',
      columns: [
        { key: 'day', label: 'Date', labelBm: 'Tarikh', type: 'text', width: 18 },
        { key: 'cash', label: 'Cash daily', labelBm: 'Tunai', type: 'money', width: 13 },
        { key: 'outside', label: 'Sales outside', type: 'money', width: 13 },
        { key: 'totalSales', label: 'Total sales', type: 'money', width: 13 },
        { key: 'kg', label: 'Total kg', type: 'int', width: 12 },
        { key: 'kwh', label: 'Total kWh', type: 'int', width: 12,
          note: 'Actual kWh. The legacy column headed "TOTAL Kwh" held ringgit.' },
        { key: 'rm', label: 'Electricity RM', type: 'money', width: 14,
          note: 'New. At the site rate for the day, not a frozen 0.484.' },
        { key: 'kwhPerRm', label: 'kWh per RM sales', type: 'rate4', width: 15,
          note: 'The legacy header read "% Kwh/sales".' },
        { key: 'kwhPerKg', label: 'kWh per kg', type: 'ratio3', width: 12,
          note: 'The legacy header read "RM Kwh/kg".' },
        { key: 'rmPerKg', label: 'RM per kg', type: 'rate4', width: 12, note: 'New.' },
        { key: 'tube', label: 'Tube kg', type: 'int', width: 11 },
        { key: 'big', label: 'Big pool kg', type: 'int', width: 12,
          note: 'Big pool alone. The legacy column added the China machine in.' },
        { key: 'bimc', label: 'BIMC kg', type: 'int', width: 11 },
        { key: 'small', label: 'Small pool kg', type: 'int', width: 12 },
      ],
      rows,
      notes: [
        'Ratios come from the monthly totals, never from summing the daily ratios.',
        'The average divides by the days that have data, not by a fixed number.',
      ],
    }],
  }
}

// ---------------------------------------------------------------------------
// 2 & 3. Plant sheets — tube, and big pool without the +429 and the x1.2
// ---------------------------------------------------------------------------
async function plantSheet(
  month: string, line: 'TUBE' | 'BIG_POOL', slug: ReportSlug, name: string
): Promise<Report> {
  const { costs, lineCode, readings, meterCode, production } = await dailies(month)
  const mine = costs.filter((c) => lineCode[c.lineId] === line)
  const days = daysIn(month)

  const closingByDay = new Map<number, number>()
  for (const r of readings) {
    if (meterCode[r.meterId] !== line) continue
    const dt = iso(r.readingDate)
    if (dt.slice(0, 7) === month) closingByDay.set(Number(dt.slice(8, 10)), Number(r.closing))
  }
  const prodByDay = new Map<number, typeof production>()
  for (const p of production) {
    if (lineCode[p.lineId] !== line) continue
    const day = Number(iso(p.prodDate).slice(8, 10))
    prodByDay.set(day, [...(prodByDay.get(day) ?? []), p])
  }

  const rows: ReportRow[] = []
  const t = { kwh: d(0), kg: d(0), rm: d(0) }
  let withData = 0

  for (let day = 1; day <= days; day++) {
    const c = mine.find((x) => Number(iso(x.costDate).slice(8, 10)) === day)
    if (!c) continue
    withData++
    t.kwh = t.kwh.plus(c.kwh); t.kg = t.kg.plus(c.kg); t.rm = t.rm.plus(c.costRm)
    const p = prodByDay.get(day) ?? []
    const qty = (unit: string) =>
      n(p.find((x) => x.unitCode === unit)?.quantity ?? null)

    rows.push({
      cells: {
        day,
        closing: closingByDay.get(day) ?? null,
        kwh: Number(c.kwh),
        a: line === 'TUBE' ? qty('BAG') : qty('BARIS'),
        b: line === 'TUBE' ? qty('TONG') : n(p[0]?.tongKosong ?? null),
        kg: Number(c.kg),
        rate: Number(c.rateRmPerKwh),
        rm: Number(c.costRm),
        kwhPerKg: ratio(c.kwh, c.kg),
        rmPerKg: ratio(c.costRm, c.kg),
        status: c.rateBasis === 'NO_RATE' ? 'not costed' : c.status === 'FINAL' ? 'final' : 'provisional',
      },
    })
  }

  rows.push({
    emphasis: true,
    cells: {
      day: 'TOTAL', closing: null, kwh: Number(t.kwh), a: null, b: null,
      kg: Number(t.kg), rate: null, rm: Number(t.rm),
      kwhPerKg: ratio(t.kwh, t.kg), rmPerKg: ratio(t.rm, t.kg), status: '',
    },
  })
  if (withData) {
    rows.push({
      emphasis: true,
      cells: {
        day: `Average of ${withData} days`, closing: null,
        kwh: Number(t.kwh.dividedBy(withData)), a: null, b: null,
        kg: Number(t.kg.dividedBy(withData)), rate: null,
        rm: Number(t.rm.dividedBy(withData)), kwhPerKg: null, rmPerKg: null, status: '',
      },
    })
  }

  return {
    meta: { slug, name, period: month, generatedAt: new Date().toISOString(), status: statusOf(mine) },
    tables: [{
      title: name,
      subtitle: line === 'BIG_POOL'
        ? 'Metered consumption only — no +429 kWh booking, no x1.2 loader'
        : 'Metered consumption and production from the daily meter book',
      columns: [
        { key: 'day', label: 'Date', labelBm: 'Tarikh', type: 'text', width: 18 },
        { key: 'closing', label: 'Closing reading', labelBm: 'Akhir', type: 'int', width: 15 },
        { key: 'kwh', label: 'kWh', type: 'int', width: 10 },
        line === 'TUBE'
          ? { key: 'a', label: 'Bags', labelBm: 'Bag', type: 'int' as const, width: 9 }
          : { key: 'a', label: 'Rows', labelBm: 'Baris', type: 'int' as const, width: 9 },
        line === 'TUBE'
          ? { key: 'b', label: 'Tong', labelBm: 'Tong', type: 'int' as const, width: 9 }
          : { key: 'b', label: 'Empty cans', labelBm: 'Tong Kosong', type: 'int' as const, width: 12 },
        { key: 'kg', label: 'Kg', type: 'int', width: 11 },
        { key: 'rate', label: 'Site rate RM/kWh', type: 'rate4', width: 15 },
        { key: 'rm', label: 'Electricity RM', type: 'money', width: 14 },
        { key: 'kwhPerKg', label: 'kWh per kg', type: 'ratio3', width: 12 },
        { key: 'rmPerKg', label: 'RM per kg', type: 'rate4', width: 12 },
        { key: 'status', label: 'Costing', type: 'text', width: 12 },
      ],
      notes: line === 'BIG_POOL'
        ? ['Big pool kilograms exclude the China machine, which the legacy sheet added in.']
        : [],
      rows,
    }],
  }
}

// ---------------------------------------------------------------------------
// 4. Daily cash
// ---------------------------------------------------------------------------
async function cashReport(month: string): Promise<Report> {
  const prev = prevMonth(month)
  const [rows_, prevRows] = await Promise.all([
    prisma.cashSalesDaily.findMany({
      where: { saleDate: { gte: monthStart(month), lte: monthEnd(month) } },
      orderBy: { saleDate: 'asc' },
    }),
    prisma.cashSalesDaily.findMany({
      where: { saleDate: { gte: monthStart(prev), lte: monthEnd(prev) } },
    }),
  ])
  const prevByDay = new Map(
    prevRows.map((r) => [Number(iso(r.saleDate).slice(8, 10)), d(r.shift1).plus(r.shift2)])
  )

  let cumulative = d(0)
  let prevCumulative = d(0)
  const rows: ReportRow[] = rows_.map((r, i) => {
    const day = Number(iso(r.saleDate).slice(8, 10))
    const total = d(r.shift1).plus(r.shift2)
    cumulative = cumulative.plus(total)
    prevCumulative = prevCumulative.plus(prevByDay.get(day) ?? d(0))
    const priorTotal = prevByDay.get(day) ?? null
    return {
      cells: {
        date: iso(r.saleDate),
        shift1: Number(r.shift1), shift2: Number(r.shift2), total: Number(total),
        cumulative: Number(cumulative),
        average: Number(cumulative.dividedBy(i + 1)),
        prior: priorTotal ? Number(priorTotal) : null,
        priorCumulative: Number(prevCumulative),
      },
    }
  })

  const total = rows_.reduce<Decimal>((a, r) => a.plus(r.shift1).plus(r.shift2), d(0))
  rows.push({
    emphasis: true,
    cells: {
      date: 'TOTAL',
      shift1: Number(rows_.reduce<Decimal>((a, r) => a.plus(r.shift1), d(0))),
      shift2: Number(rows_.reduce<Decimal>((a, r) => a.plus(r.shift2), d(0))),
      total: Number(total), cumulative: Number(total),
      average: rows_.length ? Number(total.dividedBy(rows_.length)) : null,
      prior: Number(prevCumulative), priorCumulative: Number(prevCumulative),
    },
  })

  return {
    meta: {
      slug: 'cash', name: 'Daily cash', period: month,
      generatedAt: new Date().toISOString(),
    },
    tables: [{
      title: 'Daily counter cash',
      subtitle: `Against ${prev}`,
      columns: [
        { key: 'date', label: 'Date', labelBm: 'Tarikh', type: 'text', width: 14 },
        { key: 'shift1', label: 'Shift 1', type: 'money', width: 12 },
        { key: 'shift2', label: 'Shift 2', type: 'money', width: 12 },
        { key: 'total', label: 'Total', type: 'money', width: 13 },
        { key: 'cumulative', label: 'Cumulative', type: 'money', width: 14 },
        { key: 'average', label: 'Daily average', type: 'money', width: 14 },
        { key: 'prior', label: `${prev} same day`, type: 'money', width: 15 },
        { key: 'priorCumulative', label: `${prev} cumulative`, type: 'money', width: 16 },
      ],
      rows,
      notes: [
        'Pro Sheet Rpt, Fatman, Ratono and the Dif column are excluded entirely, ' +
          'per the owner’s instruction.',
      ],
    }],
  }
}

// ---------------------------------------------------------------------------
// 5. Outside sales and purchases
// ---------------------------------------------------------------------------
async function outsideReport(month: string): Promise<Report> {
  const { sales, purchases } = await dailies(month)

  const byCustomer = new Map<string, { qty: Decimal; amount: Decimal; product: string }>()
  for (const s of sales) {
    const key = `${s.customer.name}|${s.product.name}`
    const cur = byCustomer.get(key) ?? { qty: d(0), amount: d(0), product: s.product.name }
    byCustomer.set(key, {
      qty: cur.qty.plus(s.quantity), amount: cur.amount.plus(s.amount), product: s.product.name,
    })
  }

  const salesRows: ReportRow[] = [...byCustomer.entries()]
    .sort()
    .map(([key, v]) => ({
      cells: {
        customer: key.split('|')[0], product: v.product,
        quantity: Number(v.qty), amount: Number(v.amount),
      },
    }))
  const salesTotal = sales.reduce<Decimal>((a, s) => a.plus(s.amount), d(0))
  salesRows.push({
    emphasis: true,
    cells: { customer: 'TOTAL', product: '', quantity: null, amount: Number(salesTotal) },
  })

  const purchaseRows: ReportRow[] = purchases.map((p) => ({
    cells: {
      date: iso(p.buyDate), supplier: p.supplier.name, doNo: p.doNo ?? '',
      quantity: Number(p.quantity), unitPrice: Number(p.unitPrice), amount: Number(p.amount),
    },
  }))
  const purchaseTotal = purchases.reduce<Decimal>((a, p) => a.plus(p.amount), d(0))
  purchaseRows.push({
    emphasis: true,
    cells: {
      date: 'TOTAL', supplier: '', doNo: '',
      quantity: Number(purchases.reduce<Decimal>((a, p) => a.plus(p.quantity), d(0))),
      unitPrice: null, amount: Number(purchaseTotal),
    },
  })

  return {
    meta: {
      slug: 'outside', name: 'Outside sales and purchases', period: month,
      generatedAt: new Date().toISOString(),
    },
    tables: [
      {
        title: 'Outside sales by customer',
        columns: [
          { key: 'customer', label: 'Customer', type: 'text', width: 20 },
          { key: 'product', label: 'Product', type: 'text', width: 26 },
          { key: 'quantity', label: 'Quantity', type: 'int', width: 12 },
          { key: 'amount', label: 'Amount RM', type: 'money', width: 14 },
        ],
        rows: salesRows,
        notes: ['Amounts use the price in force on the day of sale, snapshotted at entry.'],
      },
      {
        title: 'Ice purchases',
        columns: [
          { key: 'date', label: 'Date', type: 'text', width: 14 },
          { key: 'supplier', label: 'Supplier', type: 'text', width: 18 },
          { key: 'doNo', label: 'DO no.', type: 'text', width: 14 },
          { key: 'quantity', label: 'Quantity', type: 'int', width: 12 },
          { key: 'unitPrice', label: 'Unit price', type: 'money', width: 12 },
          { key: 'amount', label: 'Amount RM', type: 'money', width: 14 },
        ],
        rows: purchaseRows,
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// 6. Monthly electricity reconciliation — the site bridge
// ---------------------------------------------------------------------------
async function electricityReport(month: string): Promise<Report> {
  const { costs, lineCode } = await dailies(month)
  const bills = await prisma.tnbBill.findMany({
    where: { periodStart: { gte: monthStart(month), lte: monthEnd(month) } },
    include: { account: true },
  })

  const billRows: ReportRow[] = bills.map((b) => {
    const built = reconstructBill({
      kwh: b.kwh.toString(),
      afaRatePerKwh: (b.afaRatePerKwh ?? 0).toString(),
      previousBalanceRm: b.previousBalanceRm.toString(),
      roundingRm: b.roundingRm.toString(),
    })
    return {
      cells: {
        account: b.account.accountNo,
        period: `${iso(b.periodStart)} to ${iso(b.periodEnd)}`,
        kwh: Number(b.kwh),
        afa: Number(b.afaRatePerKwh ?? 0),
        currentCharges: Number(b.currentChargesRm ?? b.totalRm),
        total: Number(b.totalRm),
        rate: Number(b.kwh) ? Number(b.currentChargesRm ?? b.totalRm) / Number(b.kwh) : null,
        ties: built.totalRm.toFixed(2) === Number(b.totalRm).toFixed(2) ? 'ties' : 'BREAK',
        status: b.status === 'CONFIRMED' ? 'confirmed' : 'pending review',
      },
    }
  })

  const siteKwh = bills.reduce<Decimal>((a, b) => a.plus(b.kwh), d(0))
  const rate = bills.length
    ? siteRate(bills.map((b) => ({
        kwh: b.kwh.toString(),
        currentChargesRm: (b.currentChargesRm ?? b.totalRm).toString(),
      })))
    : d(0)
  if (bills.length) {
    billRows.push({
      emphasis: true,
      cells: {
        account: 'SITE', period: '', kwh: Number(siteKwh), afa: null,
        currentCharges: Number(bills.reduce<Decimal>(
          (a, b) => a.plus(b.currentChargesRm ?? b.totalRm), d(0))),
        total: Number(bills.reduce<Decimal>((a, b) => a.plus(b.totalRm), d(0))),
        rate: Number(rate), ties: '', status: '',
      },
    })
  }

  // The bridge. The residual is reported as itself and never folded into ice —
  // using "Ice" as the balancing figure was the legacy report's fatal flaw.
  const lineOrder = ['TUBE', 'BIG_POOL', 'BIMC', 'SMALL_POOL', 'COLDROOM']
  const accounted = new Map<string, { kwh: Decimal; source: string }>()
  for (const c of costs) {
    const code = lineCode[c.lineId]
    const cur = accounted.get(code) ?? { kwh: d(0), source: c.kwhSource }
    accounted.set(code, { kwh: cur.kwh.plus(c.kwh), source: c.kwhSource })
  }

  const bridgeRows: ReportRow[] = []
  let accountedTotal = d(0)
  if (bills.length) {
    bridgeRows.push({
      emphasis: true,
      cells: { line: 'Billed site consumption', kwh: Number(siteKwh), source: 'TNB bill',
        share: 1, rm: Number(siteKwh.times(rate)) },
    })
  }
  for (const code of lineOrder) {
    const v = accounted.get(code)
    if (!v) continue
    accountedTotal = accountedTotal.plus(v.kwh)
    bridgeRows.push({
      cells: {
        line: `less ${code.replace('_', ' ').toLowerCase()}`,
        kwh: -Number(v.kwh), source: v.source,
        share: siteKwh.isZero() ? null : -Number(v.kwh.dividedBy(siteKwh)),
        rm: -Number(v.kwh.times(rate)),
      },
    })
  }
  const unaccounted = siteKwh.minus(accountedTotal)
  if (bills.length) {
    bridgeRows.push({
      emphasis: true,
      cells: {
        line: 'Unaccounted', kwh: Number(unaccounted), source: 'residual',
        share: siteKwh.isZero() ? null : Number(unaccounted.dividedBy(siteKwh)),
        rm: Number(unaccounted.times(rate)),
      },
    })
  }

  const notes = [
    'The residual is reported as itself and never charged to ice. Using "Ice" as ' +
      'the balancing figure loaded every site-wide tariff rise onto cost of ice.',
  ]
  if (!accounted.has('COLDROOM')) {
    notes.push(
      'The coldroom sub-meter has no readings on file, so the unaccounted figure ' +
        'here is overstated by the whole coldroom load.'
    )
  }

  return {
    meta: {
      slug: 'electricity', name: 'Monthly electricity reconciliation', period: month,
      generatedAt: new Date().toISOString(), status: statusOf(costs),
    },
    tables: [
      {
        title: 'TNB bills',
        columns: [
          { key: 'account', label: 'Account', type: 'text', width: 16 },
          { key: 'period', label: 'Bill period', type: 'text', width: 26 },
          { key: 'kwh', label: 'kWh', type: 'int', width: 12 },
          { key: 'afa', label: 'AFA RM/kWh', type: 'rate4', width: 13 },
          { key: 'currentCharges', label: 'Caj Semasa', type: 'money', width: 14 },
          { key: 'total', label: 'Jumlah Bil', type: 'money', width: 14 },
          { key: 'rate', label: 'RM/kWh', type: 'rate4', width: 11 },
          { key: 'ties', label: 'Reconstruction', type: 'text', width: 14 },
          { key: 'status', label: 'Status', type: 'text', width: 14 },
        ],
        rows: billRows,
      },
      {
        title: 'Site bridge',
        subtitle: 'Billed consumption, less every line that can be accounted for',
        columns: [
          { key: 'line', label: 'Line', type: 'text', width: 26 },
          { key: 'kwh', label: 'kWh', type: 'int', width: 13 },
          { key: 'source', label: 'Source', type: 'text', width: 12 },
          { key: 'share', label: 'Share of site', type: 'percent', width: 13 },
          { key: 'rm', label: 'At site rate RM', type: 'money', width: 15 },
        ],
        rows: bridgeRows,
        notes,
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// 7. Cost of ice, with the tariff-versus-efficiency decomposition
// ---------------------------------------------------------------------------
async function costOfIceReport(month: string): Promise<Report> {
  const prev = prevMonth(month)
  const [cur, before] = await Promise.all([dailies(month), dailies(prev)])

  const roll = (src: Awaited<ReturnType<typeof dailies>>) => {
    const byLine = new Map<string, { kwh: Decimal; kg: Decimal; rm: Decimal }>()
    for (const c of src.costs) {
      const code = src.lineCode[c.lineId]
      const v = byLine.get(code) ?? { kwh: d(0), kg: d(0), rm: d(0) }
      byLine.set(code, {
        kwh: v.kwh.plus(c.kwh), kg: v.kg.plus(c.kg), rm: v.rm.plus(c.costRm),
      })
    }
    return byLine
  }
  const now = roll(cur)
  const then = roll(before)
  const ICE = ['TUBE', 'BIG_POOL', 'BIMC', 'SMALL_POOL']

  // The support plant: consumers that freeze or hold ice and make none of it.
  // Which ones those are is a column on `energy_use`, not a constant here, so
  // the owner can settle the two arguable cases without a deployment.
  const [supportNow, supportThen, energyRefs] = await Promise.all([
    prisma.dailyEnergyUse.findMany({
      where: { costDate: { gte: monthStart(month), lte: monthEnd(month) } },
    }),
    prisma.dailyEnergyUse.findMany({
      where: { costDate: { gte: monthStart(prev), lte: monthEnd(prev) } },
    }),
    prisma.energyUse.findMany(),
  ])
  const isIce = Object.fromEntries(energyRefs.map((u) => [u.code as string, u.countsAsIce]))
  const label = Object.fromEntries(energyRefs.map((u) => [u.code as string, u.name]))
  const rollSupport = (src: typeof supportNow) => {
    const byUse = new Map<string, { kwh: Decimal; rm: Decimal }>()
    for (const e of src) {
      if (!isIce[e.useCode]) continue
      const v = byUse.get(e.useCode) ?? { kwh: d(0), rm: d(0) }
      byUse.set(e.useCode, { kwh: v.kwh.plus(e.kwh), rm: v.rm.plus(e.costRm) })
    }
    return byUse
  }
  const supNow = rollSupport(supportNow)
  const supThen = rollSupport(supportThen)

  const rows: ReportRow[] = []
  const tot = { kwh: d(0), kg: d(0), rm: d(0) }
  for (const code of ICE) {
    const v = now.get(code)
    if (!v) continue
    tot.kwh = tot.kwh.plus(v.kwh); tot.kg = tot.kg.plus(v.kg); tot.rm = tot.rm.plus(v.rm)
    const p = then.get(code)
    rows.push({
      cells: {
        line: code.replace('_', ' '),
        kwh: Number(v.kwh), kg: Number(v.kg), rm: Number(v.rm),
        kwhPerKg: ratio(v.kwh, v.kg), rmPerKg: ratio(v.rm, v.kg),
        priorKwhPerKg: p ? ratio(p.kwh, p.kg) : null,
        priorRmPerKg: p ? ratio(p.rm, p.kg) : null,
      },
    })
  }
  // Support plant makes no kilograms, so it has no intensity of its own — it
  // raises everyone else's. Listed with blank ratio columns rather than a zero,
  // which would read as a line that is free.
  const producedKg = tot.kg
  for (const [code, v] of [...supNow.entries()].sort()) {
    tot.kwh = tot.kwh.plus(v.kwh); tot.rm = tot.rm.plus(v.rm)
    rows.push({
      cells: {
        line: label[code] ?? code,
        kwh: Number(v.kwh), kg: null, rm: Number(v.rm),
        kwhPerKg: null, rmPerKg: null, priorKwhPerKg: null, priorRmPerKg: null,
      },
    })
  }
  rows.push({
    emphasis: true,
    cells: {
      line: 'ALL ICE', kwh: Number(tot.kwh), kg: Number(tot.kg), rm: Number(tot.rm),
      kwhPerKg: ratio(tot.kwh, tot.kg), rmPerKg: ratio(tot.rm, tot.kg),
      priorKwhPerKg: null, priorRmPerKg: null,
    },
  })

  // Splits the month-on-month move in RM/kg into the part the tariff caused and
  // the part the plant caused. Flat kWh/kg with rising RM/kg means tariff.
  // Both sides of the comparison must carry the support plant, or the month
  // this feature shipped would read as a plant efficiency collapse.
  const priorTot = [...supThen.values()].reduce<{ kwh: Decimal; kg: Decimal; rm: Decimal }>(
    (a, v) => ({ kwh: a.kwh.plus(v.kwh), kg: a.kg, rm: a.rm.plus(v.rm) }),
    ICE.reduce(
      (a, code) => {
        const v = then.get(code)
        return v ? { kwh: a.kwh.plus(v.kwh), kg: a.kg.plus(v.kg), rm: a.rm.plus(v.rm) } : a
      },
      { kwh: d(0), kg: d(0), rm: d(0) }
    )
  )

  const decomposition: ReportRow[] = []
  if (!priorTot.kg.isZero() && !tot.kg.isZero()) {
    const i0 = priorTot.kwh.dividedBy(priorTot.kg)
    const i1 = tot.kwh.dividedBy(tot.kg)
    const r0 = priorTot.kwh.isZero() ? d(0) : priorTot.rm.dividedBy(priorTot.kwh)
    const r1 = tot.kwh.isZero() ? d(0) : tot.rm.dividedBy(tot.kwh)
    const c0 = i0.times(r0)
    const c1 = i1.times(r1)
    // Hold the rate to isolate efficiency, then hold intensity to isolate tariff.
    const efficiencyEffect = i1.minus(i0).times(r0)
    const tariffEffect = r1.minus(r0).times(i1)
    decomposition.push(
      { cells: { item: `${prev} cost per kg`, value: Number(c0), note: '' } },
      { cells: {
          item: 'Plant efficiency', value: Number(efficiencyEffect),
          note: `kWh/kg ${i0.toFixed(4)} to ${i1.toFixed(4)}`,
        } },
      { cells: {
          item: 'Tariff', value: Number(tariffEffect),
          note: `RM/kWh ${r0.toFixed(5)} to ${r1.toFixed(5)}`,
        } },
      { emphasis: true, cells: { item: `${month} cost per kg`, value: Number(c1), note: '' } },
    )
  }

  const tables = [{
    title: 'Cost of ice by line',
    subtitle: `${month}, against ${prev}`,
    columns: [
      { key: 'line', label: 'Line', type: 'text' as const, width: 16 },
      { key: 'kwh', label: 'kWh', type: 'int' as const, width: 12 },
      { key: 'kg', label: 'Kg', type: 'int' as const, width: 13 },
      { key: 'rm', label: 'Electricity RM', type: 'money' as const, width: 15 },
      { key: 'kwhPerKg', label: 'kWh per kg', type: 'ratio3' as const, width: 12 },
      { key: 'rmPerKg', label: 'RM per kg', type: 'rate4' as const, width: 12 },
      { key: 'priorKwhPerKg', label: `${prev} kWh/kg`, type: 'ratio3' as const, width: 13 },
      { key: 'priorRmPerKg', label: `${prev} RM/kg`, type: 'rate4' as const, width: 13 },
    ],
    rows,
    notes: [
      'Cost of ice is the sum of the metered and modelled ice lines, never a ' +
        'site residual.',
      'It now carries the support plant that freezes and holds the ice but ' +
        'produces none — the 30HP brine compressor and the D10-D12 storage ' +
        'rooms. Excluding them understated cost of ice and left the difference ' +
        'in the site residual; a figure higher than the old sheet is that ' +
        'correction, not a break.',
      supNow.size
        ? `Support plant is ${Number(
            [...supNow.values()].reduce<Decimal>((a, v) => a.plus(v.kwh), d(0))
          ).toLocaleString('en-MY')} kWh of the total above.`
        : 'No support plant is costed for this month — run the recompute, or ' +
          'enter the coldroom month it depends on.',
      producedKg.isZero()
        ? 'No production recorded, so there is no cost per kilogram to state.'
        : `Spread over ${Number(producedKg).toLocaleString('en-MY')} kg produced.`,
    ],
  }]

  if (decomposition.length) {
    tables.push({
      title: 'What moved the cost',
      subtitle: 'Flat kWh per kg with rising RM per kg means tariff, not plant',
      columns: [
        { key: 'item', label: 'Component', type: 'text' as const, width: 26 },
        { key: 'value', label: 'RM per kg', type: 'rate4' as const, width: 13 },
        { key: 'note', label: 'Detail', type: 'text' as const, width: 38 },
      ],
      rows: decomposition,
      notes: [],
    })
  }

  return {
    meta: {
      slug: 'cost-of-ice', name: 'Cost of ice', period: month,
      generatedAt: new Date().toISOString(), status: statusOf(cur.costs),
    },
    tables,
  }
}

export async function buildReport(slug: ReportSlug, month: string): Promise<Report> {
  switch (slug) {
    case 'daily-rekod': return dailyRekod(month)
    case 'tube': return plantSheet(month, 'TUBE', 'tube', 'Tube plant')
    case 'big-pool': return plantSheet(month, 'BIG_POOL', 'big-pool', 'Big pool')
    case 'cash': return cashReport(month)
    case 'outside': return outsideReport(month)
    case 'electricity': return electricityReport(month)
    case 'cost-of-ice': return costOfIceReport(month)
    case 'site-energy': return siteEnergyReport(month)
    case 'efficiency': return efficiencyReport(month)
    case 'foc-watch': return focWatchReport(month)
    case 'coldroom': return coldroomReport(month)
    case 'sales-margin': return salesMarginReport(month)
    case 'month-close': return monthCloseReport(month)
  }
}
