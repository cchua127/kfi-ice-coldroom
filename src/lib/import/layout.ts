/**
 * Column layouts in the source workbooks are not stable between sheets.
 *
 * `Ice Purchase & sales outside` grows and shrinks as customers come and go:
 * Good Taste sits at column J from January to September 2026, at P in Oct 2025
 * and at N in Nov 2025, because Wai Mah, The Wet World, Hypecircus and Snow
 * Theme Park occupy columns before it in those months. A fixed column map would
 * silently import one customer's quantities as another's.
 *
 * The month marker moves for the same reason — it sits at N2 on a 35-column
 * sheet and T2 on a 41-column one. Resolving it by position rather than by
 * label puts Oct'25 and Nov'25 a full year out, because the sheet names say
 * only "oct" and "nov".
 *
 * So: find things by their labels, never by their coordinates.
 */
import type { Sheet } from './extract-types'
import { cellAt } from './extract-types'

const COLS = (() => {
  const out: string[] = []
  for (let i = 0; i < 26; i++) out.push(String.fromCharCode(65 + i))
  for (let i = 0; i < 26; i++)
    for (let j = 0; j < 26; j++)
      out.push(String.fromCharCode(65 + i) + String.fromCharCode(65 + j))
  return out
})()

export const nextCol = (col: string): string => COLS[COLS.indexOf(col) + 1]

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mac: 3, mar: 3, apr: 4, may: 5, mei: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, okt: 10, nov: 11, dec: 12, dis: 12,
}

const pad = (n: number) => String(n).padStart(2, '0')

/** `"Sept'26"` / `"Oct'25"` / `"Dec'25"` -> `"2025-12-01"`. */
export function parseMonthLabel(text: string): string | null {
  const m = text.trim().match(/^([A-Za-z]+)\s*'?\s*(\d{2,4})$/)
  if (!m) return null
  const mm = MONTH_NAMES[m[1].toLowerCase().slice(0, 3)]
  if (!mm) return null
  const yr = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2])
  return `${yr}-${pad(mm)}-01`
}

/**
 * Finds the sheet's own month marker wherever it sits: a real date cell, or a
 * `Month :` label with the value in a cell to its right.
 */
export function findMonthMarker(sheet: Sheet, searchRows = 6): string | null {
  for (let r = 1; r <= searchRows; r++) {
    const row = sheet.cells[String(r)]
    if (!row) continue
    for (const col of Object.keys(row).sort((a, b) => COLS.indexOf(a) - COLS.indexOf(b))) {
      const cell = row[col]
      if (cell.t === 'date' && typeof cell.v === 'string') return cell.v
      if (cell.t !== 'str' || typeof cell.v !== 'string') continue
      const text = cell.v.trim()

      const direct = parseMonthLabel(text)
      if (direct) return direct

      if (/^month\s*:?$/i.test(text) || /^bulan\s*:?$/i.test(text)) {
        let probe = nextCol(col)
        for (let k = 0; k < 4 && probe; k++, probe = nextCol(probe)) {
          const v = cellAt(sheet, r, probe)
          if (!v || v.v === null || v.v === '') continue
          if (v.t === 'date' && typeof v.v === 'string') return v.v
          if (typeof v.v === 'string') {
            const parsed = parseMonthLabel(v.v)
            if (parsed) return parsed
          }
          break
        }
      }
    }
  }
  return null
}

export interface CustomerColumns {
  /** Header text exactly as written on the sheet. */
  label: string
  /** Canonical customer name, or null when the label is not one we know. */
  customer: string | null
  quantityCol: string
  amountCol: string
  /** Unit price read from the row below, e.g. `'3.30/unit '` -> 3.30. */
  unitPrice: number | null
  /** Good Taste records `blok/crush` as free text in one cell. */
  isFreeTextPair: boolean
}

/** Maps a sheet header label onto a seeded customer name. */
const CUSTOMER_ALIASES: [RegExp, string][] = [
  [/^ocean\s*ice/i, 'Ocean Ice'],
  [/^sydney/i, 'Sydney'],
  [/^tcc/i, 'TCC'],
  [/^good\s*taste/i, 'Good Taste'],
  [/^burger/i, 'Burger'],
  [/^wai\s*mah/i, 'Wai Mah'],
  [/^the\s*wet\s*world/i, 'The Wet World'],
  [/^hype\s*circus/i, 'Hypecircus'],
  [/^snow\s*theme\s*park/i, 'Snow Theme Park'],
]

export const canonicalCustomer = (label: string): string | null =>
  CUSTOMER_ALIASES.find(([re]) => re.test(label.trim()))?.[1] ?? null

/** `'3.30/unit '` -> 3.30. `'RM'` -> null. */
export function parseUnitPriceLabel(text: string | null): number | null {
  if (!text) return null
  const m = text.trim().match(/^(?:RM\s*)?(\d+(?:\.\d+)?)\s*\/\s*unit/i)
  return m ? Number(m[1]) : null
}

/**
 * Reads the customer blocks out of the header rows. Each block is a Quantity
 * column with its amount column immediately to the right; the row below the
 * label carries either a dated unit price (`3.30/unit`) or a bare `RM`.
 *
 * Only the first occurrence of a label is taken. These sheets repeat some names
 * further right as working columns (a second `TCC`, a second `The wet world`),
 * which are internal splits, not additional sales.
 */
export function mapCustomerColumns(
  sheet: Sheet,
  headerRow = 4,
  subHeaderRow = 5
): CustomerColumns[] {
  const row = sheet.cells[String(headerRow)]
  if (!row) return []
  const out: CustomerColumns[] = []
  const taken = new Set<string>()

  for (const col of Object.keys(row).sort((a, b) => COLS.indexOf(a) - COLS.indexOf(b))) {
    const cell = row[col]
    if (cell.t !== 'str' || typeof cell.v !== 'string') continue
    const label = cell.v.trim()
    const customer = canonicalCustomer(label)
    if (!customer || taken.has(customer)) continue

    // The column under the label must actually be a quantity column.
    const sub = cellAt(sheet, subHeaderRow, col)
    const subText = sub && typeof sub.v === 'string' ? sub.v.trim() : ''
    const isOcean = customer === 'Ocean Ice'
    if (!isOcean && !/^quantity/i.test(subText)) continue

    // Ocean Ice leads with a DO number, so its quantity sits one column further.
    const quantityCol = isOcean ? nextCol(col) : col
    const amountCol = nextCol(quantityCol)
    const priceLabel = cellAt(sheet, subHeaderRow, amountCol)

    taken.add(customer)
    out.push({
      label,
      customer,
      quantityCol,
      amountCol,
      unitPrice: parseUnitPriceLabel(
        priceLabel && typeof priceLabel.v === 'string' ? priceLabel.v : null
      ),
      isFreeTextPair: /blok\s*\/\s*crush/i.test(label),
    })
  }
  return out
}

/**
 * Header labels that sit above a real Quantity column but name nobody we know.
 * Restricting it to quantity columns keeps the working columns (`KFI`, `FM`,
 * `dif`, `Pro`, `crush`, `RM`) out of the report — they are not customers.
 */
export function unknownCustomerLabels(
  sheet: Sheet,
  headerRow = 4,
  subHeaderRow = 5
): string[] {
  const row = sheet.cells[String(headerRow)]
  if (!row) return []
  const out: string[] = []
  for (const [col, cell] of Object.entries(row)) {
    if (cell.t !== 'str' || typeof cell.v !== 'string') continue
    const label = cell.v.trim()
    if (label.length < 3 || canonicalCustomer(label)) continue
    const sub = cellAt(sheet, subHeaderRow, col)
    const subText = sub && typeof sub.v === 'string' ? sub.v.trim() : ''
    if (/^quantity/i.test(subText)) out.push(label)
  }
  return out
}
