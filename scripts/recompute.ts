/**
 * Recompute stored daily costs.
 *
 *   npx tsx scripts/recompute.ts                       # everything with data
 *   npx tsx scripts/recompute.ts --from 2026-01-01 --to 2026-06-30
 *   npx tsx scripts/recompute.ts --summary             # print monthly roll-up
 *
 * Safe to re-run: rows are upserted per (date, line). Run it after confirming a
 * bill, after editing a cost assumption, and after an import.
 */
import { PrismaClient, Prisma } from '@prisma/client'
import {
  recompute,
  recomputeEnergyUses,
  summariseMonths,
  type ColdroomMonthRow,
  type ProductionRow,
  type ReadingRow,
  type WaterMonthRow,
} from '../src/lib/cost-recompute'
import type { EnergyUseCode } from '../src/lib/site-energy'
import { buildDailyRateSeries, type BillPeriod } from '../src/lib/cost-engine'
import { Assumptions, type UnitRow, type LineCode, type UnitCode } from '../src/lib/domain'

const prisma = new PrismaClient()
const args = process.argv.slice(2)
const arg = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : null)
const iso = (dt: Date) => dt.toISOString().slice(0, 10)
const date = (s: string) => new Date(`${s}T00:00:00.000Z`)

async function main() {
  const bounds = await prisma.meterReading.aggregate({ _min: { readingDate: true }, _max: { readingDate: true } })
  const prodBounds = await prisma.productionDaily.aggregate({ _min: { prodDate: true }, _max: { prodDate: true } })
  const from = arg('--from') ?? iso(
    [bounds._min.readingDate, prodBounds._min.prodDate].filter(Boolean).sort()[0] as Date
  )
  const to = arg('--to') ?? iso(
    [bounds._max.readingDate, prodBounds._max.prodDate].filter(Boolean).sort().reverse()[0] as Date
  )

  const [
    lines, meters, readingRows, prodRows, unitRows, assumptionRows, bills, afa,
    coldroomRows, registerRows, waterRows, energyUseRefs,
  ] = await Promise.all([
      prisma.productionLine.findMany(),
      prisma.meter.findMany(),
      prisma.meterReading.findMany({ orderBy: { readingDate: 'asc' } }),
      prisma.productionDaily.findMany({ orderBy: { prodDate: 'asc' } }),
      prisma.productionUnit.findMany(),
      prisma.costAssumption.findMany(),
      prisma.tnbBill.findMany({ include: { account: true } }),
      prisma.afaRate.findMany(),
      prisma.coldroomMonthly.findMany({ orderBy: { periodMonth: 'asc' } }),
      prisma.coldroomReading.findMany({ orderBy: [{ periodMonth: 'asc' }, { rowNo: 'asc' }] }),
      prisma.waterDelivery.findMany({ orderBy: { periodMonth: 'asc' } }),
      prisma.energyUse.findMany(),
    ])

  const lineById = Object.fromEntries(lines.map((l) => [l.id, l.code as LineCode]))
  const meterById = Object.fromEntries(meters.map((m) => [m.id, m]))

  const readings: ReadingRow[] = readingRows.map((r) => ({
    meterCode: meterById[r.meterId].code,
    readingDate: iso(r.readingDate),
    closing: r.closing.toString(),
    ctMultiplier: meterById[r.meterId].ctMultiplier.toString(),
  }))

  const production: ProductionRow[] = prodRows.map((p) => ({
    line: lineById[p.lineId],
    unitCode: p.unitCode as UnitCode,
    prodDate: iso(p.prodDate),
    quantity: p.quantity.toString(),
    tongKosong: p.tongKosong.toString(),
    focQuantity: p.focQuantity.toString(),
    quantitySource: p.quantitySource,
  }))

  const units: UnitRow[] = unitRows.map((u) => ({
    line: lineById[u.lineId],
    unitCode: u.unitCode as UnitCode,
    kgPerUnit: u.kgPerUnit ? u.kgPerUnit.toString() : null,
    effectiveFrom: iso(u.effectiveFrom),
  }))

  const assumptions = new Assumptions(
    assumptionRows.map((a) => ({
      key: a.key, effectiveFrom: iso(a.effectiveFrom),
      value: a.value.toString(), measured: a.measured,
    }))
  )

  const billPeriods: BillPeriod[] = bills.map((b) => ({
    accountNo: b.account.accountNo,
    periodStart: iso(b.periodStart),
    periodEnd: iso(b.periodEnd),
    kwh: b.kwh.toString(),
    currentChargesRm: (b.currentChargesRm ?? b.totalRm).toString(),
    confirmed: b.status === 'CONFIRMED',
  }))

  // The most recent confirmed period's volumes are the estimate the AFA
  // forecast uses. Volume barely moves the rate; only AFA does.
  const latest = billPeriods.filter((b) => b.confirmed).sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : -1))
  const estimated = [...new Set(latest.map((b) => b.accountNo))]
    .map((acct) => latest.find((b) => b.accountNo === acct)!.kwh)

  const rates = buildDailyRateSeries(from, to, {
    bills: billPeriods,
    publishedAfa: Object.fromEntries(afa.map((a) => [iso(a.periodMonth), a.ratePerKwh.toString()])),
    estimatedKwhPerAccount: estimated,
  })

  const rows = recompute({ from, to, readings, production, units, assumptions, rates })

  // The register outranks everything: it needs no divisor and it knows who
  // actually occupied each room. A month with register rows uses them even when
  // a ringgit compilation also exists for that month.
  const registerByMonth = new Map<string, typeof registerRows>()
  for (const r of registerRows) {
    const m = iso(r.periodMonth).slice(0, 7)
    registerByMonth.set(m, [...(registerByMonth.get(m) ?? []), r])
  }
  const asRegister = (month: string) =>
    (registerByMonth.get(month) ?? []).map((r) => ({
      roomCode: r.roomCode,
      tenantLabel: r.tenantLabel,
      ownUse: r.ownUse,
      rentInclusive: r.rentInclusive,
      openingKwh: r.openingKwh.toString(),
      closingKwh: r.closingKwh.toString(),
    }))

  const coldroomMonths = [
    ...new Set([
      ...coldroomRows.map((c) => iso(c.periodMonth).slice(0, 7)),
      ...registerByMonth.keys(),
    ]),
  ].sort()
  const compilationByMonth = new Map(
    coldroomRows.map((c) => [iso(c.periodMonth).slice(0, 7), c])
  )
  const coldroom: ColdroomMonthRow[] = coldroomMonths.map((month) => {
    const c = compilationByMonth.get(month)
    const register = asRegister(month)
    return {
      month,
      register: register.length ? register : null,
      meteredKwh: c?.meteredKwh ? c.meteredKwh.toString() : null,
      ratonoRm: c ? c.ratonoRm.toString() : '0',
      yemintRm: c ? c.yemintRm.toString() : '0',
      iceStoreInvoicedRm: c ? c.iceStoreInvoicedRm.toString() : '0',
    }
  })
  const water: WaterMonthRow[] = waterRows.map((w) => ({
    month: iso(w.periodMonth).slice(0, 7),
    tonnes: w.tonnes.toString(),
    retailM3: w.retailM3.toString(),
  }))

  const energyRows = recomputeEnergyUses({
    from, to, rates, assumptions, lineCosts: rows, coldroom, water,
  })

  const lineIdByCode = Object.fromEntries(lines.map((l) => [l.code, l.id]))
  for (const r of rows) {
    const lineId = lineIdByCode[r.line]
    const data = {
      kwh: new Prisma.Decimal(r.kwh.toString()),
      kwhSource: r.kwhSource,
      kg: new Prisma.Decimal(r.kg.toString()),
      focKg: new Prisma.Decimal(r.focKg.toString()),
      spansDays: r.spansDays,
      fromConvention: r.fromConvention,
      rateRmPerKwh: new Prisma.Decimal(r.ratePerKwh.toString()),
      rateBasis: r.rateBasis,
      costRm: new Prisma.Decimal(r.costRm.toString()),
      status: r.status,
      computedAt: new Date(),
    }
    await prisma.dailyLineCost.upsert({
      where: { costDate_lineId: { costDate: date(r.costDate), lineId } },
      create: { costDate: date(r.costDate), lineId, ...data },
      update: data,
    })
  }

  // Replace the window wholesale rather than upserting row by row. These rows
  // are entirely derived, so there is nothing in them worth preserving, and a
  // clean sweep is the only way a consumer that no longer has an input stops
  // claiming kWh — delete a coldroom month and its daily rows must go with it.
  // In one transaction, so a failure cannot leave the range half-emptied.
  await prisma.$transaction([
    prisma.dailyEnergyUse.deleteMany({
      where: { costDate: { gte: date(from), lte: date(to) } },
    }),
    prisma.dailyEnergyUse.createMany({
      data: energyRows.map((r) => ({
        costDate: date(r.costDate),
        useCode: r.useCode,
        kwh: new Prisma.Decimal(r.kwh.toString()),
        kwhSource: r.kwhSource,
        basis: r.basis,
        rateRmPerKwh: new Prisma.Decimal(r.ratePerKwh.toString()),
        rateBasis: r.rateBasis,
        costRm: new Prisma.Decimal(r.costRm.toString()),
        status: r.status,
      })),
    }),
  ])

  const byStatus = rows.reduce<Record<string, number>>((a, r) => {
    a[r.status] = (a[r.status] ?? 0) + 1
    return a
  }, {})
  console.log(`Recomputed ${rows.length} daily line costs, ${from} to ${to}`)
  console.log(`  ${energyRows.length} daily energy-use rows across ${new Set(energyRows.map((r) => r.useCode)).size} consumer(s)`)
  console.log(`  ${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join('  ')}`)
  const gaps = rows.filter((r) => r.spansDays > 1)
  if (gaps.length) {
    console.log(`  ${gaps.length} day(s) carry a multi-day meter delta (missed entry)`)
  }

  if (args.includes('--summary')) {
    console.log('\nMonthly cost of ice:')
    console.table(
      summariseMonths(rows, {
        energyUses: energyRows,
        countsAsIce: Object.fromEntries(
          energyUseRefs.map((u) => [u.code as EnergyUseCode, u.countsAsIce])
        ),
      }).map((m) => ({
        month: m.month,
        ice_kWh: m.iceKwh.toNumber(),
        support_kWh: m.supportKwh.toNumber(),
        ice_kg: m.iceKg.toNumber(),
        cost_RM: m.iceCostRm.toNumber(),
        kWh_per_kg: m.kwhPerKg.toFixed(4),
        RM_per_kg: m.rmPerKg ? m.rmPerKg.toFixed(4) : 'no rate',
        FOC_kg: m.focKg.toNumber(),
        days: m.daysWithData,
        uncosted: m.daysWithoutRate,
        status: m.status,
      }))
    )
  }
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
