/**
 * One report shape feeds the screen, the Excel export and the printed page.
 *
 * That is deliberate. During the parallel run she will be comparing a printout
 * against a spreadsheet against a screen; three renderers over one structure
 * cannot disagree, three separate implementations eventually will.
 */

export type CellType =
  | 'text'
  | 'date'
  | 'int' // kWh and kg — #,##0
  | 'money' // ringgit — #,##0.00
  | 'rate4' // RM/kWh — 0.0000
  | 'ratio3' // kWh/kg — 0.000
  | 'percent'

export interface ReportColumn {
  key: string
  label: string
  /** The label as her sheets write it, shown underneath. */
  labelBm?: string
  type: CellType
  /** Excel column width in characters. */
  width?: number
  /** Shown as a footnote marker; used where the legacy header was wrong. */
  note?: string
}

export type CellValue = string | number | null

export interface ReportRow {
  cells: Record<string, CellValue>
  /** Rendered in bold and frozen out of sorting — TOTAL and average rows. */
  emphasis?: boolean
}

export interface ReportTable {
  title: string
  subtitle?: string
  columns: ReportColumn[]
  rows: ReportRow[]
  notes?: string[]
}

export interface ReportMeta {
  slug: string
  name: string
  /** 'YYYY-MM' */
  period: string
  generatedAt: string
  /** PROVISIONAL when any contributing figure is. Never mixed without saying so. */
  status?: 'PROVISIONAL' | 'FINAL' | 'MIXED' | 'NO_RATE'
}

export interface Report {
  meta: ReportMeta
  tables: ReportTable[]
}

/** Excel number formats, per the build specification. */
export const EXCEL_FORMAT: Record<CellType, string> = {
  text: '@',
  date: 'yyyy-mm-dd',
  int: '#,##0',
  money: '#,##0.00',
  rate4: '0.0000',
  ratio3: '0.000',
  percent: '0.0%',
}

export function formatCell(value: CellValue, type: CellType): string {
  if (value === null || value === '') return '—'
  if (typeof value === 'string') return value
  switch (type) {
    case 'int':
      return value.toLocaleString('en-MY', { maximumFractionDigits: 0 })
    case 'money':
      return value.toLocaleString('en-MY', {
        minimumFractionDigits: 2, maximumFractionDigits: 2,
      })
    case 'rate4':
      return value.toFixed(4)
    case 'ratio3':
      return value.toFixed(3)
    case 'percent':
      return `${(value * 100).toFixed(1)}%`
    default:
      return String(value)
  }
}

export const REPORTS = [
  { slug: 'daily-rekod', name: 'Daily Rekod Ais' },
  { slug: 'tube', name: 'Tube plant' },
  { slug: 'big-pool', name: 'Big pool' },
  { slug: 'cash', name: 'Daily cash' },
  { slug: 'outside', name: 'Outside sales and purchases' },
  { slug: 'electricity', name: 'Monthly electricity reconciliation' },
  { slug: 'cost-of-ice', name: 'Cost of ice' },
  // The six from the owner's LIVE cost template. The seven above answer what
  // happened on the ice lines; these answer where the rest of the electricity
  // went, and whether the month can be closed.
  { slug: 'site-energy', name: 'Site energy statement' },
  { slug: 'efficiency', name: 'Efficiency by machine' },
  { slug: 'foc-watch', name: 'FOC and defect watch' },
  { slug: 'coldroom', name: 'Coldroom recovery' },
  { slug: 'sales-margin', name: 'Sales by channel and margin' },
  { slug: 'month-close', name: 'Month close' },
] as const

export type ReportSlug = (typeof REPORTS)[number]['slug']
