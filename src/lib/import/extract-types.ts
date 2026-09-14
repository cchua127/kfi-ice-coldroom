/** The JSON shape produced by scripts/import/extract.py. No interpretation. */

export interface Cell {
  /** How Excel stored it. `date` on a quantity column means silent corruption. */
  t: 'num' | 'str' | 'date' | 'bool' | 'empty'
  v: number | string | boolean | null
  /** Formula text, when the cell held one. */
  f: string | null
  /** Raw Excel serial, kept for date cells so a corruption can be reversed. */
  serial?: number
}

export interface Sheet {
  maxRow: number
  maxCol: number
  /** cells[row][column] — e.g. cells['8']['C']. Sparse. */
  cells: Record<string, Record<string, Cell>>
}

export interface Workbook {
  workbook: string
  sourceFile: string
  sha256: string
  extractedAt: string
  sheets: Record<string, Sheet>
}

export const cellAt = (sheet: Sheet, row: number, col: string): Cell | null =>
  sheet.cells[String(row)]?.[col] ?? null

/** Numeric value, or null. A `date`-typed cell is NOT silently coerced. */
export function num(sheet: Sheet, row: number, col: string): number | null {
  const c = cellAt(sheet, row, col)
  if (!c) return null
  if (c.t === 'num' && typeof c.v === 'number') return c.v
  if (c.t === 'bool') return c.v ? 1 : 0
  if (c.t === 'str' && typeof c.v === 'string' && c.v.trim() !== '') {
    const n = Number(c.v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export function str(sheet: Sheet, row: number, col: string): string | null {
  const c = cellAt(sheet, row, col)
  if (!c || c.v === null) return null
  return String(c.v).trim() || null
}

/** True when a row has no data in any of the given columns. */
export const rowEmpty = (sheet: Sheet, row: number, cols: string[]): boolean =>
  cols.every((c) => {
    const cell = cellAt(sheet, row, c)
    return !cell || cell.v === null || cell.v === ''
  })
