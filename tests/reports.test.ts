import { describe, it, expect } from 'vitest'
import { formatCell, EXCEL_FORMAT, REPORTS } from '@/lib/reports/types'
import { statusLabel, filenameFor } from '@/lib/reports/excel'

describe('cell formatting', () => {
  // Screen and Excel must present the same figure the same way; these are the
  // formats the build specification names.
  it.each([
    [1234.5, 'money', '1,234.50'],
    [69507, 'int', '69,507'],
    [0.52071, 'rate4', '0.5207'],
    [0.13549, 'ratio3', '0.135'],
    [0.256, 'percent', '25.6%'],
    [null, 'money', '—'],
  ] as const)('renders %s as %s', (value, type, expected) => {
    expect(formatCell(value, type)).toBe(expected)
  })

  it('uses the specified Excel number formats', () => {
    expect(EXCEL_FORMAT.money).toBe('#,##0.00')
    expect(EXCEL_FORMAT.int).toBe('#,##0')
    expect(EXCEL_FORMAT.rate4).toBe('0.0000')
    expect(EXCEL_FORMAT.ratio3).toBe('0.000')
  })
})

describe('status labelling', () => {
  // A figure that leaves the building unlabelled is the problem this replaces.
  it('says plainly when a report is not final', () => {
    expect(statusLabel('PROVISIONAL')).toMatch(/PROVISIONAL/)
    expect(statusLabel('MIXED')).toMatch(/some days final, some provisional/)
    expect(statusLabel('NO_RATE')).toMatch(/NOT COSTED/)
    expect(statusLabel('FINAL')).toBe('Final')
  })
})

describe('export filename', () => {
  it('is safe on every filesystem', () => {
    const name = filenameFor({
      meta: { slug: 'cost-of-ice', name: 'Cost of ice', period: '2026-08',
        generatedAt: new Date().toISOString() },
      tables: [],
    })
    expect(name).toBe('KFI Cost of ice 2026-08.xlsx')
    expect(name).not.toMatch(/[\\/:*?"<>|]/)
  })
})

describe('report catalogue', () => {
  it('covers all seven reports the specification lists', () => {
    expect(REPORTS.map((r) => r.slug)).toEqual([
      'daily-rekod', 'tube', 'big-pool', 'cash', 'outside', 'electricity', 'cost-of-ice',
    ])
  })
})
