/**
 * Keying the coldroom register for a month.
 *
 * The office reads about 29 meters once a month and recharges each room at the
 * tenant rate. Until now this system could only IMPORT that register from the
 * workbook the office keeps by hand — which is fine for the nine months on
 * file and useless for September.
 *
 * The shape of the screen follows the shape of the job. Nobody re-types 29 room
 * codes, 29 tenants and 29 opening readings every month: the rooms carry
 * forward from last month, each opening is last month's closing, and the only
 * thing actually keyed is a column of closing readings. Rows can be added when
 * a tenant moves in and split when a room changes hands mid-month.
 */
import { PrismaClient } from '@prisma/client'
import { Decimal, d } from './money'
import { isOwnUseLabel } from './validation'

const prisma = new PrismaClient()

const asMonthDate = (month: string) => new Date(`${month}-01T00:00:00.000Z`)
const iso = (x: Date) => x.toISOString().slice(0, 10)

const prevMonth = (month: string) => {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7)
}

export interface RegisterRow {
  rowNo: number
  roomCode: string
  tenantLabel: string
  ownUse: boolean
  /** Blank on a room nobody has read before. */
  openingKwh: string
  closingKwh: string
  rateRmPerKwh: string
  usageGroup: string
  note: string
  /**
   * Last month's closing for this room, so the screen can show when an opening
   * has been overridden and the chain no longer joins up.
   */
  priorClosing: string | null
  /** True when this row was carried forward rather than read back from a save. */
  carriedForward: boolean
}

export interface RegisterEntry {
  month: string
  rows: RegisterRow[]
  /** True when the month already has saved rows, rather than a carried-forward draft. */
  saved: boolean
  /** Where the rows came from, for the screen to explain itself. */
  source: 'SAVED' | 'CARRIED_FORWARD' | 'EMPTY'
  carriedFrom: string | null
  defaultRate: string
  monthsWithRegister: string[]
}


/** The shape `carryForward` needs. Anything with these four fields will do. */
export interface CarryForwardRow {
  rowNo: number
  roomCode: string
  openingKwh: Decimal | string | number
  closingKwh: Decimal | string | number
}

/**
 * Which of last month's rows become next month's rows.
 *
 * The hard part is two rows sharing a room code, which happens for two entirely
 * different reasons that need opposite treatment:
 *
 *   - A room re-let mid-month. The register runs continuously across the
 *     handover — the first row's closing IS the second row's opening — so the
 *     split was a fact about last month, not a standing arrangement. It
 *     collapses to one row carrying the final closing forward.
 *   - Two physically different rooms that happen to share a label. "D5" is two
 *     rooms on registers around 564,767 and 486,831, unrelated to each other.
 *     Collapsing those loses a room, and next month it silently stops being read
 *     — which is how a roomful of electricity quietly leaves the register.
 *
 * Continuity is what tells them apart, so continuity is what is tested. Pure,
 * so the distinction can be exercised without a database.
 */
export function carryForward<T extends CarryForwardRow>(prior: T[]): T[] {
  const byCode = new Map<string, T[]>()
  for (const r of prior) byCode.set(r.roomCode, [...(byCode.get(r.roomCode) ?? []), r])

  const out: T[] = []
  for (const group of byCode.values()) {
    const ordered = [...group].sort((a, b) => a.rowNo - b.rowNo)
    let run = ordered[0]
    for (const next of ordered.slice(1)) {
      if (d(next.openingKwh).equals(d(run.closingKwh))) {
        run = next // same meter, either side of a handover
      } else {
        out.push(run) // a different meter under the same label
        run = next
      }
    }
    out.push(run)
  }
  return out.sort((a, b) => a.rowNo - b.rowNo)
}

/**
 * Load a month for editing.
 *
 * A saved month is returned as it stands. An unsaved one is seeded from the
 * previous month: same rooms, same tenants, same rate, each opening set to that
 * room's last closing, and every closing blank. Nothing is written by loading —
 * the draft only becomes real when somebody saves it.
 */
export async function loadRegister(month: string): Promise<RegisterEntry> {
  const [saved, prior, assumption, months] = await Promise.all([
    prisma.coldroomReading.findMany({
      where: { periodMonth: asMonthDate(month) },
      orderBy: { rowNo: 'asc' },
    }),
    prisma.coldroomReading.findMany({
      where: { periodMonth: asMonthDate(prevMonth(month)) },
      orderBy: { rowNo: 'asc' },
    }),
    prisma.costAssumption.findFirst({
      where: {
        key: 'tenant_billing_rate_rm_per_kwh',
        effectiveFrom: { lte: asMonthDate(month) },
      },
      orderBy: { effectiveFrom: 'desc' },
    }),
    prisma.coldroomReading.findMany({ select: { periodMonth: true }, distinct: ['periodMonth'] }),
  ])

  const defaultRate = assumption ? assumption.value.toFixed(4) : '0.5430'

  // Last month's closing per room, for the chain check on a SAVED month. Where
  // a code covers two physical rooms this is ambiguous, so it is left out
  // rather than guessed: a chain warning pointing at the wrong meter is worse
  // than no warning at all.
  const closingsByCode = new Map<string, Decimal[]>()
  for (const r of prior) {
    closingsByCode.set(r.roomCode, [...(closingsByCode.get(r.roomCode) ?? []), d(r.closingKwh)])
  }
  const priorClosing = new Map<string, Decimal>()
  for (const [code, closings] of closingsByCode) {
    const distinct = new Set(closings.map((c) => c.toString()))
    if (distinct.size === 1) priorClosing.set(code, closings[0])
  }

  if (saved.length) {
    return {
      month,
      saved: true,
      source: 'SAVED',
      carriedFrom: null,
      defaultRate,
      monthsWithRegister: months.map((m) => iso(m.periodMonth).slice(0, 7)).sort(),
      rows: saved.map((r) => ({
        rowNo: r.rowNo,
        roomCode: r.roomCode,
        tenantLabel: r.tenantLabel ?? '',
        ownUse: r.ownUse,
        openingKwh: r.openingKwh.toString(),
        closingKwh: r.closingKwh.toString(),
        rateRmPerKwh: r.rateRmPerKwh.toFixed(4),
        usageGroup: r.usageGroup === null ? '' : String(r.usageGroup),
        note: r.note ?? '',
        priorClosing: priorClosing.get(r.roomCode)?.toString() ?? null,
        carriedForward: false,
      })),
    }
  }

  if (!prior.length) {
    return {
      month,
      saved: false,
      source: 'EMPTY',
      carriedFrom: null,
      defaultRate,
      monthsWithRegister: months.map((m) => iso(m.periodMonth).slice(0, 7)).sort(),
      rows: [],
    }
  }

  const forward = carryForward(prior)

  return {
    month,
    saved: false,
    source: 'CARRIED_FORWARD',
    carriedFrom: prevMonth(month),
    defaultRate,
    monthsWithRegister: months.map((m) => iso(m.periodMonth).slice(0, 7)).sort(),
    rows: forward
      .sort((a, b) => a.rowNo - b.rowNo)
      .map((r, i) => ({
        rowNo: i + 1,
        roomCode: r.roomCode,
        tenantLabel: r.tenantLabel ?? '',
        ownUse: r.ownUse,
        openingKwh: r.closingKwh.toString(),
        closingKwh: '',
        rateRmPerKwh: r.rateRmPerKwh.toFixed(4),
        usageGroup: r.usageGroup === null ? '' : String(r.usageGroup),
        note: '',
        priorClosing: r.closingKwh.toString(),
        carriedForward: true,
      })),
  }
}

/** A blank row, for a tenant who has just moved in. */
export const blankRow = (rowNo: number, defaultRate: string): RegisterRow => ({
  rowNo,
  roomCode: '',
  tenantLabel: '',
  ownUse: false,
  openingKwh: '',
  closingKwh: '',
  rateRmPerKwh: defaultRate,
  usageGroup: '',
  note: '',
  priorClosing: null,
  carriedForward: false,
})

export { prisma as registerPrisma, asMonthDate, prevMonth, isOwnUseLabel }
