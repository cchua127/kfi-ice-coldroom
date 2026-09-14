/**
 * Excel export. Same report structure as the screen and the printout, so the
 * three can never disagree — which is the whole point during a parallel run.
 */
import { formatStamp } from '@/lib/clock'
import ExcelJS from 'exceljs'
import { EXCEL_FORMAT, type Report, type ReportTable } from './types'

const COMPANY = 'KFI Cold Storage Sdn Bhd'

export async function reportToWorkbook(report: Report): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'KFI Ice Ops'
  wb.created = new Date()

  for (const table of report.tables) {
    // Excel refuses these characters in a sheet name and caps it at 31 chars.
    const safe = table.title.replace(/[\\/*?:[\]]/g, ' ').slice(0, 31)
    addSheet(wb.addWorksheet(safe, {
      pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1 },
    }), report, table)
  }
  return Buffer.from(await wb.xlsx.writeBuffer())
}

function addSheet(ws: ExcelJS.Worksheet, report: Report, table: ReportTable) {
  const width = table.columns.length

  const title = ws.addRow([COMPANY])
  title.font = { bold: true, size: 13 }
  ws.mergeCells(title.number, 1, title.number, Math.max(width, 1))

  const sub = ws.addRow([`${table.title} — ${report.meta.period}`])
  sub.font = { bold: true, size: 11 }
  ws.mergeCells(sub.number, 1, sub.number, Math.max(width, 1))

  if (table.subtitle) {
    const s = ws.addRow([table.subtitle])
    s.font = { italic: true, size: 9, color: { argb: 'FF666666' } }
    ws.mergeCells(s.number, 1, s.number, Math.max(width, 1))
  }

  // Provisional figures must never leave the building unlabelled.
  const stamp = ws.addRow([
    `Generated ${formatStamp(report.meta.generatedAt)}` +
      (report.meta.status ? ` · ${statusLabel(report.meta.status)}` : ''),
  ])
  stamp.font = { size: 9, color: { argb: 'FF666666' } }
  ws.mergeCells(stamp.number, 1, stamp.number, Math.max(width, 1))
  ws.addRow([])

  const header = ws.addRow(table.columns.map((c) => c.label))
  header.font = { bold: true }
  header.alignment = { vertical: 'bottom', wrapText: true }
  header.eachCell((cell) => {
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF999999' } } }
  })
  const headerRowNumber = header.number

  for (const row of table.rows) {
    const r = ws.addRow(table.columns.map((c) => row.cells[c.key] ?? null))
    if (row.emphasis) {
      r.font = { bold: true }
      r.eachCell((cell) => {
        cell.border = { top: { style: 'thin', color: { argb: 'FF999999' } } }
      })
    }
    r.eachCell((cell, i) => {
      const col = table.columns[i - 1]
      if (!col) return
      cell.numFmt = EXCEL_FORMAT[col.type]
      if (col.type !== 'text') cell.alignment = { horizontal: 'right' }
    })
  }

  table.columns.forEach((c, i) => {
    ws.getColumn(i + 1).width = c.width ?? 14
  })
  // Freeze the header so a long month stays readable while scrolling.
  ws.views = [{ state: 'frozen', ySplit: headerRowNumber }]

  const footnotes = [
    ...table.columns.filter((c) => c.note).map((c) => `${c.label}: ${c.note}`),
    ...(table.notes ?? []),
  ]
  if (footnotes.length) {
    ws.addRow([])
    for (const note of footnotes) {
      const r = ws.addRow([note])
      r.font = { size: 9, color: { argb: 'FF666666' } }
      ws.mergeCells(r.number, 1, r.number, Math.max(width, 1))
    }
  }
}

export const statusLabel = (s: NonNullable<Report['meta']['status']>): string =>
  s === 'FINAL' ? 'Final'
    : s === 'PROVISIONAL' ? 'PROVISIONAL — costed at an unconfirmed rate'
    : s === 'MIXED' ? 'MIXED — some days final, some provisional'
    : 'NOT COSTED — no bill and no published AFA for this period'

export const filenameFor = (report: Report): string =>
  `KFI ${report.meta.name} ${report.meta.period}.xlsx`.replace(/[\\/:*?"<>|]/g, '-')
