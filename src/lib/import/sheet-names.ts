/**
 * Sheet names in the source workbooks are inconsistent and dirty: `'aug '` with
 * a trailing space, `apr1`, `dec25`, `mac` for March, `jan-baris` for the shift
 * ledger. A rename breaks every cross-reference in the originals, which is
 * defect 5 — so the importer never trusts a name it can check against data.
 *
 * Resolution order:
 *   1. The month marker the sheet itself carries (a real date cell). Authoritative.
 *   2. Fuzzy match on the sheet name.
 * Both are recorded, and a disagreement is reported rather than resolved.
 */

export type MonthSource = 'CELL' | 'NAME' | 'UNRESOLVED'

export interface ResolvedSheet {
  sheetName: string
  /** 'YYYY-MM', or null when nothing resolved it. */
  month: string | null
  source: MonthSource
  /** The shift/FOC ledger variant, e.g. `jan-baris`. */
  isBarisLedger: boolean
  /** Set when the name and the in-sheet marker disagree — always a hard stop. */
  conflict?: string
  note?: string
}

const MONTHS: Record<string, number> = {
  jan: 1, januari: 1, january: 1,
  feb: 2, februari: 2, february: 2,
  mac: 3, mar: 3, march: 3, // `mac` is Mac/March in Bahasa Malaysia
  apr: 4, april: 4,
  may: 5, mei: 5,
  jun: 6, june: 6,
  jul: 7, july: 7, julai: 7,
  aug: 8, ogos: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, okt: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, dis: 12, december: 12,
}

/**
 * Pulls a month and an optional two-digit year out of a dirty sheet name.
 * Handles `'aug '`, `apr1`, `dec25`, `jan-baris`, `'dec-baris '`.
 */
export function parseSheetName(raw: string): {
  month: number | null
  year2: number | null
  isBarisLedger: boolean
  cleaned: string
} {
  const cleaned = raw.trim().toLowerCase()
  const isBarisLedger = /baris/.test(cleaned)
  const core = cleaned.replace(/[-_\s]*baris[-_\s]*/g, '')

  // Longest alphabetic prefix that names a month — `sept` must beat `sep`.
  const letters = core.replace(/[^a-z]/g, '')
  let month: number | null = null
  let matched = ''
  for (const key of Object.keys(MONTHS)) {
    if (letters.startsWith(key) && key.length > matched.length) {
      matched = key
      month = MONTHS[key]
    }
  }

  // A two-digit year only counts when it follows the month name (`dec25`).
  // A bare trailing `1` as in `apr1` is a sheet-copy suffix, not a year.
  const after = core.slice(core.indexOf(matched) + matched.length)
  const yearMatch = after.match(/(\d{2})\b/)
  const year2 = yearMatch ? Number(yearMatch[1]) : null

  return { month, year2, isBarisLedger, cleaned }
}

const pad = (n: number) => String(n).padStart(2, '0')

export interface ResolveOptions {
  /** ISO date from the sheet's own month cell, when it has one. */
  monthCellIso?: string | null
  /**
   * Year to assume when the name carries none. Sheets run Dec 2025 to Nov 2026,
   * so a December sheet without a year belongs to the earlier year.
   */
  defaultYear: number
  decemberYear?: number
}

export function resolveSheet(sheetName: string, opts: ResolveOptions): ResolvedSheet {
  const parsed = parseSheetName(sheetName)
  const base: ResolvedSheet = {
    sheetName,
    month: null,
    source: 'UNRESOLVED',
    isBarisLedger: parsed.isBarisLedger,
  }

  const fromName =
    parsed.month === null
      ? null
      : `${
          parsed.year2 !== null
            ? 2000 + parsed.year2
            : parsed.month === 12
              ? (opts.decemberYear ?? opts.defaultYear - 1)
              : opts.defaultYear
        }-${pad(parsed.month)}`

  const fromCell = opts.monthCellIso ? opts.monthCellIso.slice(0, 7) : null

  if (fromCell && fromName && fromCell !== fromName) {
    // A name that states its own year and still disagrees is a real conflict.
    // A name with no year (`oct`) losing to its month cell is not: the cell is
    // authoritative and the name never claimed a year. The ice-purchase sheets
    // `oct` and `nov` are Oct'25 and Nov'25 for exactly this reason.
    if (parsed.year2 !== null) {
      return {
        ...base,
        month: fromCell,
        source: 'CELL',
        conflict:
          `Sheet named "${sheetName}" states ${fromName}, but its own month ` +
          `cell says ${fromCell}. Using the cell; confirm before loading.`,
      }
    }
    return {
      ...base,
      month: fromCell,
      source: 'CELL',
      note:
        `Sheet name "${sheetName}" carries no year; its month cell gives ` +
        `${fromCell}, not the assumed ${fromName}.`,
    }
  }
  if (fromCell) return { ...base, month: fromCell, source: 'CELL' }
  if (fromName) {
    return {
      ...base,
      month: fromName,
      source: 'NAME',
      note: `No month cell; resolved from the sheet name "${sheetName}".`,
    }
  }
  return base
}

/** The mapping log the spec asks for: exactly what mapped to what, for review. */
export function formatMappingLog(resolved: ResolvedSheet[]): string {
  const width = Math.max(...resolved.map((r) => JSON.stringify(r.sheetName).length), 12)
  return resolved
    .map((r) => {
      const name = JSON.stringify(r.sheetName).padEnd(width)
      const month = (r.month ?? '??').padEnd(8)
      const tag = r.isBarisLedger ? ' [shift ledger]' : ''
      const flag = r.conflict ? `  CONFLICT: ${r.conflict}` : r.note ? `  (${r.note})` : ''
      return `  ${name} -> ${month} via ${r.source}${tag}${flag}`
    })
    .join('\n')
}
