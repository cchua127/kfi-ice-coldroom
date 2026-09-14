/** Queries and shapes everything the dashboard renders. */
import { PrismaClient } from '@prisma/client'
import { Decimal, d, rm } from './money'

const prisma = new PrismaClient()
const iso = (x: Date) => x.toISOString().slice(0, 10)

export interface MonthPoint {
  month: string
  iceKwh: number
  iceKg: number
  costRm: number
  rmPerKg: number | null
  kwhPerKg: number | null
  afa: number | null
  status: 'PROVISIONAL' | 'FINAL' | 'NO_RATE'
}

export interface LineSeries {
  line: string
  label: string
  /** Stopped lines are reported separately: their intensity is nothing like a
   *  running line's, so plotting them together flattens everything else. */
  retired: boolean
  retiredOn: string | null
  /** Mean kWh/kg over the months with data — the headline for a stopped line. */
  meanKwhPerKg: number | null
  points: { month: string; kwhPerKg: number | null }[]
}

export interface Kpi {
  month: string
  kg: number
  salesRm: number
  electricityRm: number
  costPerKg: number | null
  salesPerKg: number | null
  status: 'PROVISIONAL' | 'FINAL' | 'NO_RATE'
  daysWithData: number
}

export interface Alert {
  level: 'INFO' | 'WARN' | 'ERROR'
  title: string
  detail: string
}

const LINE_LABELS: Record<string, string> = {
  TUBE: 'Tube Ice',
  BIG_POOL: 'Big Pool',
  BIMC: 'BIMC (China)',
  SMALL_POOL: 'Small Pool',
}

export async function loadDashboard(today: string) {
  const month = today.slice(0, 7)

  const [costs, lines, afaRows, cash, sales, bills, readings] = await Promise.all([
    prisma.dailyLineCost.findMany({ orderBy: { costDate: 'asc' } }),
    prisma.productionLine.findMany(),
    prisma.afaRate.findMany(),
    prisma.cashSalesDaily.findMany(),
    prisma.outsideSale.findMany(),
    prisma.tnbBill.findMany({ include: { account: true } }),
    prisma.meterReading.findMany({ orderBy: { readingDate: 'asc' } }),
  ])

  const lineCode = Object.fromEntries(lines.map((l) => [l.id, l.code as string]))
  const afaByMonth = Object.fromEntries(
    afaRows.map((a) => [iso(a.periodMonth).slice(0, 7), a.ratePerKwh.toNumber()])
  )

  // Monthly roll-up. Ratios come from monthly totals; cost is spread only over
  // tonnage that actually had a rate, so an uncosted day cannot drag it down.
  const byMonth = new Map<string, typeof costs>()
  for (const c of costs) {
    const m = iso(c.costDate).slice(0, 7)
    byMonth.set(m, [...(byMonth.get(m) ?? []), c])
  }

  const months: MonthPoint[] = [...byMonth.entries()].sort().map(([m, rows]) => {
    const iceKwh = rows.reduce<Decimal>((a, r) => a.plus(r.kwh), d(0))
    const iceKg = rows.reduce<Decimal>((a, r) => a.plus(r.kg), d(0))
    const costRm = rows.reduce<Decimal>((a, r) => a.plus(r.costRm), d(0))
    const priced = rows.filter((r) => r.rateBasis !== 'NO_RATE')
    const pricedKg = priced.reduce<Decimal>((a, r) => a.plus(r.kg), d(0))
    const status = !priced.length
      ? 'NO_RATE'
      : rows.some((r) => r.status === 'PROVISIONAL')
        ? 'PROVISIONAL'
        : 'FINAL'
    return {
      month: m,
      iceKwh: iceKwh.toNumber(),
      iceKg: iceKg.toNumber(),
      costRm: costRm.toNumber(),
      rmPerKg: pricedKg.isZero() ? null : costRm.dividedBy(pricedKg).toNumber(),
      kwhPerKg: iceKg.isZero() ? null : iceKwh.dividedBy(iceKg).toNumber(),
      afa: afaByMonth[m] ?? null,
      status: status as MonthPoint['status'],
    }
  })

  // Per-line intensity. Flat kWh/kg with rising RM/kg means tariff, not plant.
  const seriesMap = new Map<string, Map<string, { kwh: Decimal; kg: Decimal }>>()
  for (const c of costs) {
    const code = lineCode[c.lineId]
    const m = iso(c.costDate).slice(0, 7)
    const perLine = seriesMap.get(code) ?? new Map()
    const cur = perLine.get(m) ?? { kwh: d(0), kg: d(0) }
    perLine.set(m, { kwh: cur.kwh.plus(c.kwh), kg: cur.kg.plus(c.kg) })
    seriesMap.set(code, perLine)
  }
  const allMonths = months.map((m) => m.month)
  const retiredBy = Object.fromEntries(
    lines.map((l) => [l.code as string, l.activeTo ? iso(l.activeTo) : null])
  )
  const series: LineSeries[] = ['TUBE', 'BIG_POOL', 'BIMC', 'SMALL_POOL']
    .filter((code) => seriesMap.has(code))
    .map((code) => {
      const perLine = seriesMap.get(code)!
      const points = allMonths.map((m) => {
        const v = perLine.get(m)
        return {
          month: m,
          kwhPerKg: v && !v.kg.isZero() ? v.kwh.dividedBy(v.kg).toNumber() : null,
        }
      })
      const totalKwh = [...perLine.values()].reduce<Decimal>((a, v) => a.plus(v.kwh), d(0))
      const totalKg = [...perLine.values()].reduce<Decimal>((a, v) => a.plus(v.kg), d(0))
      return {
        line: code,
        label: LINE_LABELS[code] ?? code,
        retired: Boolean(retiredBy[code]),
        retiredOn: retiredBy[code] ?? null,
        meanKwhPerKg: totalKg.isZero() ? null : totalKwh.dividedBy(totalKg).toNumber(),
        points,
      }
    })

  // Month-to-date headline.
  const mtdRows = byMonth.get(month) ?? []
  const mtdKg = mtdRows.reduce<Decimal>((a, r) => a.plus(r.kg), d(0))
  const mtdElec = mtdRows.reduce<Decimal>((a, r) => a.plus(r.costRm), d(0))
  const mtdCash = cash
    .filter((c) => iso(c.saleDate).startsWith(month))
    .reduce<Decimal>((a, c) => a.plus(c.shift1).plus(c.shift2), d(0))
  const mtdOutside = sales
    .filter((s) => iso(s.saleDate).startsWith(month))
    .reduce<Decimal>((a, s) => a.plus(s.amount), d(0))
  const mtdSales = mtdCash.plus(mtdOutside)
  const mtdStatus = months.find((m) => m.month === month)?.status ?? 'NO_RATE'

  const kpi: Kpi = {
    month,
    kg: mtdKg.toNumber(),
    salesRm: rm(mtdSales).toNumber(),
    electricityRm: rm(mtdElec).toNumber(),
    costPerKg: mtdKg.isZero() ? null : mtdElec.dividedBy(mtdKg).toNumber(),
    salesPerKg: mtdKg.isZero() ? null : mtdSales.dividedBy(mtdKg).toNumber(),
    status: mtdStatus,
    daysWithData: new Set(mtdRows.map((r) => iso(r.costDate))).size,
  }

  // ---- Alerts -------------------------------------------------------------
  const alerts: Alert[] = []

  const daysSoFar = Number(today.slice(8, 10))
  const present = new Set(
    cash.filter((c) => iso(c.saleDate).startsWith(month)).map((c) => iso(c.saleDate))
  )
  const missing: string[] = []
  for (let day = 1; day <= daysSoFar; day++) {
    const dt = `${month}-${String(day).padStart(2, '0')}`
    if (!present.has(dt)) missing.push(dt)
  }
  if (missing.length) {
    alerts.push({
      level: 'WARN',
      title: `${missing.length} day${missing.length > 1 ? 's' : ''} with no cash entry`,
      detail: missing.slice(0, 8).join(', ') + (missing.length > 8 ? ' …' : ''),
    })
  }

  // A closed month with no bill is costed provisionally until one arrives.
  const accounts = [...new Set(bills.map((b) => b.account.accountNo))]
  const closedMonths = allMonths.filter((m) => m < month)
  for (const m of closedMonths.slice(-3)) {
    const have = bills.filter((b) => iso(b.periodStart).startsWith(m)).map((b) => b.account.accountNo)
    const absent = accounts.filter((a) => !have.includes(a))
    if (absent.length) {
      alerts.push({
        level: 'WARN',
        title: `No TNB bill for ${m}`,
        detail:
          `Account${absent.length > 1 ? 's' : ''} ${absent.join(', ')}. ` +
          `The month is costed provisionally until the bill is confirmed.`,
      })
    }
  }

  const noRate = months.filter((m) => m.status === 'NO_RATE')
  if (noRate.length) {
    alerts.push({
      level: 'INFO',
      title: `${noRate.length} month${noRate.length > 1 ? 's' : ''} cannot be costed`,
      detail:
        `${noRate.map((m) => m.month).join(', ')} — no bill and no published AFA. ` +
        `Consumption and tonnage are recorded; cost is not available.`,
    })
  }

  const spanning = costs.filter((c) => c.spansDays > 1)
  if (spanning.length) {
    alerts.push({
      level: 'WARN',
      title: `${spanning.length} day${spanning.length > 1 ? 's' : ''} carry a multi-day meter delta`,
      detail: 'Entry was missed, so one reading covers several days of consumption.',
    })
  }

  // The coldroom sub-meter exists but has no readings, so the site bridge has
  // no baseline. Say so rather than publishing a bridge that is wrong by the
  // size of the coldroom.
  const coldroom = readings.some((r) => r.meterId === -1)
  if (!coldroom) {
    alerts.push({
      level: 'INFO',
      title: 'Site bridge unavailable',
      detail:
        'The coldroom sub-meter has no readings on file, so the unaccounted ' +
        'balance cannot be computed. It would otherwise be overstated by the ' +
        'whole coldroom load.',
    })
  }

  return { kpi, months, series, alerts }
}
