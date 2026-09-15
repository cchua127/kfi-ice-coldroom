/**
 * Reference seed. Idempotent — safe to re-run.
 *
 * Every figure here is traceable to a source: the six bill PDFs, the six source
 * workbooks, the management reports draft, or an owner instruction. Anything
 * inferred rather than sourced carries a note saying so, because a calibrated
 * estimate that reads like a measurement is how the old system went wrong.
 */
import {
  PrismaClient,
  Role,
  LineCode,
  UnitCode,
  Channel,
  BillStatus,
  EnergyUseCode,
} from '@prisma/client'
import { hashPassword } from '../src/lib/auth'
import billFixtures from '../tests/fixtures/tnb-bills.json'

const prisma = new PrismaClient()
const date = (s: string) => new Date(`${s}T00:00:00.000Z`)

async function main() {
  // -------------------------------------------------------------------------
  // Production lines
  // -------------------------------------------------------------------------
  const lines: {
    code: LineCode
    name: string
    nameBm: string
    activeFrom: string
    activeTo?: string
  }[] = [
    { code: 'TUBE', name: 'Tube Ice', nameBm: 'Ais Tiub', activeFrom: '2022-01-01' },
    { code: 'BIG_POOL', name: 'Big Pool', nameBm: 'Kolam Besar', activeFrom: '2022-01-01' },
    {
      code: 'BIMC',
      name: 'BIMC China Machine',
      nameBm: 'Mesin China',
      // Earliest sheet on file is dec25. R5 puts the machine's arrival in 2025;
      // exact commissioning date still to confirm.
      activeFrom: '2025-12-01',
    },
    {
      code: 'SMALL_POOL',
      name: 'Small Pool (stopped)',
      nameBm: 'Kolam Kecil',
      activeFrom: '2022-01-01',
      // The last day with production in the meter book is 5 January 2026 —
      // the `jan` sheet has entries for days 1-5 and nothing after.
      activeTo: '2026-01-05',
    },
  ]

  for (const l of lines) {
    await prisma.productionLine.upsert({
      where: { code: l.code },
      create: {
        code: l.code,
        name: l.name,
        nameBm: l.nameBm,
        activeFrom: date(l.activeFrom),
        activeTo: l.activeTo ? date(l.activeTo) : null,
      },
      update: { name: l.name, nameBm: l.nameBm, activeTo: l.activeTo ? date(l.activeTo) : null },
    })
  }
  const lineId = Object.fromEntries(
    (await prisma.productionLine.findMany()).map((l) => [l.code, l.id])
  ) as Record<LineCode, number>

  // -------------------------------------------------------------------------
  // Dated pack sizes. The small-block weight differs BY LINE: small pool ran
  // 38 kg, BIMC runs 45 kg. R5 flags the 38/45 drift as inflating recent kg 1-3%.
  // -------------------------------------------------------------------------
  const units: [LineCode, UnitCode, string | null, string, string?][] = [
    ['TUBE', 'BAG', '12.500', '2022-01-01'],
    ['TUBE', 'TONG', '100.000', '2022-01-01'],
    ['BIG_POOL', 'BARIS', null, '2022-01-01', 'kg derives via blocks_per_baris x block weight'],
    ['BIG_POOL', 'BLOK', '100.000', '2022-01-01'],
    ['BIMC', 'SMALL_TONG', '45.000', '2025-12-01', 'China machine small tong'],
    ['SMALL_POOL', 'SMALL_TONG', '38.000', '2022-01-01', 'Small pool small tong — 38 kg, not 45'],
    ['SMALL_POOL', 'BLOK', '100.000', '2022-01-01'],
  ]
  for (const [code, unitCode, kg, from, note] of units) {
    await prisma.productionUnit.upsert({
      where: {
        lineId_unitCode_effectiveFrom: {
          lineId: lineId[code],
          unitCode,
          effectiveFrom: date(from),
        },
      },
      create: {
        lineId: lineId[code],
        unitCode,
        kgPerUnit: kg,
        effectiveFrom: date(from),
        note: note ?? null,
      },
      update: { kgPerUnit: kg, note: note ?? null },
    })
  }

  // -------------------------------------------------------------------------
  // TNB accounts and meters. Declared load, max demand and deposits are read
  // from the bill PDFs; none of them carries a charge on this tariff.
  // -------------------------------------------------------------------------
  const accounts = [
    {
      accountNo: '220275147610',
      lot: '41597',
      declaredKw: '80.50',
      depositRm: '79366.13',
      description: 'Lot 41597, Jln Seri Kembangan — declared 80.50 kW against 375 kW recorded',
    },
    {
      accountNo: '220278867506',
      lot: '41579',
      declaredKw: '500.00',
      depositRm: '89605.91',
      description: 'Lot 41579',
    },
  ]
  for (const a of accounts) {
    await prisma.tnbAccount.upsert({
      where: { accountNo: a.accountNo },
      create: a,
      update: a,
    })
  }
  const acctId = Object.fromEntries(
    (await prisma.tnbAccount.findMany()).map((a) => [a.accountNo, a.id])
  )

  const meters: { code: string; line: LineCode | null; note: string; active?: boolean }[] = [
    { code: 'TUBE', line: 'TUBE', note: '7-digit register; ~2,136,930 at 1 Sep 2026' },
    { code: 'BIG_POOL', line: 'BIG_POOL', note: '7-digit register; ~7,280,530 at 1 Sep 2026' },
    {
      code: 'SMALL_POOL',
      line: 'SMALL_POOL',
      note: 'Legacy line, stopped end of January 2026. Register ~2,993,500 at 1 Jan 2026.',
      active: false,
    },
    {
      code: 'COLDROOM',
      line: null,
      // Sub-metered all along. The legacy report back-inferred coldroom kWh by
      // dividing an RM allocation by 0.484 — circular, and unnecessary when a
      // real reading exists.
      note: 'Sub-meter confirmed present. Meter number, CT multiplier and reading history outstanding.',
    },
  ]
  for (const m of meters) {
    await prisma.meter.upsert({
      where: { code: m.code },
      create: {
        code: m.code,
        lineId: m.line ? lineId[m.line] : null,
        note: m.note,
        active: m.active ?? true,
      },
      update: { note: m.note, active: m.active ?? true },
    })
  }

  // -------------------------------------------------------------------------
  // Customers and products
  // -------------------------------------------------------------------------
  const customers: [string, Channel][] = [
    ['Pasar Counter', 'PASAR'],
    ['Sydney', 'OUTSIDE'],
    ['TCC', 'OUTSIDE'],
    ['Good Taste', 'OUTSIDE'],
    ['Burger', 'OUTSIDE'],
    ['Ocean Ice', 'SUPPLIER'],
    // Present only in the Oct/Nov 2025 sheets. Which product each buys is not
    // recorded anywhere, so the importer reads their quantities but will not
    // load them until that is confirmed.
    ['Wai Mah', 'OUTSIDE'],
    ['The Wet World', 'OUTSIDE'],
    ['Hypecircus', 'OUTSIDE'],
    ['Snow Theme Park', 'OUTSIDE'],
  ]
  for (const [name, channel] of customers) {
    await prisma.customer.upsert({ where: { name }, create: { name, channel }, update: { channel } })
  }
  const custId = Object.fromEntries(
    (await prisma.customer.findMany()).map((c) => [c.name, c.id])
  )

  const products: [string, string, string | null][] = [
    ['BIG_BLOCK', 'Big block (100 kg)', '100.000'],
    ['SMALL_BLOCK_BIMC', 'Small block, China machine (45 kg)', '45.000'],
    ['SMALL_BLOCK_POOL', 'Small block, small pool (38 kg)', '38.000'],
    ['TUBE_TONG', 'Tube ice tong (100 kg)', '100.000'],
    ['BAG', 'Tube ice bag (12.5 kg)', '12.500'],
    ['CRUSH', 'Crushed ice, per bag', null],
  ]
  for (const [code, name, kg] of products) {
    await prisma.product.upsert({
      where: { code },
      create: { code, name, kgPerUnit: kg },
      update: { name, kgPerUnit: kg },
    })
  }
  const prodId = Object.fromEntries(
    (await prisma.product.findMany()).map((p) => [p.code, p.id])
  )

  // Prices, dated from the source workbooks rather than assumed. The rise
  // landed in JUNE 2026 — Sydney 3.00->3.30, TCC 19.00->21.00, Burger
  // 24.00->26.00 — which is why the build spec lists Good Taste at
  // "RM 3.00 / 3.30": those are the old and new prices, not two products.
  //
  // Sydney and Good Taste buy the 12.5 kg unit — a bag, despite the "block"
  // label on the price list. TCC and Burger buy 100 kg blocks. Owner-confirmed.
  const priceEpochs: [string, [string, string, string, string?][]][] = [
    ['2025-10-01', [
      ['Sydney', 'BAG', '3.00'],
      ['TCC', 'BIG_BLOCK', '19.00'],
      ['Burger', 'BIG_BLOCK', '24.00'],
      ['Good Taste', 'CRUSH', '3.00', 'Crushed ice in bags'],
      // Counter prices before the June rise. Owner-confirmed 15 September 2026:
      // the counter was revised once, in 2026, and these were the prices before
      // it. See docs §10.5 for how the small block was settled.
      ['Pasar Counter', 'BIG_BLOCK', '24.00', 'Counter price before the June 2026 rise'],
      ['Pasar Counter', 'SMALL_BLOCK_BIMC', '12.00', 'Counter price before the June 2026 rise'],
      [
        'Pasar Counter', 'TUBE_TONG', '22.00',
        'Unchanged through the June 2026 rise — the only counter line that did not move',
      ],
      // Owner-confirmed: Good Taste blocks are charged per block, at eight
      // times the crush rate of the day. RM26.40 from June; before that the
      // crush rate was RM3.00, so RM24.00. The RM22.40 in column Y of the
      // source sheet is not what the sheet's own formula charges, and is not
      // used here.
      ['Good Taste', 'BIG_BLOCK', '24.00', 'Blocks cut into 1/8, charged per block at 8 x the RM3.00 crush rate'],
      ['Ocean Ice', 'BIG_BLOCK', '15.00', 'Purchase price. Block size to confirm.'],
    ]],
    ['2026-06-01', [
      ['Sydney', 'BAG', '3.30'],
      ['TCC', 'BIG_BLOCK', '21.00'],
      ['Burger', 'BIG_BLOCK', '26.00'],
      ['Good Taste', 'CRUSH', '3.30'],
      ['Good Taste', 'BIG_BLOCK', '26.40', 'Blocks cut into 1/8, charged per block at 8 x the RM3.30 crush rate'],
      ['Ocean Ice', 'BIG_BLOCK', '15.00'],
      // Counter prices. Report R1 proves these reconcile shift cash to the
      // ringgit on June data: big x RM26 + small x RM13 = recorded shift cash,
      // six for six.
      ['Pasar Counter', 'BIG_BLOCK', '26.00', 'Counter price; reconciles June shift cash exactly'],
      ['Pasar Counter', 'SMALL_BLOCK_BIMC', '13.00', 'Counter price; reconciles June shift cash exactly'],
      ['Pasar Counter', 'TUBE_TONG', '22.00', 'Unchanged in the June 2026 rise'],
    ]],
  ]
  // Re-seeding must CONVERGE, not accumulate. An earlier version of this file
  // dated every price from 2026-01-01; correcting it to two epochs left those
  // rows behind, and `as at 2026-01-01` then picked the stale one — which
  // silently mis-priced five months of history. Remove any epoch this file no
  // longer declares, for the pairs it manages.
  const declaredEpochs = priceEpochs.map(([from]) => date(from))
  const managedPairs = priceEpochs.flatMap(([, rows]) =>
    rows.map(([cust, prod]) => ({ customerId: custId[cust], productId: prodId[prod] }))
  )
  for (const pair of managedPairs) {
    await prisma.price.deleteMany({
      where: { ...pair, effectiveFrom: { notIn: declaredEpochs } },
    })
  }

  for (const [from, rows] of priceEpochs) {
    for (const [cust, prod, price, note] of rows) {
      await prisma.price.upsert({
        where: {
          customerId_productId_effectiveFrom: {
            customerId: custId[cust],
            productId: prodId[prod],
            effectiveFrom: date(from),
          },
        },
        create: {
          customerId: custId[cust],
          productId: prodId[prod],
          unitPrice: price,
          effectiveFrom: date(from),
          note: note ?? null,
        },
        update: { unitPrice: price, note: note ?? null },
      })
    }
  }

  // -------------------------------------------------------------------------
  // Cost assumptions. Dated, editable, never hardcoded.
  // -------------------------------------------------------------------------
  // Physical constants of the plant date from the start of the record.
  // Calibrated energy figures date from the earliest month with data, because
  // they have to cover it — but they were derived against the Jan-Jun 2026
  // bills, and their notes say so rather than implying they were measured then.
  const PHYSICAL_FROM = '2022-01-01'
  const CALIBRATED_FROM = '2025-10-01'

  const assumptions: [string, string, string, string, boolean, string][] = [
    [
      'bimc_kwh_per_block', CALIBRATED_FROM,
      '5.0000', 'kWh/block', false,
      'ESTIMATE PENDING MEASUREMENT. Calibrated against the Jan-Jun 2026 bills on ' +
        'BOOKED output of 200/day, and applied to earlier months on the same basis ' +
        'for want of anything better. On sellable output (~177/fill) the same ' +
        'energy is 5.65 kWh/block — see the block ledger gap in report R1. ' +
        'Replaces the old flat 429 kWh/day booking.',
    ],
    [
      'brine_compressor_kwh_per_day', CALIBRATED_FROM,
      '340.0000', 'kWh/day', false,
      'ESTIMATE PENDING MEASUREMENT. 30HP, -8C cut-out with manual restart, so not ' +
        'a 24h load. Part of what the retired x1.2 loader represented, now named ' +
        'and individually adjustable.',
    ],
    [
      'water_kwh_per_tonne', CALIBRATED_FROM,
      '0.6500', 'kWh/tonne', false,
      'ESTIMATE. KFI-side only. Full operation is about 0.75; part of the pumping ' +
        "sits on another company's TNB account.",
    ],
    ['office_cctv_kwh_per_day', CALIBRATED_FROM, '36.0000', 'kWh/day', false,
      'ESTIMATE PENDING MEASUREMENT.'],
    ['crusher_kwh_per_day', CALIBRATED_FROM, '10.0000', 'kWh/day', false,
      'ESTIMATE PENDING MEASUREMENT.'],
    [
      'blocks_per_baris', PHYSICAL_FROM, '8.0000', 'blocks', true,
      'Counted. A physical property of the big pool. The number of rows filled is ' +
        'a real, varying count including half-rows; this is cans per row.',
    ],
    [
      'small_pool_blocks_per_baris', PHYSICAL_FROM, '23.0000', 'blocks', true,
      'Counted. The small pool ran 23 small blocks to a row; the big pool runs 8.',
    ],
    [
      'bimc_blocks_per_fill_convention', CALIBRATED_FROM, '200.0000', 'blocks', false,
      'CONVENTION, NOT A COUNT. The legacy sheets book a flat 200/day. Report R1 ' +
        'finds implied yield of 174.5-180.7 every month. Open question: mould ' +
        'count or harvest count.',
    ],
    // From the owner's LIVE cost template, September 2026. See docs §10.
    [
      'coldroom_legacy_factor_rm_per_kwh', PHYSICAL_FROM, '0.4840', 'RM/kWh', false,
      'NOT A TARIFF — A DIVISOR. The pre-July-2025 rate the coldroom RM ' +
        'compilations were struck at, and the only way back to a kWh figure ' +
        'while the sub-meter goes unread. Every coldroom number derived through ' +
        'it inherits a rate that has been stale since July 2025, which is why ' +
        'the month-close checks flag any month that leans on it. It is dated ' +
        'from the start of the record because it describes historic documents, ' +
        'not current consumption. Delete the need for it by reading the meter.',
    ],
    [
      'tenant_billing_rate_rm_per_kwh', CALIBRATED_FROM, '0.5430', 'RM/kWh', true,
      'Counted, in the sense that it is the rate actually charged: coldroom ' +
        'tenants and the internal D10-D12 recharge are billed at it. It is a ' +
        'commercial decision, not a measurement of anything, and it is fixed ' +
        'while the blended tariff floats — so the margin it earns shrinks every ' +
        'time AFA rises. Review before Q3.',
    ],
    [
      'water_ice_feed_kwh_per_tonne', CALIBRATED_FROM, '0.4500', 'kWh/tonne', false,
      'ESTIMATE. Delivered intensity less the final transfer to a client tank, ' +
        'which ice feed water never makes: it stops at the moulds. Lower than ' +
        'the 0.65 delivered figure for that reason alone.',
    ],
  ]
  for (const [key, from, value, unit, measured, note] of assumptions) {
    await prisma.costAssumption.upsert({
      where: { key_effectiveFrom: { key, effectiveFrom: date(from) } },
      create: { key, value, unit, measured, effectiveFrom: date(from), note },
      update: { value, unit, measured, note },
    })
  }
  // Remove any rows left by the earlier 2026-01-01 dating, so re-seeding does
  // not leave two epochs of the same assumption in place.
  await prisma.costAssumption.deleteMany({
    where: { effectiveFrom: date('2026-01-01'), key: { in: assumptions.map((a) => a[0]) } },
  })

  // -------------------------------------------------------------------------
  // The non-production consumers, from the owner's LIVE cost template.
  //
  // `countsAsIce` is the one field here that is a judgement rather than a
  // description, and it is a column precisely so that it can be argued with.
  // Freezing this convention into the cost engine is the same mistake as
  // freezing RM0.484/kWh into a formula: the number stops being visible and
  // then stops being questioned.
  // -------------------------------------------------------------------------
  const energyUses: {
    code: EnergyUseCode
    name: string
    nameBm: string | null
    countsAsIce: boolean
    note: string
  }[] = [
    {
      code: 'BRINE_COMPRESSOR',
      name: '30HP brine compressor',
      nameBm: 'Kompresor brine 30HP',
      countsAsIce: true,
      // The compressor makes no ice and the big pool cannot freeze without it.
      // It was invisible before: part of what the retired x1.2 big-pool loader
      // stood in for, spread across a line it does not belong to.
      note:
        'Freezes the big pool and makes none of the ice itself. Counts as ice ' +
        'because the pool cannot run without it. -8C cut-out with manual ' +
        'restart, so 16-18 effective hours rather than 24.',
    },
    {
      code: 'COLDROOM_ICE_STORE',
      name: 'Ice storage D10-D12',
      nameBm: 'Stor ais D10-D12',
      countsAsIce: true,
      note:
        "Three rooms holding this plant's own ice, recharged internally at the " +
        'tenant rate. Storing ice is part of selling it, so the power belongs ' +
        'in cost of ice rather than in the coldroom letting business.',
    },
    {
      code: 'COLDROOM_TENANT',
      name: 'Coldrooms — tenant',
      nameBm: 'Bilik sejuk — penyewa',
      countsAsIce: false,
      note:
        'Rooms let to tenants and recharged at a fixed RM/kWh. A separate ' +
        'business that happens to share a bill; its power must never reach cost ' +
        'of ice.',
    },
    {
      code: 'WATER_DELIVERED',
      name: 'Water — delivered',
      nameBm: 'Air — dihantar',
      countsAsIce: false,
      note:
        "Tubewell, filtration and transfer to a client's tank. Water sold as " +
        'water, not frozen.',
    },
    {
      code: 'WATER_ICE_FEED',
      name: 'Water — ice feed',
      nameBm: 'Air — suapan ais',
      countsAsIce: true,
      note:
        'OWNER DECISION, 15 September 2026 — docs §10.3. Counts as ice, against ' +
        "the template's convention, because this water becomes the ice. The water " +
        'itself is free from the tubewell, so what is allocated is only the ' +
        'electricity of pumping and filtering it. Worth 0.023 sen/kg — the owner ' +
        'was right that the amount is menial; it is in because it is correct, and ' +
        'because the 0.45 kWh/t split costs the office no extra keying.',
    },
    {
      code: 'OFFICE_CCTV',
      name: 'Office and CCTV',
      nameBm: 'Pejabat dan CCTV',
      countsAsIce: false,
      note: 'A 400 sqft office running aircond around the clock, and ~24 cameras. Overhead.',
    },
    {
      code: 'CRUSHER',
      name: 'Crusher (10HP)',
      nameBm: 'Mesin hancur (10HP)',
      countsAsIce: false,
      note:
        'Acts on ice already made and already costed. Counting it again would ' +
        "charge the same tonnage's energy twice. ~1.5 effective hours a day at 6 kW.",
    },
  ]
  for (const u of energyUses) {
    await prisma.energyUse.upsert({
      where: { code: u.code },
      create: u,
      update: u,
    })
  }
  // Convergent, for the same reason the price epochs are: a consumer this file
  // no longer declares must not linger and keep claiming kWh.
  //
  // A consumer that still has costed days is a different matter. The foreign
  // key would refuse the delete anyway; catching it here turns a raw constraint
  // violation into a sentence that says what to do. Deleting the costed days
  // silently would be worse than either.
  const retired = await prisma.energyUse.findMany({
    where: { code: { notIn: energyUses.map((u) => u.code) } },
  })
  for (const u of retired) {
    const costed = await prisma.dailyEnergyUse.count({ where: { useCode: u.code } })
    if (costed > 0) {
      throw new Error(
        `Energy use ${u.code} is no longer declared in the seed but still has ` +
          `${costed} costed day(s). Remove it from the recompute window first ` +
          `(scripts/recompute.ts rebuilds the range wholesale), then re-seed.`
      )
    }
    await prisma.energyUse.delete({ where: { code: u.code } })
  }

  // -------------------------------------------------------------------------
  // AFA as billed. The only component of this tariff that moves.
  // -------------------------------------------------------------------------
  const afa: [string, string, string?][] = [
    ['2026-01-01', '-0.0499'],
    ['2026-02-01', '-0.0277'],
    ['2026-03-01', '-0.0215'],
    ['2026-04-01', '-0.0047'],
    ['2026-05-01', '0.0138'],
    ['2026-06-01', '0.0259'],
    ['2026-07-01', '0.0359'],
    ['2026-08-01', '0.0380'],
    ['2026-09-01', '0.0367', 'Published; bills issue around 1 October.'],
  ]
  for (const [month, rate, note] of afa) {
    await prisma.afaRate.upsert({
      where: { periodMonth: date(month) },
      create: { periodMonth: date(month), ratePerKwh: rate, note: note ?? null },
      update: { ratePerKwh: rate, note: note ?? null },
    })
  }

  // -------------------------------------------------------------------------
  // The six bills on file, read straight from the PDFs. Seeded CONFIRMED
  // because each one reconstructs to the cent — see tests/tariff.test.ts.
  // -------------------------------------------------------------------------
  for (const b of billFixtures) {
    const bill = await prisma.tnbBill.upsert({
      where: {
        accountId_periodStart_periodEnd: {
          accountId: acctId[b.accountNo],
          periodStart: date(b.periodStart),
          periodEnd: date(b.periodEnd),
        },
      },
      create: {
        accountId: acctId[b.accountNo],
        invoiceNo: b.invoiceNo,
        billDate: date(b.billDate),
        periodStart: date(b.periodStart),
        periodEnd: date(b.periodEnd),
        days: b.days,
        kwh: b.kwh,
        energyRate: b.energyRate,
        energyRm: b.energyRm,
        afaRatePerKwh: b.afaRatePerKwh,
        afaRm: b.afaRm,
        capacityRate: b.capacityRate,
        capacityRm: b.capacityRm,
        networkRate: b.networkRate,
        networkRm: b.networkRm,
        retailRm: b.retailRm,
        rebateRate: b.rebateRate,
        rebateRm: b.rebateRm,
        currentUsageRm: b.currentUsageRm,
        kwtbbRm: b.kwtbbRm,
        currentChargesRm: b.currentChargesRm,
        previousBalanceRm: b.previousBalanceRm,
        roundingRm: b.roundingRm,
        totalRm: b.totalRm,
        declaredKw: b.declaredKw,
        maxDemandKw: b.maxDemandKw,
        loadFactor: b.loadFactor,
        powerFactor: b.powerFactor,
        status: BillStatus.CONFIRMED,
      },
      update: {},
    })
    for (const r of b.meterReadings) {
      await prisma.tnbBillMeterReading.upsert({
        where: {
          billId_meterNo_unit: { billId: bill.id, meterNo: r.meterNo, unit: r.unit },
        },
        create: {
          billId: bill.id,
          meterNo: r.meterNo,
          unit: r.unit,
          previous: r.previous,
          current: r.current,
          usage: r.usage,
        },
        update: {},
      })
    }
  }

  // -------------------------------------------------------------------------
  // Accounts. No self-registration; an admin creates users. Real names, emails
  // and a password policy still to come from the owner.
  // -------------------------------------------------------------------------
  if (process.env.SEED_DEV_USERS !== 'false') {
    // Same cost factor as the login path — one place decides it.
    const hash = await hashPassword('change-me-on-first-login')
    for (const u of [
      { email: 'staff@kfi.local', name: 'Entry Staff', role: Role.STAFF },
      { email: 'manager@kfi.local', name: 'Manager', role: Role.MANAGER },
    ]) {
      await prisma.appUser.upsert({
        where: { email: u.email },
        create: { ...u, passwordHash: hash },
        update: {},
      })
    }
  }

  const counts = {
    lines: await prisma.productionLine.count(),
    units: await prisma.productionUnit.count(),
    accounts: await prisma.tnbAccount.count(),
    meters: await prisma.meter.count(),
    customers: await prisma.customer.count(),
    products: await prisma.product.count(),
    prices: await prisma.price.count(),
    assumptions: await prisma.costAssumption.count(),
    energyUses: await prisma.energyUse.count(),
    afaRates: await prisma.afaRate.count(),
    bills: await prisma.tnbBill.count(),
    billMeterRows: await prisma.tnbBillMeterReading.count(),
    users: await prisma.appUser.count(),
  }
  console.table(counts)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
