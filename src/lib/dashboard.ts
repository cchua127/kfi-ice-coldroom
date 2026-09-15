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
  /**
   * The four the owner's cost template leads on. Each is null rather than zero
   * when the month has nothing to compute it from — a zero blended tariff would
   * read as free electricity, and a zero coldroom margin as breaking even.
   */
  blendedRate: number | null
  unallocatedRm: number | null
  unallocatedShare: number | null
  coldroomMarginRm: number | null
  /** Year to date, because a single month's giveaway is not the story. */
  focTonnesYtd: number
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

  const [costs, lines, afaRows, cash, sales, bills, readings, energy, energyRefs, coldroomRows] =
    await Promise.all([
    prisma.dailyLineCost.findMany({ orderBy: { costDate: 'asc' } }),
    prisma.productionLine.findMany(),
    prisma.afaRate.findMany(),
    prisma.cashSalesDaily.findMany(),
    prisma.outsideSale.findMany(),
    prisma.tnbBill.findMany({ include: { account: true } }),
    prisma.meterReading.findMany({ orderBy: { readingDate: 'asc' } }),
    prisma.dailyEnergyUse.findMany({ orderBy: { costDate: 'asc' } }),
    prisma.energyUse.findMany(),
    prisma.coldroomMonthly.findMany(),
  ])

  // Which consumers belong in cost of ice is the owner's convention, held on
  // energy_use. Reading it here rather than hardcoding it is what lets the
  // dashboard and the reports agree after the owner changes their mind.
  const iceUse = new Set(energyRefs.filter((u) => u.countsAsIce).map((u) => u.code as string))
  const supportByMonth = new Map<string, { kwh: Decimal; rm: Decimal }>()
  for (const e of energy) {
    if (!iceUse.has(e.useCode)) continue
    const m = iso(e.costDate).slice(0, 7)
    const v = supportByMonth.get(m) ?? { kwh: d(0), rm: d(0) }
    supportByMonth.set(m, { kwh: v.kwh.plus(e.kwh), rm: v.rm.plus(e.costRm) })
  }

  const lineCode = Object.fromEntries(lines.map((l) => [l.id, l.code as string]))
  const meterIsColdroom = new Set(
    (await prisma.meter.findMany({ where: { code: 'COLDROOM' } })).map((m) => m.id)
  )
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
    // Cost of ice carries the support plant — the brine compressor and the
    // D10-D12 ice store — exactly as the reports do. Two screens quoting
    // different costs of ice for the same month would be worse than either.
    const support = supportByMonth.get(m) ?? { kwh: d(0), rm: d(0) }
    const iceKwh = rows.reduce<Decimal>((a, r) => a.plus(r.kwh), d(0)).plus(support.kwh)
    const iceKg = rows.reduce<Decimal>((a, r) => a.plus(r.kg), d(0))
    const costRm = rows.reduce<Decimal>((a, r) => a.plus(r.costRm), d(0)).plus(support.rm)
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
  const mtdSupport = supportByMonth.get(month) ?? { kwh: d(0), rm: d(0) }
  const mtdKg = mtdRows.reduce<Decimal>((a, r) => a.plus(r.kg), d(0))
  const mtdElec = mtdRows.reduce<Decimal>((a, r) => a.plus(r.costRm), d(0)).plus(mtdSupport.rm)
  const mtdCash = cash
    .filter((c) => iso(c.saleDate).startsWith(month))
    .reduce<Decimal>((a, c) => a.plus(c.shift1).plus(c.shift2), d(0))
  const mtdOutside = sales
    .filter((s) => iso(s.saleDate).startsWith(month))
    .reduce<Decimal>((a, s) => a.plus(s.amount), d(0))
  const mtdSales = mtdCash.plus(mtdOutside)
  const mtdStatus = months.find((m) => m.month === month)?.status ?? 'NO_RATE'

  // The site picture for the month in progress: what was billed, what the
  // named lines claim, and what is left over.
  const mtdBills = bills.filter((b) => iso(b.periodStart).startsWith(month))
  const mtdBilledKwh = mtdBills.reduce<Decimal>((a, b) => a.plus(b.kwh), d(0))
  const mtdBilledRm = mtdBills.reduce<Decimal>(
    (a, b) => a.plus(b.currentChargesRm ?? b.totalRm), d(0)
  )
  const mtdBlended = mtdBilledKwh.isZero() ? null : mtdBilledRm.dividedBy(mtdBilledKwh)
  const mtdNamedKwh = mtdRows
    .reduce<Decimal>((a, r) => a.plus(r.kwh), d(0))
    .plus(energy.filter((e) => iso(e.costDate).startsWith(month))
      .reduce<Decimal>((a, e) => a.plus(e.kwh), d(0)))
  const mtdUnalloc = mtdBilledKwh.isZero() ? null : mtdBilledKwh.minus(mtdNamedKwh)

  const mtdTenantKwh = energy
    .filter((e) => e.useCode === 'COLDROOM_TENANT' && iso(e.costDate).startsWith(month))
    .reduce<Decimal>((a, e) => a.plus(e.kwh), d(0))
  const mtdTenantCost = energy
    .filter((e) => e.useCode === 'COLDROOM_TENANT' && iso(e.costDate).startsWith(month))
    .reduce<Decimal>((a, e) => a.plus(e.costRm), d(0))
  const tenantRateRow = await prisma.costAssumption.findFirst({
    where: { key: 'tenant_billing_rate_rm_per_kwh', effectiveFrom: { lte: new Date(`${month}-01`) } },
    orderBy: { effectiveFrom: 'desc' },
  })
  const coldroomMargin =
    mtdTenantKwh.isZero() || !tenantRateRow
      ? null
      : rm(mtdTenantKwh.times(tenantRateRow.value).minus(mtdTenantCost))

  const year = month.slice(0, 4)
  const focTonnesYtd = costs
    .filter((c) => iso(c.costDate).startsWith(year))
    .reduce<Decimal>((a, c) => a.plus(c.focKg), d(0))
    .dividedBy(1000)

  const kpi: Kpi = {
    month,
    kg: mtdKg.toNumber(),
    salesRm: rm(mtdSales).toNumber(),
    electricityRm: rm(mtdElec).toNumber(),
    costPerKg: mtdKg.isZero() ? null : mtdElec.dividedBy(mtdKg).toNumber(),
    salesPerKg: mtdKg.isZero() ? null : mtdSales.dividedBy(mtdKg).toNumber(),
    status: mtdStatus,
    daysWithData: new Set(mtdRows.map((r) => iso(r.costDate))).size,
    blendedRate: mtdBlended ? mtdBlended.toNumber() : null,
    unallocatedRm: mtdUnalloc && mtdBlended ? rm(mtdUnalloc.times(mtdBlended)).toNumber() : null,
    unallocatedShare:
      mtdUnalloc && !mtdBilledKwh.isZero() ? mtdUnalloc.dividedBy(mtdBilledKwh).toNumber() : null,
    coldroomMarginRm: coldroomMargin ? coldroomMargin.toNumber() : null,
    focTonnesYtd: focTonnesYtd.toNumber(),
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

  // How the coldroom got into the bridge, if it did at all. An earlier version
  // of this test compared a meter id against -1, which no row can ever hold, so
  // it reported the coldroom missing however much had been entered.
  const coldroomMeter = readings.some((r) => meterIsColdroom.has(r.meterId))
  const coldroomMonth = coldroomRows.find((c) => iso(c.periodMonth).startsWith(month))
  if (!coldroomMeter && !coldroomMonth) {
    alerts.push({
      level: 'WARN',
      title: 'Coldroom missing from the site bridge',
      detail:
        `Nothing entered for ${month}, so the whole coldroom load is sitting in ` +
        'the unaccounted balance. Key the compilations on the monthly inputs ' +
        'screen, or read the sub-meter.',
    })
  } else if (!coldroomMeter && coldroomMonth && coldroomMonth.meteredKwh === null) {
    alerts.push({
      level: 'INFO',
      title: 'Coldroom kWh is back-inferred',
      detail:
        'Recovered by dividing the ringgit compilations by the frozen ' +
        'RM0.484/kWh factor, because the sub-meter has no readings on file. ' +
        'Every coldroom figure this month inherits that stale rate.',
    })
  }

  return { kpi, months, series, alerts }
}
