'use server'

import { revalidatePath } from 'next/cache'
import { PrismaClient, Prisma } from '@prisma/client'
import { requireStaff } from '@/lib/session'
import { storeFile, checkUpload, readStoredFile } from '@/lib/documents'
import { parseBillPdf, toValidationInput, type ParsedBill } from '@/lib/bill-parser'
import { validateParsedBill, type Finding } from '@/lib/bill-validation'

const prisma = new PrismaClient()
const asDate = (s: string) => new Date(`${s}T00:00:00.000Z`)
const dec = (v: number | string) => new Prisma.Decimal(String(v))

export interface UploadResult {
  ok: boolean
  billId?: string
  message?: string
  /** Present when the parse failed but the document was stored. */
  parseError?: string
}

/**
 * Stores the PDF, asks the model to read it, and saves the result as
 * PENDING_REVIEW. It never confirms anything: the review form is the only
 * place a bill becomes CONFIRMED, and only a person can do it.
 */
export async function uploadBill(formData: FormData): Promise<UploadResult> {
  const user = await requireStaff()
  const file = formData.get('file')
  if (!(file instanceof File)) return { ok: false, message: 'Choose a PDF to upload.' }

  const problem = checkUpload(file.name, file.size)
  if (problem) return { ok: false, message: problem }

  const buf = Buffer.from(await file.arrayBuffer())
  const { hash, storagePath, byteSize } = await storeFile(buf, file.name)

  const existing = await prisma.document.findUnique({
    where: { sha256: hash },
    include: { bills: true },
  })
  if (existing) {
    return {
      ok: false,
      billId: existing.bills[0] ? String(existing.bills[0].id) : undefined,
      message:
        `That exact file has already been uploaded` +
        `${existing.bills[0] ? ' and is on the review list' : ''}.`,
    }
  }

  const document = await prisma.document.create({
    data: {
      kind: 'TNB_BILL', filename: file.name, storagePath, sha256: hash,
      byteSize, uploadedBy: user.id,
    },
  })

  const outcome = await parseBillPdf(buf)
  if (!outcome.ok || !outcome.bill) {
    // The document is stored either way; the review form opens empty so the
    // figures can be keyed by hand.
    return { ok: true, parseError: outcome.error, message: 'Stored, but not read.' }
  }

  const bill = outcome.bill
  const account = await prisma.tnbAccount.findUnique({
    where: { accountNo: bill.account_no },
  })
  if (!account) {
    return {
      ok: false,
      parseError:
        `The bill is for account ${bill.account_no}, which is not one of this ` +
        `site's accounts.`,
    }
  }

  const row = await prisma.tnbBill.upsert({
    where: {
      accountId_periodStart_periodEnd: {
        accountId: account.id,
        periodStart: asDate(bill.period_start),
        periodEnd: asDate(bill.period_end),
      },
    },
    create: { ...billData(bill, account.id, document.id), status: 'PENDING_REVIEW' },
    update: { ...billData(bill, account.id, document.id), status: 'PENDING_REVIEW' },
  })

  await prisma.tnbBillMeterReading.deleteMany({ where: { billId: row.id } })
  for (const m of bill.meter_readings) {
    await prisma.tnbBillMeterReading.create({
      data: {
        billId: row.id, meterNo: m.meter_no, unit: m.unit,
        previous: dec(m.previous), current: dec(m.current), usage: dec(m.usage),
      },
    })
  }

  revalidatePath('/bills')
  return { ok: true, billId: String(row.id) }
}

function billData(bill: ParsedBill, accountId: number, documentId: bigint) {
  return {
    accountId,
    documentId,
    invoiceNo: bill.invoice_no,
    billDate: asDate(bill.bill_date),
    periodStart: asDate(bill.period_start),
    periodEnd: asDate(bill.period_end),
    days: bill.days,
    kwh: dec(bill.kwh),
    energyRate: dec(bill.energy_rate), energyRm: dec(bill.energy_rm),
    afaRatePerKwh: dec(bill.afa_rate), afaRm: dec(bill.afa_rm),
    capacityRate: dec(bill.capacity_rate), capacityRm: dec(bill.capacity_rm),
    networkRate: dec(bill.network_rate), networkRm: dec(bill.network_rm),
    retailRm: dec(bill.retail_rm),
    rebateRate: dec(bill.rebate_rate), rebateRm: dec(bill.rebate_rm),
    currentUsageRm: dec(bill.current_usage_rm),
    kwtbbRm: dec(bill.kwtbb_rm),
    sstRm: dec(bill.sst_rm),
    currentChargesRm: dec(bill.current_charges_rm),
    previousBalanceRm: dec(bill.previous_balance_rm),
    roundingRm: dec(bill.rounding_rm),
    totalRm: dec(bill.total_rm),
    declaredKw: dec(bill.declared_kw),
    maxDemandKw: dec(bill.max_demand_kw),
    loadFactor: dec(bill.load_factor),
    powerFactor: dec(bill.power_factor),
    // Kept untouched so a parser regression can be audited against what the
    // model actually returned, not against what we stored.
    parsedJson: bill as unknown as Prisma.InputJsonValue,
  }
}

/** Re-runs the parse on an already stored document, e.g. after a key is added. */
export async function reparseBill(documentId: string): Promise<UploadResult> {
  await requireStaff()
  const doc = await prisma.document.findUnique({ where: { id: BigInt(documentId) } })
  if (!doc) return { ok: false, message: 'That document is no longer on file.' }
  const buf = await readStoredFile(doc.storagePath)
  const outcome = await parseBillPdf(buf)
  if (!outcome.ok || !outcome.bill) return { ok: false, parseError: outcome.error }
  const account = await prisma.tnbAccount.findUnique({
    where: { accountNo: outcome.bill.account_no },
  })
  if (!account) return { ok: false, parseError: `Unknown account ${outcome.bill.account_no}.` }
  const row = await prisma.tnbBill.upsert({
    where: {
      accountId_periodStart_periodEnd: {
        accountId: account.id,
        periodStart: asDate(outcome.bill.period_start),
        periodEnd: asDate(outcome.bill.period_end),
      },
    },
    create: { ...billData(outcome.bill, account.id, doc.id), status: 'PENDING_REVIEW' },
    update: { ...billData(outcome.bill, account.id, doc.id), status: 'PENDING_REVIEW' },
  })
  revalidatePath('/bills')
  return { ok: true, billId: String(row.id) }
}

export interface ConfirmResult {
  ok: boolean
  findings: Finding[]
  message?: string
}

/**
 * The only path to CONFIRMED. Everything the reviewer edited is re-validated
 * here — the form is not trusted — and the reconstruction has to tie before a
 * bill is allowed to change what a month costs.
 */
export async function confirmBill(
  billId: string,
  edits: Record<string, string>
): Promise<ConfirmResult> {
  const user = await requireStaff()
  const bill = await prisma.tnbBill.findUnique({
    where: { id: BigInt(billId) },
    include: { account: true, readings: true },
  })
  if (!bill) return { ok: false, findings: [], message: 'That bill is no longer on file.' }

  const num = (k: string, fallback: Prisma.Decimal | null) =>
    edits[k] !== undefined && edits[k] !== '' ? Number(edits[k]) : Number(fallback ?? 0)

  const candidate = {
    accountNo: bill.account.accountNo,
    periodStart: edits.periodStart || bill.periodStart.toISOString().slice(0, 10),
    periodEnd: edits.periodEnd || bill.periodEnd.toISOString().slice(0, 10),
    kwh: num('kwh', bill.kwh),
    afaRatePerKwh: num('afaRatePerKwh', bill.afaRatePerKwh),
    energyRate: num('energyRate', bill.energyRate),
    capacityRate: num('capacityRate', bill.capacityRate),
    networkRate: num('networkRate', bill.networkRate),
    rebateRate: num('rebateRate', bill.rebateRate),
    energyRm: num('energyRm', bill.energyRm),
    afaRm: num('afaRm', bill.afaRm),
    capacityRm: num('capacityRm', bill.capacityRm),
    networkRm: num('networkRm', bill.networkRm),
    retailRm: num('retailRm', bill.retailRm),
    rebateRm: num('rebateRm', bill.rebateRm),
    currentUsageRm: num('currentUsageRm', bill.currentUsageRm),
    kwtbbRm: num('kwtbbRm', bill.kwtbbRm),
    currentChargesRm: num('currentChargesRm', bill.currentChargesRm),
    previousBalanceRm: num('previousBalanceRm', bill.previousBalanceRm),
    roundingRm: num('roundingRm', bill.roundingRm),
    totalRm: num('totalRm', bill.totalRm),
    meterReadings: bill.readings.map((r) => ({
      meterNo: r.meterNo, unit: r.unit, usage: Number(r.usage),
    })),
  }

  const accounts = await prisma.tnbAccount.findMany()
  const priors = await prisma.tnbBill.findMany({
    where: { accountId: bill.accountId, status: 'CONFIRMED', id: { not: bill.id } },
  })
  const findings = validateParsedBill(candidate, {
    knownAccountNos: accounts.map((a) => a.accountNo),
    priorBills: priors.map((p) => ({
      periodStart: p.periodStart.toISOString().slice(0, 10),
      periodEnd: p.periodEnd.toISOString().slice(0, 10),
      kwh: p.kwh.toString(),
    })),
  })

  if (findings.some((f) => f.severity === 'ERROR')) {
    return {
      ok: false,
      findings,
      message: 'The figures do not reconstruct. Correct them before confirming.',
    }
  }

  await prisma.tnbBill.update({
    where: { id: bill.id },
    data: {
      kwh: dec(candidate.kwh),
      afaRatePerKwh: dec(candidate.afaRatePerKwh),
      energyRm: dec(candidate.energyRm), afaRm: dec(candidate.afaRm),
      capacityRm: dec(candidate.capacityRm), networkRm: dec(candidate.networkRm),
      retailRm: dec(candidate.retailRm), rebateRm: dec(candidate.rebateRm),
      currentUsageRm: dec(candidate.currentUsageRm), kwtbbRm: dec(candidate.kwtbbRm),
      currentChargesRm: dec(candidate.currentChargesRm),
      previousBalanceRm: dec(candidate.previousBalanceRm),
      roundingRm: dec(candidate.roundingRm), totalRm: dec(candidate.totalRm),
      status: 'CONFIRMED', confirmedBy: user.id, confirmedAt: new Date(),
    },
  })

  await prisma.changeLog.create({
    data: {
      tableName: 'tnb_bill', rowPk: String(bill.id), action: 'UPDATE',
      after: candidate as unknown as Prisma.InputJsonValue,
      reason: 'Confirmed after review', changedBy: user.id,
    },
  })

  revalidatePath('/bills')
  revalidatePath('/')
  return {
    ok: true,
    findings,
    message:
      'Confirmed. Run the recompute to restate the days this bill covers from ' +
      'provisional to final.',
  }
}
