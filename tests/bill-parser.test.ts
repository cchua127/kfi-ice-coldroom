import { describe, it, expect } from 'vitest'
import fixtures from './fixtures/tnb-bills.json'
import {
  parseBillPdf, toValidationInput, BillSchema, DEFAULT_PARSER_MODEL,
  type ParsedBill,
} from '@/lib/bill-parser'
import { validateParsedBill, hasBlockingFinding } from '@/lib/bill-validation'
import { checkUpload, storagePathFor, sha256 } from '@/lib/documents'
import type Anthropic from '@anthropic-ai/sdk'

/** Builds what a correct parse of a fixture bill would look like. */
function parsedFrom(f: (typeof fixtures)[number]): ParsedBill {
  return {
    account_no: f.accountNo,
    invoice_no: f.invoiceNo ?? '000000000000',
    bill_date: f.billDate,
    period_start: f.periodStart,
    period_end: f.periodEnd,
    days: f.days,
    kwh: Number(f.kwh),
    energy_rate: Number(f.energyRate), energy_rm: Number(f.energyRm),
    afa_rate: Number(f.afaRatePerKwh), afa_rm: Number(f.afaRm),
    capacity_rate: Number(f.capacityRate), capacity_rm: Number(f.capacityRm),
    network_rate: Number(f.networkRate), network_rm: Number(f.networkRm),
    retail_rm: Number(f.retailRm),
    rebate_rate: Number(f.rebateRate), rebate_rm: Number(f.rebateRm),
    current_usage_rm: Number(f.currentUsageRm),
    kwtbb_rm: Number(f.kwtbbRm),
    sst_rm: 0,
    current_charges_rm: Number(f.currentChargesRm),
    previous_balance_rm: Number(f.previousBalanceRm),
    rounding_rm: Number(f.roundingRm),
    total_rm: Number(f.totalRm),
    declared_kw: Number(f.declaredKw), max_demand_kw: Number(f.maxDemandKw),
    load_factor: Number(f.loadFactor), power_factor: Number(f.powerFactor),
    meter_readings: f.meterReadings.map((m) => ({
      meter_no: m.meterNo, unit: m.unit,
      previous: Number(m.previous), current: Number(m.current), usage: Number(m.usage),
    })),
    confidence_notes: '',
  }
}

/** A client that returns whatever the test hands it, so the wiring is testable. */
const stubClient = (result: unknown, stopReason = 'end_turn'): Anthropic =>
  ({
    messages: {
      parse: async () => ({ stop_reason: stopReason, parsed_output: result }),
    },
  }) as unknown as Anthropic

const CTX = { knownAccountNos: ['220275147610', '220278867506'] }

describe('extraction schema', () => {
  it('accepts a correctly shaped bill', () => {
    expect(() => BillSchema.parse(parsedFrom(fixtures[0]))).not.toThrow()
  })

  it('rejects a bill missing a charge line rather than defaulting it', () => {
    const { energy_rm, ...incomplete } = parsedFrom(fixtures[0])
    void energy_rm
    expect(() => BillSchema.parse(incomplete)).toThrow()
  })

  it('names the model the build spec chose, overridable by environment', () => {
    expect(DEFAULT_PARSER_MODEL).toBe('claude-sonnet-5')
  })
})

describe('parse outcome handling', () => {
  it('returns the bill when the model reads it', async () => {
    const expected = parsedFrom(fixtures[0])
    const out = await parseBillPdf(Buffer.from('%PDF-'), { client: stubClient(expected) })
    expect(out.ok).toBe(true)
    expect(out.bill?.account_no).toBe(fixtures[0].accountNo)
  })

  it('reports a refusal instead of returning half a bill', async () => {
    const out = await parseBillPdf(Buffer.from('%PDF-'), {
      client: stubClient(null, 'refusal'),
    })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/declined/)
  })

  it('reports empty structured output as a failure', async () => {
    const out = await parseBillPdf(Buffer.from('%PDF-'), { client: stubClient(null) })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/no structured output/)
  })

  it('explains itself when no API key is configured, rather than throwing', async () => {
    // Parsing is an accelerator, not a gate: the upload still has to work.
    const saved = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    const out = await parseBillPdf(Buffer.from('%PDF-'))
    process.env.ANTHROPIC_API_KEY = saved
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/Enter the figures by hand/)
  })
})

describe('a parsed bill through the checks', () => {
  it.each(fixtures)('$accountNo $periodStart passes with no blocking finding', (f) => {
    const findings = validateParsedBill(toValidationInput(parsedFrom(f)), CTX)
    expect(findings.filter((x) => x.severity === 'ERROR')).toEqual([])
  })

  it('catches a misread digit as a field-level difference in sen', () => {
    // The failure mode that matters: a plausible-looking number in one line.
    const bill = parsedFrom(fixtures[0])
    bill.kwtbb_rm = bill.kwtbb_rm + 1
    const findings = validateParsedBill(toValidationInput(bill), CTX)
    const hit = findings.find((x) => x.field === 'kwtbbRm')
    expect(hit?.code).toBe('RECONSTRUCTION_BREAK')
    expect(hit?.message).toMatch(/\+100 sen/)
    expect(hasBlockingFinding(findings)).toBe(true)
  })

  it('catches an AFA rate read from the information panel instead of the charge line', () => {
    // The panel lists the previous month too; taking the wrong one throws every
    // downstream line out at once.
    const bill = parsedFrom(fixtures[0]) // June 2026, billed at 0.0259
    bill.afa_rate = 0.0138 // May's rate, as printed in the same panel
    const findings = validateParsedBill(toValidationInput(bill), CTX)
    expect(hasBlockingFinding(findings)).toBe(true)
    expect(findings.some((f) => f.field === 'afaRm')).toBe(true)
    expect(findings.some((f) => f.field === 'totalRm')).toBe(true)
  })

  it('catches a dropped meter row', () => {
    const bill = parsedFrom(fixtures[0])
    bill.meter_readings = bill.meter_readings.filter((m) => m.unit !== 'kWh').concat(
      bill.meter_readings.filter((m) => m.unit === 'kWh').slice(0, 1)
    )
    const findings = validateParsedBill(toValidationInput(bill), CTX)
    expect(findings.some((f) => f.code === 'METER_SUM_MISMATCH')).toBe(true)
  })
})

describe('upload guards', () => {
  it.each([
    ['bill.pdf', 1024, null],
    ['bill.PDF', 1024, null],
    ['bill.xlsx', 1024, 'Only PDF bills can be uploaded.'],
    ['bill.pdf', 0, 'That file is empty.'],
  ])('checks %s at %i bytes', (name, size, expected) => {
    expect(checkUpload(name, size)).toBe(expected)
  })

  it('refuses a file the API would reject, with the reason', () => {
    const msg = checkUpload('big.pdf', 40 * 1024 * 1024)
    expect(msg).toMatch(/40\.0 MB.*limit is 32 MB/)
  })
})

describe('document storage', () => {
  it('addresses a file by its content, sharded two levels deep', () => {
    const hash = sha256(Buffer.from('hello'))
    const path = storagePathFor(hash, 'Bill Sept.PDF')
    expect(path).toBe(`${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.pdf`)
  })

  it('gives the same path to the same bytes, so a duplicate cannot fork', () => {
    const a = storagePathFor(sha256(Buffer.from('x')), 'a.pdf')
    const b = storagePathFor(sha256(Buffer.from('x')), 'b.pdf')
    expect(a).toBe(b)
  })
})
