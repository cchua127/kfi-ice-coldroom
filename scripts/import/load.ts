/**
 * Stage 3: load the extracted workbooks into the database.
 *
 * Idempotent and re-runnable. `--dry-run` (the default) writes nothing and
 * prints what would change, so the mapping can be reviewed before anything
 * touches the data — including exactly which sheet mapped to which month.
 *
 *   npx tsx scripts/import/load.ts                # dry run
 *   npx tsx scripts/import/load.ts --write        # apply
 *   npx tsx scripts/import/load.ts --only meter-tube
 */
import { readFileSync, existsSync } from 'node:fs'
import { PrismaClient, Prisma } from '@prisma/client'
import { PARSERS, type ParseResult, type Issue } from '../../src/lib/import/parsers'
import { formatMappingLog } from '../../src/lib/import/sheet-names'
import type { Workbook } from '../../src/lib/import/extract-types'

const prisma = new PrismaClient()
const EXTRACT_DIR = process.env.EXTRACT_DIR ?? 'data/extract'

const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null
const date = (s: string) => new Date(`${s}T00:00:00.000Z`)
const dec = (n: number) => new Prisma.Decimal(n.toFixed(4))

interface Counts {
  meterReadings: number
  production: number
  cash: number
  outsideSales: number
  purchases: number
  coldroomReadings: number
  skipped: number
}

const zero = (): Counts => ({
  meterReadings: 0, production: 0, cash: 0,
  outsideSales: 0, purchases: 0, coldroomReadings: 0, skipped: 0,
})

function printIssues(issues: Issue[]) {
  const order = { ERROR: 0, WARN: 1, INFO: 2 } as const
  const grouped = new Map<string, Issue[]>()
  for (const i of issues) grouped.set(i.code, [...(grouped.get(i.code) ?? []), i])
  const codes = [...grouped.entries()].sort(
    (a, b) => order[a[1][0].level] - order[b[1][0].level]
  )
  for (const [code, list] of codes) {
    const { level } = list[0]
    console.log(`  ${level.padEnd(5)} ${code} (${list.length})`)
    for (const i of list.slice(0, 3)) {
      console.log(`          ${i.sheet}${i.row ? ` r${i.row}` : ''}: ${i.message}`)
    }
    if (list.length > 3) console.log(`          ... and ${list.length - 3} more`)
  }
}

async function load(key: string, parsed: ParseResult, counts: Counts) {
  const lines = Object.fromEntries(
    (await prisma.productionLine.findMany()).map((l) => [l.code, l.id])
  )
  const meters = Object.fromEntries(
    (await prisma.meter.findMany()).map((m) => [m.code, m.id])
  )
  const customers = Object.fromEntries(
    (await prisma.customer.findMany()).map((c) => [c.name, c.id])
  )
  const products = Object.fromEntries(
    (await prisma.product.findMany()).map((p) => [p.code, p.id])
  )

  // A reading derived from a "Mula" only fills a gap; a real "Akhir" for the
  // same date always wins, so drop the derived one where both exist.
  const realDates = new Set(
    parsed.meterReadings.filter((r) => !r.fromOpening).map((r) => `${r.meterCode}|${r.readingDate}`)
  )
  const readings = parsed.meterReadings.filter(
    (r) => !r.fromOpening || !realDates.has(`${r.meterCode}|${r.readingDate}`)
  )

  for (const r of readings) {
    const meterId = meters[r.meterCode]
    if (!meterId) { counts.skipped++; continue }
    counts.meterReadings++
    if (!WRITE) continue
    await prisma.meterReading.upsert({
      where: { readingDate_meterId: { readingDate: date(r.readingDate), meterId } },
      create: { readingDate: date(r.readingDate), meterId, closing: dec(r.closing) },
      update: { closing: dec(r.closing) },
    })
  }

  for (const p of parsed.production) {
    const lineId = lines[p.line]
    if (!lineId) { counts.skipped++; continue }
    counts.production++
    if (!WRITE) continue
    await prisma.productionDaily.upsert({
      where: {
        prodDate_lineId_shift_unitCode: {
          prodDate: date(p.prodDate), lineId, shift: 'UNSPLIT', unitCode: p.unitCode,
        },
      },
      create: {
        prodDate: date(p.prodDate), lineId, shift: 'UNSPLIT', unitCode: p.unitCode,
        quantity: dec(p.quantity), focQuantity: dec(p.focQuantity ?? 0),
        tongKosong: dec(p.tongKosong ?? 0),
        quantitySource: p.quantitySource ?? 'COUNTED', note: p.note ?? null,
      },
      update: {
        quantity: dec(p.quantity), focQuantity: dec(p.focQuantity ?? 0),
        tongKosong: dec(p.tongKosong ?? 0),
        quantitySource: p.quantitySource ?? 'COUNTED', note: p.note ?? null,
      },
    })
  }

  for (const c of parsed.cash) {
    counts.cash++
    if (!WRITE) continue
    await prisma.cashSalesDaily.upsert({
      where: { saleDate: date(c.saleDate) },
      create: { saleDate: date(c.saleDate), shift1: dec(c.shift1), shift2: dec(c.shift2) },
      update: { shift1: dec(c.shift1), shift2: dec(c.shift2) },
    })
  }

  for (const s of parsed.outsideSales) {
    // A customer whose product nobody has confirmed is reported, never guessed.
    if (!s.product) { counts.skipped++; continue }
    const customerId = customers[s.customer]
    const productId = products[s.product]
    if (!customerId || !productId) { counts.skipped++; continue }
    counts.outsideSales++
    if (!WRITE) continue

    // Price comes from the dated list, not from the sheet's own RM column: for
    // Good Taste that column adds two internal views of the same quantity.
    const price = await prisma.price.findFirst({
      where: { customerId, productId, effectiveFrom: { lte: date(s.saleDate) } },
      orderBy: { effectiveFrom: 'desc' },
    })
    if (!price) { counts.skipped++; counts.outsideSales--; continue }
    const amount = price.unitPrice.times(new Prisma.Decimal(s.quantity))
    await prisma.outsideSale.upsert({
      where: { saleDate_customerId_productId: { saleDate: date(s.saleDate), customerId, productId } },
      create: {
        saleDate: date(s.saleDate), customerId, productId,
        quantity: dec(s.quantity), unitPrice: price.unitPrice, amount,
        note: s.note ?? null,
      },
      update: { quantity: dec(s.quantity), unitPrice: price.unitPrice, amount },
    })
  }

  for (const p of parsed.purchases) {
    const supplierId = customers[p.supplier]
    if (!supplierId) { counts.skipped++; continue }
    counts.purchases++
    if (!WRITE) continue
    const price = await prisma.price.findFirst({
      where: { customerId: supplierId, effectiveFrom: { lte: date(p.buyDate) } },
      orderBy: { effectiveFrom: 'desc' },
    })
    const unitPrice = price?.unitPrice ?? new Prisma.Decimal(0)
    const existing = await prisma.icePurchase.findFirst({
      where: { buyDate: date(p.buyDate), supplierId },
    })
    const data = {
      buyDate: date(p.buyDate), supplierId, doNo: p.doNo ?? null,
      quantity: dec(p.quantity), unitPrice,
      amount: unitPrice.times(new Prisma.Decimal(p.quantity)),
    }
    if (existing) await prisma.icePurchase.update({ where: { id: existing.id }, data })
    else await prisma.icePurchase.create({ data })
  }

  // ---- coldroom register -------------------------------------------------
  // Replaced per month rather than upserted per row. The register's row count
  // changes as tenants come and go — 29 rooms in June, 31 in March — so an
  // upsert-only load would leave a deleted row behind, and a stale row here is
  // a roomful of electricity charged to somebody who was not there.
  const coldroomMonths = [...new Set(parsed.coldroomReadings.map((r) => r.periodMonth))]
  for (const month of coldroomMonths) {
    const rows = parsed.coldroomReadings.filter((r) => r.periodMonth === month)
    counts.coldroomReadings += rows.length
    if (!WRITE) continue
    await prisma.$transaction([
      prisma.coldroomReading.deleteMany({ where: { periodMonth: date(`${month}-01`) } }),
      prisma.coldroomReading.createMany({
        data: rows.map((r) => ({
          periodMonth: date(`${month}-01`),
          rowNo: r.rowNo,
          roomCode: r.roomCode,
          tenantLabel: r.tenantLabel,
          ownUse: r.ownUse,
          openingKwh: dec(r.openingKwh),
          closingKwh: dec(r.closingKwh),
          rateRmPerKwh: new Prisma.Decimal(r.rateRmPerKwh.toFixed(4)),
          usageGroup: r.usageGroup,
        })),
      }),
    ])
  }

  void key
}

async function main() {
  console.log(WRITE ? '=== IMPORT (writing) ===\n' : '=== IMPORT DRY RUN (nothing will be written) ===\n')

  const totals = zero()
  let errors = 0

  for (const [key, parse] of Object.entries(PARSERS)) {
    if (only && key !== only) continue
    const path = `${EXTRACT_DIR}/${key}.json`
    if (!existsSync(path)) {
      console.log(`--- ${key}: no extract at ${path}; run scripts/import/extract.py first\n`)
      continue
    }
    const wb = JSON.parse(readFileSync(path, 'utf8')) as Workbook
    const parsed = parse(wb)

    console.log(`--- ${key}  (${wb.sourceFile})`)
    console.log(formatMappingLog(parsed.resolved))
    if (parsed.issues.length) printIssues(parsed.issues)
    errors += parsed.issues.filter((i) => i.level === 'ERROR').length

    const counts = zero()
    await load(key, parsed, counts)
    const parts = Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}=${n}`)
      .join(' ')
    console.log(`  ${WRITE ? 'loaded' : 'would load'}: ${parts || 'nothing'}\n`)
    for (const k of Object.keys(totals) as (keyof Counts)[]) totals[k] += counts[k]
  }

  console.log('=== totals ===')
  console.table(totals)
  if (errors) {
    console.log(
      `\n${errors} ERROR-level issue(s). Resolve them before running with --write.`
    )
    if (WRITE) process.exitCode = 1
  } else if (!WRITE) {
    console.log('\nNo blocking issues. Re-run with --write to apply.')
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
