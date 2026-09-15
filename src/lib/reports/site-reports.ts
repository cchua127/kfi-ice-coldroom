/**
 * The six reports the owner's LIVE cost template adds.
 *
 * The seven in builders.ts answer "what happened on the ice lines". These
 * answer the questions the template was written to ask: where the rest of the
 * electricity went, which machine is drifting, what the free ice cost, whether
 * the coldroom still pays, which channels are worth having, and whether the
 * month can be closed at all.
 *
 * Same ReportTable shape as everything else, so the screen, the Excel export
 * and the printed page stay one implementation rendered three ways.
 */
import { PrismaClient, type EnergyUseCode as PrismaEnergyUseCode } from '@prisma/client'
import { Decimal, d, rm } from '../money'
import { siteRate } from '../tariff'
import { Assumptions } from '../domain'
import { siteStatement, type EnergyUseCode, type StatementLine } from '../site-energy'
import {
  machineEfficiency,
  focWatch,
  coldroomRecovery,
  channelMargin,
  pasarKg,
  sellableKg,
} from '../analytics'
import { monthCloseChecks, countBy, type CheckResult } from '../checks'
import type { Report, ReportRow, ReportTable } from './types'

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
const prevMonth = (m: string) => {
  const [y, mm] = m.split('-').map(Number)
  return new Date(Date.UTC(y, mm - 2, 1)).toISOString().slice(0, 7)
}
const num = (v: Decimal | null) => (v === null ? null : Number(v))
const sum = <T>(xs: T[], f: (x: T) => Decimal | string | number) =>
  xs.reduce<Decimal>((a, x) => a.plus(d(f(x) as never)), d(0))

const LINE_LABELS: Record<string, string> = {
  TUBE: 'Tube ice',
  BIG_POOL: 'Big pool',
  BIMC: 'China machine',
  SMALL_POOL: 'Old small pool',
}

/**
 * Everything a month needs, loaded once.
 *
 * Six reports over one query set rather than six query sets: two reports
 * disagreeing about the same month because one of them filtered differently is
 * a failure mode worth designing out.
 */
async function monthly(month: string) {
  const [
    bills, costs, energy, energyRefs, lines, production, cash, sales, purchases,
    coldroomRow, register, assumptionRows, products,
  ] = await Promise.all([
    prisma.tnbBill.findMany({
      where: { periodStart: { gte: monthStart(month), lte: monthEnd(month) } },
      include: { account: true },
    }),
    prisma.dailyLineCost.findMany({
      where: { costDate: { gte: monthStart(month), lte: monthEnd(month) } },
    }),
    prisma.dailyEnergyUse.findMany({
      where: { costDate: { gte: monthStart(month), lte: monthEnd(month) } },
    }),
    prisma.energyUse.findMany(),
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
    prisma.coldroomMonthly.findUnique({ where: { periodMonth: monthStart(month) } }),
    prisma.coldroomReading.findMany({
      where: { periodMonth: monthStart(month) },
      orderBy: { rowNo: 'asc' },
    }),
    prisma.costAssumption.findMany(),
    prisma.product.findMany(),
  ])

  const lineCode = Object.fromEntries(lines.map((l) => [l.id, l.code as string]))
  const assumptions = new Assumptions(
    assumptionRows.map((a) => ({
      key: a.key,
      effectiveFrom: iso(a.effectiveFrom),
      value: a.value.toString(),
      measured: a.measured,
    }))
  )

  const billedKwh = sum(bills, (b) => b.kwh)
  const billedRm = sum(bills, (b) => b.currentChargesRm ?? b.totalRm)
  // Blend from the reconstructed bills rather than dividing two keyed totals:
  // the reconstruction is what ties to the printed bill to the cent.
  const rate = bills.length
    ? siteRate(
        bills.map((b) => ({
          kwh: b.kwh.toString(),
          currentChargesRm: (b.currentChargesRm ?? b.totalRm).toString(),
        }))
      )
    : d(0)

  const countsAsIce = Object.fromEntries(
    energyRefs.map((u) => [u.code as EnergyUseCode, u.countsAsIce])
  ) as Partial<Record<EnergyUseCode, boolean>>
  const useLabel = Object.fromEntries(energyRefs.map((u) => [u.code as EnergyUseCode, u.name]))

  // Per line, and per consumer.
  const byLine = new Map<string, { kwh: Decimal; kg: Decimal; focKg: Decimal; rm: Decimal; source: string }>()
  for (const c of costs) {
    const code = lineCode[c.lineId]
    const v = byLine.get(code) ?? { kwh: d(0), kg: d(0), focKg: d(0), rm: d(0), source: c.kwhSource }
    byLine.set(code, {
      kwh: v.kwh.plus(c.kwh),
      kg: v.kg.plus(c.kg),
      focKg: v.focKg.plus(c.focKg),
      rm: v.rm.plus(c.costRm),
      source: c.kwhSource,
    })
  }
  const byUse = new Map<
    EnergyUseCode,
    { kwh: Decimal; rm: Decimal; source: string; bases: Set<string>; days: number }
  >()
  for (const e of energy) {
    const code = e.useCode as EnergyUseCode
    const v = byUse.get(code) ?? { kwh: d(0), rm: d(0), source: e.kwhSource, bases: new Set<string>(), days: 0 }
    v.bases.add(e.basis)
    byUse.set(code, {
      kwh: v.kwh.plus(e.kwh),
      rm: v.rm.plus(e.costRm),
      source: e.kwhSource,
      bases: v.bases,
      days: v.days + 1,
    })
  }

  /**
   * One derivation string for a month of daily rows.
   *
   * A consumer on a standing load writes the same basis every day, so the
   * month's basis is that string. One struck against the day's own production —
   * ice-feed water — writes a different string every day, and picking the last
   * one would print a single day's tonnage against a monthly total. Say that it
   * varies, and give the count.
   */
  const monthBasis = (v: { bases: Set<string>; days: number }): string => {
    const all = [...v.bases]
    if (all.length === 1) return all[0]
    return `varies by day (${v.days} days) — e.g. ${all[all.length - 1]}`
  }

  const statement = siteStatement({
    billedKwh,
    billedRm,
    productionLines: [...byLine.entries()].map(([code, v]) => ({
      code,
      label: LINE_LABELS[code] ?? code,
      kwh: v.kwh,
      source: v.source as 'METERED' | 'MODELLED',
      basis: v.source === 'METERED' ? 'sub-meter' : 'modelled',
      // The ringgit already stored against those days, each costed at its own
      // day's rate. Passing it is what makes this statement agree with the
      // cost-of-ice report to the sen.
      costRm: v.rm,
    })),
    energyUses: [...byUse.entries()].map(([useCode, v]) => ({
      useCode,
      kwh: v.kwh,
      kwhSource: v.source as 'METERED' | 'MODELLED',
      basis: monthBasis(v),
      costRm: v.rm,
    })),
    countsAsIce,
    labels: useLabel as Partial<Record<EnergyUseCode, string>>,
  })

  const kgPerUnit = Object.fromEntries(
    products.map((p) => [p.code, p.kgPerUnit ? d(p.kgPerUnit) : null])
  )

  return {
    month,
    days: daysIn(month),
    bills,
    costs,
    energy,
    energyRefs,
    lineCode,
    production,
    cash,
    sales,
    purchases,
    coldroomRow,
    register,
    assumptions,
    kgPerUnit,
    billedKwh,
    billedRm,
    rate,
    byLine,
    byUse,
    statement,
    countsAsIce,
    useLabel,
  }
}

type Ctx = Awaited<ReturnType<typeof monthly>>

/**
 * Where this month's coldroom figures came from. One function, because three
 * reports and a check all need the same answer and a disagreement between them
 * would be worse than any of them being wrong.
 */
const coldroomProvenance = (ctx: Ctx): 'REGISTER' | 'WHOLE_METER' | 'BACK_INFERRED' | 'NONE' =>
  ctx.register.length ? 'REGISTER'
  : !ctx.coldroomRow ? 'NONE'
  : ctx.coldroomRow.meteredKwh !== null ? 'WHOLE_METER'
  : 'BACK_INFERRED'

const statusOf = (ctx: Ctx) => {
  const all = [...ctx.costs, ...ctx.energy]
  if (!all.length) return undefined
  if (all.every((c) => c.rateBasis === 'NO_RATE')) return 'NO_RATE' as const
  const anyProvisional = all.some((c) => c.status === 'PROVISIONAL')
  const anyFinal = all.some((c) => c.status === 'FINAL')
  return anyProvisional && anyFinal
    ? ('MIXED' as const)
    : anyProvisional
      ? ('PROVISIONAL' as const)
      : ('FINAL' as const)
}

const meta = (ctx: Ctx, slug: string, name: string) => ({
  slug,
  name,
  period: ctx.month,
  generatedAt: new Date().toISOString(),
  status: statusOf(ctx),
})

// ---------------------------------------------------------------------------
// 8. Site energy statement — every kWh named, at the month's actual tariff
// ---------------------------------------------------------------------------
export async function siteEnergyReport(month: string): Promise<Report> {
  const ctx = await monthly(month)
  const s = ctx.statement

  const order = (l: StatementLine) => (l.countsAsIce ? 0 : 1)
  const lines = [...s.lines].sort((a, b) => order(a) - order(b) || b.kwh.comparedTo(a.kwh))

  const rows: ReportRow[] = lines.map((l) => ({
    cells: {
      line: l.label,
      ice: l.countsAsIce ? 'ice' : '—',
      kwh: Number(l.kwh),
      share: l.share === null ? null : Number(l.share),
      source: l.kwhSource === 'METERED' ? 'metered' : 'modelled',
      basis: l.basis,
      rm: Number(l.costRm),
    },
  }))

  rows.push({
    emphasis: true,
    cells: {
      line: 'Unaccounted',
      ice: '—',
      kwh: Number(s.unallocatedKwh),
      share: s.unallocatedShare === null ? null : Number(s.unallocatedShare),
      source: 'residual',
      basis: 'billed consumption less every line above',
      rm: Number(s.unallocatedRm),
    },
  })
  rows.push({
    emphasis: true,
    cells: {
      line: 'BILLED SITE CONSUMPTION',
      ice: '',
      kwh: Number(s.billedKwh),
      share: s.billedKwh.isZero() ? null : 1,
      source: 'TNB bill',
      basis: ctx.bills.map((b) => b.account.accountNo).join(' + ') || 'no bill on file',
      rm: Number(s.billedRm),
    },
  })

  const notes = [
    'The residual is a line of its own and is never charged to ice. Using "Ice" ' +
      'as the balancing figure is what loaded every site-wide tariff rise onto ' +
      'cost of ice in the old report.',
    `Ice this month is ${Number(s.iceKwh).toLocaleString('en-MY')} kWh — RM` +
      `${Number(s.iceRm).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` +
      ' — being the lines marked "ice" above, and nothing else.',
  ]
  if (!s.tieOutKwh.isZero()) {
    notes.push(
      `TIE-OUT BREAK: the lines and the residual miss billed consumption by ` +
        `${s.tieOutKwh.toFixed(2)} kWh. This should be impossible; report it.`
    )
  }
  if (Math.abs(Number(s.unexplainedRm)) >= 0.005) {
    notes.push(
      `RM${s.unexplainedRm.toFixed(2)} of the bill is on neither a named line nor ` +
        'the residual. A few sen is per-line rounding; more than that means a bill ' +
        'period straddles the month and its days carry two different rates.'
    )
  }
  if (!ctx.bills.length) {
    notes.push(
      'No TNB bill for this month yet, so there is nothing to allocate against ' +
        'and every share is blank. Consumption still stands.'
    )
  }
  const backInferred = coldroomProvenance(ctx) === 'BACK_INFERRED'
  if (backInferred) {
    notes.push(
      'Coldroom kWh is back-inferred from the ringgit compilations at the frozen ' +
        'RM0.484/kWh factor, not read from the sub-meter. Both coldroom lines ' +
        'inherit that stale rate.'
    )
  }

  return {
    meta: meta(ctx, 'site-energy', 'Site energy statement'),
    tables: [
      {
        title: 'Where the electricity went',
        subtitle: `${month}, at the month's blended tariff of ${ctx.rate.toFixed(5)} RM/kWh`,
        columns: [
          { key: 'line', label: 'Consumer', type: 'text', width: 30 },
          { key: 'ice', label: 'Ice?', type: 'text', width: 7 },
          { key: 'kwh', label: 'kWh', type: 'int', width: 13 },
          { key: 'share', label: 'Share of bill', type: 'percent', width: 13 },
          { key: 'source', label: 'Source', type: 'text', width: 11 },
          { key: 'basis', label: 'How it was derived', type: 'text', width: 52 },
          { key: 'rm', label: 'RM', type: 'money', width: 14 },
        ],
        rows,
        notes,
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// 9. Efficiency by machine
// ---------------------------------------------------------------------------
export async function efficiencyReport(month: string): Promise<Report> {
  const ctx = await monthly(month)
  const prev = prevMonth(month)
  const before = await prisma.dailyLineCost.findMany({
    where: { costDate: { gte: monthStart(prev), lte: monthEnd(prev) } },
  })
  const priorByLine = new Map<string, { kwh: Decimal; kg: Decimal }>()
  for (const c of before) {
    const code = ctx.lineCode[c.lineId]
    const v = priorByLine.get(code) ?? { kwh: d(0), kg: d(0) }
    priorByLine.set(code, { kwh: v.kwh.plus(c.kwh), kg: v.kg.plus(c.kg) })
  }

  // The big pool cannot freeze without the brine compressor, so its intensity
  // is meaningless without it. Attributing the compressor here is the same
  // decision the statement makes when it counts it as ice.
  const compressorKwh = ctx.byUse.get('BRINE_COMPRESSOR')?.kwh ?? d(0)

  const rows: ReportRow[] = []
  for (const [code, v] of [...ctx.byLine.entries()].sort()) {
    const withSupport = code === 'BIG_POOL' ? v.kwh.plus(compressorKwh) : v.kwh
    const eff = machineEfficiency(
      {
        line: code,
        label: LINE_LABELS[code] ?? code,
        kwh: withSupport,
        producedKg: v.kg,
        focKg: v.focKg,
        kwhSource: v.source as 'METERED' | 'MODELLED',
      },
      ctx.rate
    )
    const p = priorByLine.get(code)
    const priorKwh = p && code === 'BIG_POOL' ? p.kwh.plus(compressorKwh) : p?.kwh
    rows.push({
      cells: {
        line: eff.label + (code === 'BIG_POOL' ? ' (incl. compressor)' : ''),
        source: eff.kwhSource === 'METERED' ? 'metered' : 'modelled',
        kwh: Number(eff.kwh),
        kg: Number(eff.producedKg),
        focKg: Number(eff.focKg),
        kwhPerKg: num(eff.kwhPerKg),
        rmPerKg: num(eff.rmPerKg),
        netKwhPerKg: eff.focKg.isZero() ? null : num(eff.netKwhPerKg),
        netRmPerKg: eff.focKg.isZero() ? null : num(eff.netRmPerKg),
        priorKwhPerKg: p && priorKwh && !p.kg.isZero() ? Number(priorKwh.dividedBy(p.kg)) : null,
      },
    })
  }

  return {
    meta: meta(ctx, 'efficiency', 'Efficiency by machine'),
    tables: [
      {
        title: 'kWh and RM per kilogram, by line',
        subtitle: `${month}, against ${prev}`,
        columns: [
          { key: 'line', label: 'Line', type: 'text', width: 28 },
          { key: 'source', label: 'Source', type: 'text', width: 10 },
          { key: 'kwh', label: 'kWh', type: 'int', width: 12 },
          { key: 'kg', label: 'Produced kg', type: 'int', width: 13 },
          { key: 'focKg', label: 'of which FOC', type: 'int', width: 13 },
          { key: 'kwhPerKg', label: 'kWh per kg', type: 'ratio3', width: 12 },
          { key: 'rmPerKg', label: 'RM per kg', type: 'rate4', width: 12 },
          {
            key: 'netKwhPerKg',
            label: 'kWh/kg net of FOC',
            type: 'ratio3',
            width: 16,
            note: 'Over sellable kilograms, when FOC is recorded on the line.',
          },
          { key: 'netRmPerKg', label: 'RM/kg net of FOC', type: 'rate4', width: 15 },
          { key: 'priorKwhPerKg', label: `${prev} kWh/kg`, type: 'ratio3', width: 13 },
        ],
        rows,
        notes: [
          'The big pool carries the 30HP brine compressor, without which it does ' +
            'not freeze. Its intensity is not comparable to a line quoted bare.',
          'Gross and net of FOC are both shown because which is right depends on ' +
            'whether the free blocks are defects or shrinkage — an open question.',
          'A flat kWh/kg with a rising RM/kg is the tariff, not the plant.',
        ],
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// 10. FOC watch
// ---------------------------------------------------------------------------
export async function focWatchReport(month: string): Promise<Report> {
  const ctx = await monthly(month)

  /** Units sold of a product, from the sales ledger. Null when none recorded. */
  const soldOf = (productCode: string): Decimal | null => {
    const rows = ctx.sales.filter((s) => s.product.code === productCode)
    return rows.length ? sum(rows, (s) => s.quantity) : null
  }

  const rows: ReportRow[] = []
  const notes: string[] = []

  const specs: { line: string; unit: string; product: string; kwhKey: string }[] = [
    { line: 'BIMC', unit: 'SMALL_TONG', product: 'SMALL_BLOCK_BIMC', kwhKey: 'bimc_kwh_per_block' },
  ]

  for (const spec of specs) {
    const prod = ctx.production.filter(
      (p) => ctx.lineCode[p.lineId] === spec.line && p.unitCode === spec.unit
    )
    if (!prod.length) continue

    const produced = sum(prod, (p) => p.quantity)
    const foc = sum(prod, (p) => p.focQuantity)
    const kgPerUnit = ctx.kgPerUnit[spec.product] ?? d(45)
    const sold = soldOf(spec.product)

    // The realised price, from the sales actually recorded — never a list price.
    const soldRows = ctx.sales.filter((s) => s.product.code === spec.product)
    const soldRm = sum(soldRows, (s) => s.amount)
    const unitPrice = sold && !sold.isZero() ? soldRm.dividedBy(sold) : null

    const watch = focWatch({
      producedUnits: produced,
      soldUnits: sold,
      focUnits: foc,
      kgPerUnit,
      kwhPerUnit: ctx.assumptions.at(spec.kwhKey, `${month}-01`),
      ratePerKwh: ctx.rate,
      unitPriceRm: unitPrice,
    })

    rows.push({
      cells: {
        line: LINE_LABELS[spec.line] ?? spec.line,
        produced: Number(watch.producedUnits),
        sold: num(watch.soldUnits),
        foc: Number(watch.focUnits),
        focTonnes: Number(watch.focTonnes),
        focShare: num(watch.focShareOfMoved),
        electricity: Number(watch.electricityInFocRm),
        revenue: num(watch.revenueForgoneRm),
        gap: num(watch.ledgerGapUnits),
      },
    })

    if (watch.soldUnits === null) {
      notes.push(
        `No ${LINE_LABELS[spec.line]} unit sales are recorded for this month, so the ` +
          'share of blocks moved, the revenue forgone and the ledger gap cannot be ' +
          'struck. They are blank rather than zero.'
      )
    }
  }

  if (!rows.length) {
    notes.push('No line recorded FOC quantities this month.')
  }
  notes.push(
    'Net-of-FOC cost per kilogram is the true figure IF the free blocks are ' +
      'genuine defects. If they are shrinkage the ice was saleable and the damage ' +
      'is the revenue forgone instead. The monthly ringgit impact is similar ' +
      'either way; the remedy is not.',
    'FOC on the big pool sits in the worker ledger and FOC on the tube plant is ' +
      'not recorded anywhere, so this report covers only the lines that record it.'
  )

  return {
    meta: meta(ctx, 'foc-watch', 'FOC and defect watch'),
    tables: [
      {
        title: 'Ice given away free',
        subtitle: month,
        columns: [
          { key: 'line', label: 'Line', type: 'text', width: 18 },
          { key: 'produced', label: 'Produced (units)', type: 'int', width: 15 },
          { key: 'sold', label: 'Sold (units)', type: 'int', width: 13 },
          { key: 'foc', label: 'FOC (units)', type: 'int', width: 12 },
          { key: 'focTonnes', label: 'FOC tonnes', type: 'ratio3', width: 12 },
          { key: 'focShare', label: 'FOC % of moved', type: 'percent', width: 14 },
          { key: 'electricity', label: 'Electricity in FOC RM', type: 'money', width: 18 },
          { key: 'revenue', label: 'Revenue forgone RM', type: 'money', width: 18 },
          {
            key: 'gap',
            label: 'Ledger gap (units)',
            type: 'int',
            width: 16,
            note: 'Made, less sold, less given away. A control question, not a costing one.',
          },
        ],
        rows,
        notes,
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// 11. Coldroom recovery
// ---------------------------------------------------------------------------
export async function coldroomReport(month: string): Promise<Report> {
  const ctx = await monthly(month)
  const tenantKwh = ctx.byUse.get('COLDROOM_TENANT')?.kwh ?? d(0)
  const storeKwh = ctx.byUse.get('COLDROOM_ICE_STORE')?.kwh ?? d(0)
  const tenantRate = ctx.assumptions.at('tenant_billing_rate_rm_per_kwh', `${month}-01`)
  const recovery = coldroomRecovery(tenantKwh, ctx.rate, tenantRate)

  // A month with no confirmed bill has no blended rate, and `ctx.rate` is zero
  // rather than absent. Every figure struck against it must therefore read as
  // BLANK, not as zero: a zero cost turns the whole recharge into margin and
  // prints "RM30,597 margin" on a month nobody has costed yet. The rooms and
  // the recharge are still real and still shown — it is only the comparison
  // against cost that is unavailable.
  const costed = ctx.bills.length > 0 && !ctx.rate.isZero()
  const atCost = (kwh: Decimal) => (costed ? Number(rm(kwh.times(ctx.rate))) : null)

  const rows: ReportRow[] = [
    {
      cells: {
        item: 'Tenant rooms',
        kwh: Number(recovery.tenantKwh),
        cost: atCost(recovery.tenantKwh),
        billed: Number(recovery.billedRm),
        margin: costed ? Number(recovery.marginRm) : null,
        perKwh: costed ? Number(recovery.marginPerKwh) : null,
      },
    },
    {
      cells: {
        item: 'Rooms KFI occupies',
        kwh: Number(storeKwh),
        cost: atCost(storeKwh),
        billed: Number(rm(storeKwh.times(tenantRate))),
        margin: null,
        perKwh: null,
      },
    },
    {
      emphasis: true,
      cells: {
        item: 'Whole coldroom',
        kwh: Number(tenantKwh.plus(storeKwh)),
        cost: atCost(tenantKwh.plus(storeKwh)),
        billed: null,
        margin: null,
        perKwh: null,
      },
    },
  ]

  const spread: ReportRow[] = [
    {
      cells: {
        item: 'Tenant billing rate',
        value: Number(tenantRate),
        note: 'Fixed by contract. Does not move when AFA does.',
      },
    },
    {
      cells: {
        item: "This month's blended tariff",
        value: costed ? Number(ctx.rate) : null,
        note: costed
          ? 'What the power actually cost, from the reconstructed bills.'
          : 'No confirmed bill for this month, so what the power cost is not yet known.',
      },
    },
    {
      emphasis: true,
      cells: {
        item: 'Spread',
        value: costed ? Number(recovery.marginPerKwh) : null,
        note: !costed
          ? 'Cannot be struck until the month is billed.'
          : recovery.underwater
            ? 'NEGATIVE. Every kWh resold to a tenant now loses money.'
            : 'Positive, and shrinking every month AFA rises.',
      },
    },
  ]

  const provenance = coldroomProvenance(ctx)
  const notes: string[] = []
  if (!costed) {
    notes.push(
      'NOT COSTED. There is no confirmed TNB bill for this month, so the cost ' +
        'and margin columns are blank rather than zero. What the tenants were ' +
        'billed is known; what the power cost is not.'
    )
  }
  notes.push(
    "The rooms KFI occupies hold this plant's own ice and are recharged " +
      'internally, so their margin is a transfer and is left blank rather than ' +
      'counted as profit.',
    'Reselling power at a fixed rate while buying it at a floating one is a ' +
      'short position on the tariff. The spread above is the whole of it.'
  )
  if (provenance === 'NONE') {
    notes.push(
      'NO COLDROOM FIGURES FOR THIS MONTH. Everything above reads zero because ' +
        'nothing was entered, not because nothing was consumed — the whole ' +
        'coldroom load is sitting in the unaccounted residual on the site energy ' +
        'statement.'
    )
  } else if (provenance === 'BACK_INFERRED') {
    notes.push(
      'Coldroom kWh is BACK-INFERRED: the ringgit compilations divided by the ' +
        'frozen RM0.484/kWh factor, because no register was read. Recovering a ' +
        'quantity from a price is circular, and the quantity is only as good as a ' +
        'rate that has been stale since July 2025. Read the register.'
    )
  } else if (provenance === 'REGISTER') {
    notes.push(
      `Read from the register: ${ctx.register.length} rooms, each with its own ` +
        'meter. No divisor, no convention.'
    )
  }

  // Room by room, when the register was read. This is the detail the office
  // invoices from, and the only place a room that stopped consuming becomes
  // visible before a tenant queries their bill.
  const roomTables: ReportTable[] = []
  if (ctx.register.length) {
    const roomRows: ReportRow[] = ctx.register.map((r) => {
      const usage = d(r.closingKwh).minus(r.openingKwh)
      const rate = d(r.rateRmPerKwh)
      return {
        cells: {
          room: r.roomCode,
          tenant: r.ownUse ? 'KFI (own use)' : (r.tenantLabel ?? '— vacant —'),
          opening: Number(r.openingKwh),
          closing: Number(r.closingKwh),
          usage: Number(usage),
          rate: Number(rate),
          amount: Number(rm(usage.times(rate))),
          group: r.usageGroup === null ? '' : `Usage ${r.usageGroup}`,
        },
      }
    })
    const regTotal = ctx.register.reduce<Decimal>(
      (a, r) => a.plus(d(r.closingKwh).minus(r.openingKwh)), d(0)
    )
    const regOwn = ctx.register.filter((r) => r.ownUse).reduce<Decimal>(
      (a, r) => a.plus(d(r.closingKwh).minus(r.openingKwh)), d(0)
    )
    roomRows.push({
      emphasis: true,
      cells: {
        room: 'TOTAL', tenant: `${ctx.register.length} rooms`,
        opening: null, closing: null,
        usage: Number(regTotal), rate: null,
        amount: Number(rm(regTotal.times(tenantRate))), group: '',
      },
    })

    const idle = ctx.register.filter((r) => d(r.closingKwh).minus(r.openingKwh).isZero())
    const roomNotes = [
      `${Number(regOwn).toLocaleString('en-MY')} kWh of this is KFI's own, on the ` +
        'rooms the occupant column marks as KFI — not on a fixed list of room ' +
        'numbers. The two are not the same thing: a room KFI normally uses can be ' +
        'let out, and in March 2026 one was.',
    ]
    if (idle.length) {
      roomNotes.push(
        `${idle.length} room(s) recorded no consumption at all: ` +
          `${idle.map((r) => r.roomCode).join(', ')}. Vacant, or a meter that was ` +
          'not read — the register cannot tell those apart.'
      )
    }
    roomTables.push({
      title: 'Room by room',
      subtitle: `${month}, as the register records it`,
      columns: [
        { key: 'room', label: 'Room', type: 'text', width: 8 },
        { key: 'tenant', label: 'Occupant', type: 'text', width: 40 },
        { key: 'opening', label: 'Opening', type: 'int', width: 12 },
        { key: 'closing', label: 'Closing', type: 'int', width: 12 },
        { key: 'usage', label: 'kWh', type: 'int', width: 10 },
        { key: 'rate', label: 'Rate', type: 'rate4', width: 9 },
        { key: 'amount', label: 'Recharge RM', type: 'money', width: 14 },
        { key: 'group', label: 'Feeder', type: 'text', width: 10 },
      ],
      rows: roomRows,
      notes: roomNotes,
    })
  }

  return {
    meta: meta(ctx, 'coldroom', 'Coldroom recovery'),
    tables: [
      {
        title: 'Tenant rooms and the ice store',
        subtitle: month,
        columns: [
          { key: 'item', label: 'Rooms', type: 'text', width: 24 },
          { key: 'kwh', label: 'kWh', type: 'int', width: 13 },
          { key: 'cost', label: 'Cost at actual tariff', type: 'money', width: 18 },
          { key: 'billed', label: 'Billed at tenant rate', type: 'money', width: 18 },
          { key: 'margin', label: 'Margin RM', type: 'money', width: 13 },
          { key: 'perKwh', label: 'Margin RM/kWh', type: 'rate4', width: 14 },
        ],
        rows,
        notes,
      },
      {
        title: 'The spread',
        subtitle: 'What the margin is made of, and which half of it moves',
        columns: [
          { key: 'item', label: 'Component', type: 'text', width: 28 },
          { key: 'value', label: 'RM per kWh', type: 'rate4', width: 13 },
          { key: 'note', label: 'Detail', type: 'text', width: 52 },
        ],
        rows: spread,
      },
      ...roomTables,
    ],
  }
}

// ---------------------------------------------------------------------------
// 12. Sales by channel and margin over electricity
// ---------------------------------------------------------------------------
export async function salesMarginReport(month: string): Promise<Report> {
  const ctx = await monthly(month)

  const ICE = ['TUBE', 'BIG_POOL', 'BIMC', 'SMALL_POOL']
  const producedKg = [...ctx.byLine.entries()]
    .filter(([code]) => ICE.includes(code))
    .reduce<Decimal>((a, [, v]) => a.plus(v.kg), d(0))
  const focKg = [...ctx.byLine.entries()]
    .filter(([code]) => ICE.includes(code))
    .reduce<Decimal>((a, [, v]) => a.plus(v.focKg), d(0))

  // Bought-in ice moved through the counter too. Ocean's block size is not
  // confirmed anywhere, so this takes the BIG_BLOCK nominal and says so.
  const purchasedKg = sum(ctx.purchases, (p) => p.quantity).times(ctx.kgPerUnit.BIG_BLOCK ?? d(100))

  const kgOf = (s: (typeof ctx.sales)[number]): Decimal | null => {
    const per = s.product.kgPerUnit ? d(s.product.kgPerUnit) : null
    return per ? d(s.quantity).times(per) : null
  }

  const outside = ctx.sales.filter((s) => s.customer.channel === 'OUTSIDE')
  const counter = ctx.sales.filter((s) => s.customer.channel === 'PASAR')
  const outsideKg = outside.reduce<Decimal>((a, s) => a.plus(kgOf(s) ?? d(0)), d(0))

  const cashRm = ctx.cash.reduce<Decimal>((a, c) => a.plus(c.shift1).plus(c.shift2), d(0))
  const sellable = sellableKg(producedKg, focKg, purchasedKg)
  const pasar = pasarKg(sellable, outsideKg)

  const byCustomer = new Map<string, { rm: Decimal; kg: Decimal; anyUnknownKg: boolean }>()
  for (const s of outside) {
    const v = byCustomer.get(s.customer.name) ?? { rm: d(0), kg: d(0), anyUnknownKg: false }
    const kg = kgOf(s)
    byCustomer.set(s.customer.name, {
      rm: v.rm.plus(s.amount),
      kg: v.kg.plus(kg ?? d(0)),
      anyUnknownKg: v.anyUnknownKg || kg === null,
    })
  }

  const summary = channelMargin(
    [
      { channel: 'Pasar counter (cash)', revenueRm: cashRm, kg: pasar.isZero() ? null : pasar },
      ...[...byCustomer.entries()]
        .sort((a, b) => b[1].rm.comparedTo(a[1].rm))
        .map(([name, v]) => ({
          channel: name,
          revenueRm: v.rm,
          kg: v.anyUnknownKg || v.kg.isZero() ? null : v.kg,
        })),
    ],
    ctx.statement.iceKwh.isZero() || producedKg.isZero()
      ? null
      : ctx.statement.iceRm.dividedBy(producedKg).toDecimalPlaces(6),
    ctx.statement.iceRm
  )

  const rows: ReportRow[] = summary.rows.map((r) => ({
    cells: {
      channel: r.channel,
      revenue: Number(r.revenueRm),
      share: num(r.shareOfRevenue),
      kg: num(r.kg),
      realised: num(r.realisedRmPerKg),
      margin: num(r.marginOverElectricity),
    },
  }))
  rows.push({
    emphasis: true,
    cells: {
      channel: 'TOTAL',
      revenue: Number(summary.totalRevenueRm),
      share: summary.totalRevenueRm.isZero() ? null : 1,
      kg: Number(summary.totalKg),
      realised: summary.totalKg.isZero()
        ? null
        : Number(summary.totalRevenueRm.dividedBy(summary.totalKg)),
      margin: null,
    },
  })

  const bridge: ReportRow[] = [
    { cells: { item: 'Produced', kg: Number(producedKg), note: 'Every ice line, FOC included.' } },
    { cells: { item: 'less given away free', kg: -Number(focKg), note: 'Recorded FOC only.' } },
    {
      cells: {
        item: 'plus bought in',
        kg: Number(purchasedKg),
        note: purchasedKg.isZero()
          ? 'None this month.'
          : "At the 100 kg nominal — Ocean's block size is still unconfirmed.",
      },
    },
    { emphasis: true, cells: { item: 'Sellable', kg: Number(sellable), note: '' } },
    { cells: { item: 'less outside channels', kg: -Number(outsideKg), note: 'At each product\'s nominal weight.' } },
    {
      emphasis: true,
      cells: {
        item: 'Pasar counter, by difference',
        kg: Number(pasar),
        note: 'A residual: it absorbs every unrecorded sale upstream of it.',
      },
    },
  ]

  const tables: ReportTable[] = [
    {
      title: 'Revenue by channel',
      subtitle: `${month}. Margin is realised price less the electricity in a kilogram of ice — nothing else.`,
      columns: [
        { key: 'channel', label: 'Channel', type: 'text', width: 24 },
        { key: 'revenue', label: 'Revenue RM', type: 'money', width: 14 },
        { key: 'share', label: 'Share', type: 'percent', width: 10 },
        { key: 'kg', label: 'Kg moved', type: 'int', width: 13 },
        { key: 'realised', label: 'Realised RM/kg', type: 'rate4', width: 14 },
        {
          key: 'margin',
          label: 'Over electricity RM/kg',
          type: 'rate4',
          width: 19,
          note: 'NOT gross margin. No labour, water, depreciation or delivery.',
        },
      ],
      rows,
      notes: [
        'The margin column answers one question: does a channel cover the power ' +
          'it takes to freeze what it buys. Every channel clears that bar by a ' +
          'wide distance, so it ranks channels rather than prices them.',
        `Electricity was ${
          summary.electricityShareOfSales === null
            ? 'not measurable'
            : `${(Number(summary.electricityShareOfSales) * 100).toFixed(1)}%`
        } of what the ice sold for.`,
      ],
    },
    {
      title: 'How the pasar tonnage is arrived at',
      subtitle: 'The counter does not weigh what it sells, so it is a residual',
      columns: [
        { key: 'item', label: 'Step', type: 'text', width: 30 },
        { key: 'kg', label: 'Kg', type: 'int', width: 14 },
        { key: 'note', label: 'Detail', type: 'text', width: 52 },
      ],
      rows: bridge,
    },
  ]

  if (counter.length) {
    const counterRm = sum(counter, (s) => s.amount)
    tables.push({
      title: 'Counter cash against counter units',
      subtitle: 'What the ledger says was sold, priced out, against what the till took',
      columns: [
        { key: 'item', label: 'Item', type: 'text', width: 30 },
        { key: 'value', label: 'RM', type: 'money', width: 14 },
        { key: 'note', label: 'Detail', type: 'text', width: 52 },
      ],
      rows: [
        { cells: { item: 'Units sold, priced out', value: Number(counterRm), note: 'At the price in force on the day.' } },
        { cells: { item: 'Shift cash recorded', value: Number(cashRm), note: 'Shift 1 plus shift 2.' } },
        {
          emphasis: true,
          cells: {
            item: 'Difference',
            value: Number(cashRm.minus(counterRm)),
            note: 'Report R1 reconciles June to the ringgit; a gap here is a keying error.',
          },
        },
      ],
    })
  } else {
    tables[1].notes = [
      'Counter unit sales are not recorded for this month, so cash cannot be ' +
        'reconciled against what was sold and the pasar tonnage cannot be ' +
        'cross-checked against a price.',
    ]
  }

  return { meta: meta(ctx, 'sales-margin', 'Sales by channel and margin'), tables }
}

// ---------------------------------------------------------------------------
// 13. Month close
// ---------------------------------------------------------------------------
export async function monthCloseReport(month: string): Promise<Report> {
  const ctx = await monthly(month)
  const prev = prevMonth(month)
  const priorBills = await prisma.tnbBill.findMany({
    where: { periodStart: { gte: monthStart(prev), lte: monthEnd(prev) } },
  })
  const priorRate = priorBills.length
    ? siteRate(
        priorBills.map((b) => ({
          kwh: b.kwh.toString(),
          currentChargesRm: (b.currentChargesRm ?? b.totalRm).toString(),
        }))
      )
    : null

  const tenantKwh = ctx.byUse.get('COLDROOM_TENANT')?.kwh ?? d(0)
  const tenantRate = ctx.assumptions.at('tenant_billing_rate_rm_per_kwh', `${month}-01`)
  const provenance = coldroomProvenance(ctx)
  const hasColdroom = provenance !== 'NONE'

  const tube = ctx.byLine.get('TUBE')
  const pool = ctx.byLine.get('BIG_POOL')
  const compressorKwh = ctx.byUse.get('BRINE_COMPRESSOR')?.kwh ?? d(0)

  const bimc = ctx.production.filter((p) => ctx.lineCode[p.lineId] === 'BIMC')
  const bimcProduced = sum(bimc, (p) => p.quantity)
  const bimcFoc = sum(bimc, (p) => p.focQuantity)
  const bimcSoldRows = ctx.sales.filter((s) => s.product.code === 'SMALL_BLOCK_BIMC')
  const bimcSold = bimcSoldRows.length ? sum(bimcSoldRows, (s) => s.quantity) : null

  const counter = ctx.sales.filter((s) => s.customer.channel === 'PASAR')
  const cashRm = ctx.cash.reduce<Decimal>((a, c) => a.plus(c.shift1).plus(c.shift2), d(0))

  const uncosted = new Set(
    [...ctx.costs, ...ctx.energy].filter((c) => c.rateBasis === 'NO_RATE').map((c) => iso(c.costDate))
  ).size

  const results: CheckResult[] = monthCloseChecks({
    month,
    daysInMonth: ctx.days,
    unexplainedRm: ctx.bills.length ? ctx.statement.unexplainedRm : null,
    tieOutKwh: ctx.bills.length ? ctx.statement.tieOutKwh : null,
    unallocatedKwh: ctx.bills.length ? ctx.statement.unallocatedKwh : null,
    coldroomPresent: hasColdroom,
    coldroomBackInferred: provenance === 'BACK_INFERRED',
    coldroomProvenance: provenance === 'NONE' ? undefined : provenance,
    coldroomMarginRm: hasColdroom
      ? coldroomRecovery(tenantKwh, ctx.rate, tenantRate).marginRm
      : null,
    focShare:
      bimcSold && !bimcSold.plus(bimcFoc).isZero()
        ? bimcFoc.dividedBy(bimcSold.plus(bimcFoc))
        : null,
    ledgerGapUnits: bimcSold ? bimcProduced.minus(bimcSold).minus(bimcFoc) : null,
    tubeKwhPerKg: tube && !tube.kg.isZero() ? tube.kwh.dividedBy(tube.kg) : null,
    poolKwhPerKg:
      pool && !pool.kg.isZero() ? pool.kwh.plus(compressorKwh).dividedBy(pool.kg) : null,
    ratePerKwh: ctx.bills.length ? ctx.rate : null,
    priorRatePerKwh: priorRate,
    counterCashRm: counter.length ? cashRm : null,
    counterPricedRm: counter.length ? sum(counter, (s) => s.amount) : null,
    daysWithoutRate: ctx.costs.length || ctx.energy.length ? uncosted : undefined,
    // Every stored daily row is one sen-rounding. The tie-out tolerance scales
    // with them rather than assuming the handful of lines it once had.
    storedRows: ctx.costs.length + ctx.energy.length,
  })

  const SYMBOL: Record<CheckResult['verdict'], string> = {
    OK: 'ok',
    FLAG: 'INVESTIGATE',
    NO_DATA: 'no data',
  }

  const rows: ReportRow[] = results.map((r) => ({
    emphasis: r.verdict === 'FLAG',
    cells: {
      check: r.label,
      verdict: SYMBOL[r.verdict],
      value: r.value === null ? null : Number(r.value),
      threshold: r.threshold === null ? null : Number(r.threshold),
      detail: r.detail,
    },
  }))

  const flags = countBy(results, 'FLAG')
  const missing = countBy(results, 'NO_DATA')

  return {
    meta: meta(ctx, 'month-close', 'Month close'),
    tables: [
      {
        title: flags
          ? `${flags} item(s) to investigate before closing ${month}`
          : missing
            ? `${month} cannot be closed yet — ${missing} check(s) have no data`
            : `${month} is ready to close`,
        subtitle:
          'A check with nothing to check is not a pass. Thresholds are in ' +
          'src/lib/checks.ts, named, with the reasoning attached.',
        columns: [
          { key: 'check', label: 'Check', type: 'text', width: 24 },
          { key: 'verdict', label: 'Verdict', type: 'text', width: 13 },
          { key: 'value', label: 'Measured', type: 'rate4', width: 13 },
          { key: 'threshold', label: 'Threshold', type: 'rate4', width: 12 },
          { key: 'detail', label: 'What it means', type: 'text', width: 70 },
        ],
        rows,
      },
    ],
  }
}

/** Exported for the enum's sake — keeps the Prisma type referenced. */
export type { PrismaEnergyUseCode }
