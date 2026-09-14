/**
 * TNB bill extraction.
 *
 * The model extracts; the reconstruction in src/lib/tariff.ts checks; a human
 * confirms. Nothing here ever writes a CONFIRMED bill — this is money, and a
 * parse that looks right is not the same as a parse that is right.
 *
 * The output is constrained by a schema rather than asked for as "JSON only",
 * so a malformed response is impossible by construction instead of by luck.
 */
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
// The SDK's helper is typed against Zod v4; zod 3.25 ships that surface at
// this subpath. Importing plain 'zod' here gives a v3 object the helper rejects.
import * as z from 'zod/v4'

/**
 * Mirrors the printed bill. Rates are embedded in the label text — `Tenaga
 * (RM0.2703/kWh)` — so extracting the rate as well as the amount gives a free
 * cross-check against the stored rate card.
 */
const MeterReadingSchema = z.object({
  meter_no: z.string(),
  unit: z.string().describe('kWh, kW or kVARh exactly as printed'),
  previous: z.number(),
  current: z.number(),
  usage: z.number(),
})

export const BillSchema = z.object({
  account_no: z.string().describe('NO. AKAUN, digits only'),
  invoice_no: z.string().describe('NO. INVOIS'),
  bill_date: z.string().describe('TARIKH BIL as YYYY-MM-DD'),
  period_start: z.string().describe('TEMPOH BIL start as YYYY-MM-DD'),
  period_end: z.string().describe('TEMPOH BIL end as YYYY-MM-DD'),
  days: z.number().int().describe('the (N Hari) figure'),
  kwh: z.number().describe('Jumlah Penggunaan Anda, kWh'),

  energy_rate: z.number().describe('rate inside the Tenaga label'),
  energy_rm: z.number(),
  afa_rate: z.number().describe(
    'rate inside the AFA label, in RINGGIT per kWh not sen. Negative when the ' +
      'line reads Rebat rather than Surcaj. Read it from the AFA charge line, ' +
      'never from the information panel, which lists several months.'
  ),
  afa_rm: z.number(),
  capacity_rate: z.number(),
  capacity_rm: z.number(),
  network_rate: z.number(),
  network_rm: z.number(),
  retail_rm: z.number().describe('Caj Peruncitan'),
  rebate_rate: z.number().describe('negative, e.g. -0.02'),
  rebate_rm: z.number().describe('negative'),

  current_usage_rm: z.number().describe('Caj Penggunaan Bulan Semasa'),
  kwtbb_rm: z.number().describe('KWTBB (1.6%)'),
  sst_rm: z.number().describe('service tax; 0 on these accounts'),
  current_charges_rm: z.number().describe('Caj Semasa'),
  previous_balance_rm: z.number().describe('Baki Terdahulu'),
  rounding_rm: z.number().describe('Pelarasan Penggenapan, often a sen either way'),
  total_rm: z.number().describe('Jumlah Bil Anda'),

  declared_kw: z.number().describe('Beban Diisytiharkan'),
  max_demand_kw: z.number().describe('Permintaan Maksima Tertinggi'),
  load_factor: z.number().describe('Faktor Beban'),
  power_factor: z.number().describe('Angkadar Kuasa'),

  meter_readings: z.array(MeterReadingSchema).describe(
    'every row under Maklumat Meter, including the kW and kVARh rows'
  ),
  confidence_notes: z.string().describe(
    'anything unreadable, ambiguous, or different from a standard bill; empty if none'
  ),
})

export type ParsedBill = z.infer<typeof BillSchema>

const SYSTEM = `You read Malaysian TNB electricity bills for a cold storage business.

The bills are in Bahasa Malaysia. The labels you need:
  Jumlah Penggunaan Anda — total consumption in kWh
  Caj Penjanaan → Tenaga, AFA, Kapasiti — generation charges
  Caj Rangkaian — network charge
  Caj Peruncitan — retail charge, a flat figure
  Caj-caj Lain → Rebat — rebate, always negative
  Caj Penggunaan Bulan Semasa — current month usage charge
  KWTBB (1.6%) — the renewable energy fund levy
  Caj Semasa — current charges
  Baki Terdahulu — previous balance
  Pelarasan Penggenapan — rounding adjustment
  Jumlah Bil Anda — total bill
  Maklumat Meter → Bacaan Meter Dahulu/Semasa, Penggunaan — meter readings

Read every figure from the bill itself. Do not compute, infer, or correct
anything: a figure you calculate would hide the very error the check downstream
exists to catch. If a figure is genuinely unreadable, say so in confidence_notes
rather than guessing at it.

Two specific traps:
  The AFA charge line carries the rate that was billed. A separate information
  panel lists the AFA rates for several months. Use the charge line.
  Each account has two physical meters, each reporting kWh, kW and kVARh.
  Capture all the rows; only the kWh rows sum to billed consumption.`

export interface ParseOptions {
  model?: string
  apiKey?: string
  client?: Anthropic
}

export interface ParseOutcome {
  ok: boolean
  bill?: ParsedBill
  /** Raw model output, stored untouched so a parser regression can be audited. */
  raw?: unknown
  error?: string
}

/**
 * The build specification names Sonnet for this job. It is configurable so the
 * choice can be revisited without touching code.
 */
export const DEFAULT_PARSER_MODEL = 'claude-sonnet-5'

export async function parseBillPdf(
  pdf: Buffer,
  opts: ParseOptions = {}
): Promise<ParseOutcome> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY
  if (!opts.client && !apiKey) {
    // Parsing is an accelerator, never a gate: without a key the upload still
    // stores the PDF and the review form opens empty for manual keying.
    return {
      ok: false,
      error:
        'No ANTHROPIC_API_KEY configured, so the bill was stored but not read. ' +
        'Enter the figures by hand, or set a key and re-run the parse.',
    }
  }

  const client = opts.client ?? new Anthropic({ apiKey })
  const model = opts.model ?? process.env.BILL_PARSER_MODEL ?? DEFAULT_PARSER_MODEL

  try {
    const response = await client.messages.parse({
      model,
      max_tokens: 16000,
      system: SYSTEM,
      thinking: { type: 'adaptive' },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                // Buffer base64 carries no newlines, which the API requires.
                data: pdf.toString('base64'),
              },
            },
            {
              type: 'text',
              text:
                'Extract every field from this bill exactly as printed. ' +
                'Both pages matter: the totals and the declared-load panel are on ' +
                'page 1, the charge breakdown and meter readings on page 2.',
            },
          ],
        },
      ],
      output_config: { format: zodOutputFormat(BillSchema) },
    })

    if (response.stop_reason === 'refusal') {
      return { ok: false, raw: response, error: 'The model declined to read this document.' }
    }
    if (!response.parsed_output) {
      return { ok: false, raw: response, error: 'The model returned no structured output.' }
    }
    return { ok: true, bill: response.parsed_output, raw: response }
  } catch (error) {
    // Most specific first: a rate limit is worth retrying, a bad request is not.
    if (error instanceof Anthropic.RateLimitError) {
      return { ok: false, error: 'Rate limited by the API. Try again shortly.' }
    }
    if (error instanceof Anthropic.AuthenticationError) {
      return { ok: false, error: 'The configured ANTHROPIC_API_KEY was rejected.' }
    }
    if (error instanceof Anthropic.BadRequestError) {
      return {
        ok: false,
        error:
          `The API rejected the request: ${error.message}. A bill over 32 MB or ` +
          `600 pages cannot be sent this way.`,
      }
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return { ok: false, error: 'Could not reach the API. The bill is stored; try the parse again.' }
    }
    if (error instanceof Anthropic.APIError) {
      return { ok: false, error: `API error ${error.status}: ${error.message}` }
    }
    throw error
  }
}

/** Maps the parsed shape onto what validateParsedBill expects. */
export function toValidationInput(bill: ParsedBill) {
  return {
    accountNo: bill.account_no,
    periodStart: bill.period_start,
    periodEnd: bill.period_end,
    kwh: bill.kwh,
    afaRatePerKwh: bill.afa_rate,
    energyRate: bill.energy_rate,
    capacityRate: bill.capacity_rate,
    networkRate: bill.network_rate,
    rebateRate: bill.rebate_rate,
    energyRm: bill.energy_rm,
    afaRm: bill.afa_rm,
    capacityRm: bill.capacity_rm,
    networkRm: bill.network_rm,
    retailRm: bill.retail_rm,
    rebateRm: bill.rebate_rm,
    currentUsageRm: bill.current_usage_rm,
    kwtbbRm: bill.kwtbb_rm,
    currentChargesRm: bill.current_charges_rm,
    previousBalanceRm: bill.previous_balance_rm,
    roundingRm: bill.rounding_rm,
    totalRm: bill.total_rm,
    meterReadings: bill.meter_readings.map((m) => ({
      meterNo: m.meter_no,
      unit: m.unit,
      usage: m.usage,
    })),
  }
}
