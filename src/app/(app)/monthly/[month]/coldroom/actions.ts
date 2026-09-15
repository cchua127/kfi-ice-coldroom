'use server'

import { revalidatePath } from 'next/cache'
import { Prisma } from '@prisma/client'
import { registerPrisma as prisma, asMonthDate, prevMonth } from '@/lib/coldroom-entry'
import { requireStaff } from '@/lib/session'
import { validateRegister, hasBlocking, type Issue, type RegisterRowCheck } from '@/lib/validation'

export interface RegisterPayload {
  month: string
  rows: {
    roomCode: string
    tenantLabel: string
    ownUse: boolean
    openingKwh: string
    closingKwh: string
    rateRmPerKwh: string
    usageGroup: string
    note: string
    meterReplaced: boolean
  }[]
}

export interface RegisterSaveResult {
  ok: boolean
  issues: Issue[]
  savedRows?: number
  savedAt?: string
}

const num = (v: string | undefined | null): string | null =>
  v === undefined || v === null || v.trim() === '' ? null : v.trim()

/**
 * Save a month's register.
 *
 * The month is replaced wholesale rather than upserted row by row. The row
 * count changes as tenants come and go — 29 rooms one month, 31 the next — so
 * an upsert-only save would leave a deleted room behind, and a stale row here
 * is a roomful of electricity recharged to somebody who was not there.
 *
 * A row with no closing reading is dropped, not stored as a zero. Mid-entry
 * blanks are normal; a zero would read as a room that drew nothing.
 */
export async function saveRegister(payload: RegisterPayload): Promise<RegisterSaveResult> {
  await requireStaff()
  const month = payload.month
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return { ok: false, issues: [{ severity: 'ERROR', field: 'month', message: 'Bad month.' }] }
  }

  // Re-read last month here rather than trusting what the form carried: a form
  // post is not a trusted input, and the chain check is only worth running
  // against the real prior closing.
  const prior = await prisma.coldroomReading.findMany({
    where: { periodMonth: asMonthDate(prevMonth(month)) },
    orderBy: { rowNo: 'asc' },
  })
  const priorClosing = new Map(prior.map((r) => [r.roomCode, r.closingKwh.toString()]))

  const checks: RegisterRowCheck[] = payload.rows.map((r, i) => ({
    rowNo: i + 1,
    roomCode: r.roomCode,
    tenantLabel: num(r.tenantLabel),
    ownUse: r.ownUse,
    openingKwh: num(r.openingKwh),
    closingKwh: num(r.closingKwh),
    rateRmPerKwh: num(r.rateRmPerKwh),
    meterReplaced: r.meterReplaced,
    priorClosing: priorClosing.get(r.roomCode.trim().toUpperCase()) ?? null,
  }))

  const issues = validateRegister(checks)
  if (hasBlocking(issues)) return { ok: false, issues }

  const keep = payload.rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => num(r.closingKwh) !== null && num(r.openingKwh) !== null && r.roomCode.trim())

  await prisma.$transaction([
    prisma.coldroomReading.deleteMany({ where: { periodMonth: asMonthDate(month) } }),
    ...(keep.length
      ? [
          prisma.coldroomReading.createMany({
            data: keep.map(({ r }, n) => ({
              periodMonth: asMonthDate(month),
              rowNo: n + 1,
              roomCode: r.roomCode.trim().toUpperCase(),
              tenantLabel: num(r.tenantLabel),
              ownUse: r.ownUse,
              openingKwh: new Prisma.Decimal(num(r.openingKwh)!),
              closingKwh: new Prisma.Decimal(num(r.closingKwh)!),
              rateRmPerKwh: new Prisma.Decimal(num(r.rateRmPerKwh)!),
              usageGroup: num(r.usageGroup) ? Number(num(r.usageGroup)) : null,
              note: num(r.note),
            })),
          }),
        ]
      : []),
  ])

  revalidatePath(`/monthly/${month}/coldroom`)
  revalidatePath(`/monthly/${month}`)
  // Saving does not restate anything by itself: the reports read stored daily
  // rows, and those only move when the recompute runs. The screen says so.
  return { ok: true, issues, savedRows: keep.length, savedAt: new Date().toISOString() }
}
