# KFI Ice Ops

Ice production, sales and electricity costing for KFI Cold Storage Sdn Bhd,
Pasar Borong Selangor. Replaces six hand-maintained Excel workbooks.

**Status:** schema, tariff and cost engines, importers, auth, the management
dashboard, the daily entry screen, the TNB bill upload and review, and the seven
reports are built and tested against the real bills and meter books. The
parallel-check screen is next. See `docs/00-inputs-required.md` for the source
review and what is still outstanding.

---

## Quick start

```bash
cp .env.example .env          # local defaults work as-is
docker compose up -d postgres
npm install
npm run db:migrate
npm run db:seed
npm test
npm run dev
```

Then create an account — there is no self-registration:

```bash
npx tsx scripts/create-user.ts --email you@kfi.local --name "Your Name" --role STAFF
```

To load the historical workbooks, put them in `data/source/` and run:

```bash
python3 scripts/import/extract.py data/source data/extract   # needs openpyxl, xlrd
npx tsx scripts/import/load.ts                               # dry run
npx tsx scripts/import/load.ts --write
npx tsx scripts/recompute.ts --summary
```

`data/` is git-ignored: the source workbooks and everything extracted from them
are the business's trading history and do not belong in the repository.

Without Docker, point `DATABASE_URL` at any PostgreSQL 16 instance.

## Layout

```
prisma/schema.prisma      schema; every table carries a note on why it exists
prisma/seed.ts            reference data, traceable to a source
src/lib/money.ts          Decimal helpers — half-up to the sen, set once
src/lib/tariff.ts         rate card and bill reconstruction
src/lib/bill-validation.ts  the checks that run before a bill review form opens
src/lib/cost-engine.ts    rate series, line energy, site bridge, cost of ice
src/lib/cost-recompute.ts pure recompute: entry in, dated cost rows out
src/lib/domain.ts         dated lookups — pack sizes, assumptions, prices
src/lib/import/           workbook parsers; layout resolved by label, not position
src/lib/auth.ts           signed sessions, bcrypt, role checks
src/components/charts.tsx server-rendered SVG charts
scripts/import/           extract.py (stage 1), load.ts (stages 2-3)
scripts/recompute.ts      rebuild daily costs after a bill or an assumption changes
scripts/create-user.ts    the only way an account is created
tests/fixtures/           extracted from the six bill PDFs and the meter books
docs/                     source review and outstanding inputs
deploy/                   droplet compose, Caddyfile, Dockerfile
```

## The electricity engine

Both accounts are on **Bukan Domestik Am Voltan Rendah** (Non-Domestic General,
Low Voltage). This is **not** a maximum-demand tariff: capacity is charged per
kWh, not per kW. `Permintaan Maksima Tertinggi`, `Beban Diisytiharkan`,
`Faktor Beban` and `Angkadar Kuasa` print for information and carry no charge,
so nothing alerts off them.

Every component except AFA has been constant since 1 July 2025:

| Component | Rate |
|---|---|
| Tenaga | RM 0.2703 /kWh |
| AFA | varies monthly |
| Kapasiti | RM 0.0883 /kWh |
| Caj Rangkaian | RM 0.1482 /kWh |
| Caj Peruncitan | RM 20.00 flat |
| Rebat (ex-Tariff D) | −RM 0.02 /kWh |
| KWTBB | 1.6% — on a base **excluding AFA and the retail charge** |

That KWTBB base is the one non-obvious step. Computing 1.6% on the full usage
figure throws the total out by RM0.30–5.00, which reads like a parser bug for a
long time before anyone finds it.

The bill is fully reproducible from kWh and the AFA rate, so every parsed bill is
reconstructed and checked to the cent before a human sees the review form. All
six bills on file reconstruct component by component — run `npm test`.

**Rates move only because AFA moves**, which means the month's rate can be
forecast before the bill arrives. `forecastSiteRate()` does that. It forecasts
the *rate*, not the bill: the sub-meters cover roughly three quarters of the
site, so a sub-meter-based volume forecast would be wrong by the size of the
unaccounted balance.

### Costing

```
site_rate    = SUM(current_charges_rm) / SUM(kwh)   across both accounts
ice_kwh      = tube + big_pool + bimc
cost_per_kg  = ice_kwh x site_rate / ice_kg
```

Cost of ice is a **sum of metered and modelled lines**, never a residual. The
unaccounted balance is reported as itself. Using "Ice" as a balancing figure was
the legacy report's fatal flaw: it loaded every site-wide tariff rise and every
unmetered load onto cost of ice.

Because free-of-charge ice ran 25.6% of blocks moved in H1 2026, cost per kg is
computed on an explicit basis — `PRODUCED`, `MOVED` or `SOLD` — and every report
states which it used.

Each day carries a rate, a status (`PROVISIONAL` or `FINAL`) and a basis
(`CONFIRMED_BILL`, `AFA_FORECAST`, `CARRIED_FORWARD`). A day is final only when
every account has a confirmed bill covering it. Confirming a bill recomputes the
affected days and flips them. She keys in daily; the truth arrives monthly; the
system restates itself instead of her.

## Migration

Three stages, because the source workbooks are messier than they look:

1. **`scripts/import/extract.py`** dumps every cell to JSON and interprets
   nothing. Two of the six workbooks are legacy BIFF, which no maintained
   JavaScript library reads; the intermediate is also what makes the migration
   reviewable before anything is written.
2. **`src/lib/import/`** turns cells into records, under test. Sheet months come
   from each sheet's own marker before its name, and columns are resolved by
   header label — that workbook grows from 35 to 41 columns as customers come
   and go, and two of its sheets are a year older than their names suggest.
3. **`scripts/import/load.ts`** writes, idempotently, and only with `--write`.

The master workbook is deliberately not a source: it re-types the detail files,
so importing it would double-count. It is the parallel-run comparison target.

## Daily entry

One screen per day, not one per workbook: `/entry/2026-09-01` holds the meters,
production, counter cash, outside sales and purchases for that date. Openings
auto-fill from the previous reading and are read-only, so the two can never
disagree. Everything computes live — kWh per meter, kg per row, the day total,
cash and sale amounts — and the month strip shows at a glance which days are
still missing.

Labels keep her vocabulary: Mula and Akhir, Baris, Tong Kosong, Tong Kecil.

Validation lives in `src/lib/validation.ts` and runs in both places. The browser
copy is for immediate feedback; the server copy decides, because a form post is
not a trusted input. Hard stops are the things that corrupted the spreadsheets —
a closing below the previous reading, empty cans exceeding the cans filled, FOC
above production. Everything else warns and lets her past with a note: she knows
the plant better than the rule does.

Autosave runs about two seconds after the last keystroke, but never writes while
a blocking error stands. Enter moves to the next field and saves.

## TNB bills

Drop the PDF on `/bills`. The document is stored by content hash and kept
forever — it is the evidence behind every costed month. Claude reads it into a
schema-constrained shape (`output_config.format`, not "please reply with JSON"),
the reconstruction checks every line, and the review form shows the bill and the
arithmetic side by side with each difference in sen.

**Nothing is ever confirmed automatically.** The model extracts, the
reconstruction checks, a person confirms — and the Confirm button stays disabled
while any line disagrees or the meter rows do not sum to billed consumption.
Confirming re-validates everything server-side, because the form is not trusted.

Parsing is an accelerator, not a gate. With no `ANTHROPIC_API_KEY` the upload
still stores the PDF and the review form opens for manual keying; `reparseBill`
picks it up again once a key is configured. The model is set by
`BILL_PARSER_MODEL` and defaults to the one the build spec chose.

After confirming a bill, run `npx tsx scripts/recompute.ts` to restate the days
it covers from provisional to final.

## Reports

Seven reports at `/reports/<slug>?month=YYYY-MM`, each rendering three ways from
one structure — on screen, as Excel, and printed A4 landscape. That is
deliberate: during the parallel run she will be holding a printout against a
spreadsheet against a screen, and three renderers over one data shape cannot
disagree the way three implementations eventually would.

| Report | What it adds over the workbook it replaces |
|---|---|
| Daily Rekod Ais | The master layout column for column, plus electricity RM, RM/kg, and correctly labelled ratios |
| Tube plant | Meter, kWh, production, kg, RM, kWh/kg |
| Big pool | The same, with no `+429` booking and no `x1.2` loader |
| Daily cash | Shifts, cumulative, running average, prior month |
| Outside sales and purchases | By customer, at the price in force on the day |
| Monthly electricity reconciliation | Both bills, each checked against the reconstruction, then the site bridge |
| Cost of ice | Per line and combined, with the month-on-month move split into tariff and plant |

Every export carries the company, the period, the generation timestamp and
whether the figures are final. A provisional number must never leave the
building unlabelled.

Excel number formats are the ones the spec names: `#,##0.00` money, `#,##0` kWh
and kg, `0.0000` RM/kWh, `0.000` kWh/kg.

## Dashboard

Mobile-first, same URL for both roles. Colour follows the validated categorical
order and is assigned per production line, so a line keeps its colour when
another is filtered out. Two of the light-mode hues sit below 3:1 against the
surface, so every chart ships direct labels and the same figures as a table.

There is no dual-axis chart anywhere. Cost per kg and the AFA rate share an
x-axis as two stacked panels instead: a second y-scale would let the reader
infer a relationship from whatever the scaling happened to produce.

## Testing

```bash
npm test          # 186 tests
npm run typecheck
```

The fixtures are generated from source documents, not typed by hand:
`tests/fixtures/tnb-bills.json` from the six PDFs, and
`tests/fixtures/monthly-production.json` from the tube and big pool meter books.

## Deployment

Local-first by design. `deploy/` carries the droplet stack with every
credential as a `REPLACE_ME` placeholder; nothing sensitive lives in the repo.

Before the first start on the droplet:

1. Point `SITE_DOMAIN` at the droplet in DNS, or Caddy's ACME challenge fails.
2. Copy `.env.example` to `.env` on the host and fill every `REPLACE_ME`.
   Generate `AUTH_SECRET` with `openssl rand -base64 32`.
3. Confirm ports 80 and 443 are free — check for an existing reverse proxy.
4. `docker compose -f deploy/docker-compose.prod.yml up -d`
5. `docker compose -f deploy/docker-compose.prod.yml exec app npx prisma migrate deploy`

### Backups

Nightly `pg_dump` plus a `/data/uploads` tarball to DO Spaces, 30-day retention.

```bash
# Backup
docker compose -f deploy/docker-compose.prod.yml exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > "kfi-$(date +%F).dump"
tar czf "uploads-$(date +%F).tar.gz" -C /var/lib/docker/volumes/deploy_uploads/_data .

# Restore
docker compose -f deploy/docker-compose.prod.yml exec -T postgres \
  pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists < kfi-YYYY-MM-DD.dump
```

**Rehearse the restore once before cutover.** A backup that has never been
restored is not a backup.

## Conventions

- Money, kWh and kg are `Decimal`. No floats — a float round-trip loses the cent
  that the bill reconstruction depends on.
- Business dates are `date`, never timestamps. Instants are `timestamptz`. The
  database runs in UTC and the UI renders Asia/Kuala_Lumpur.
- Prices are snapshotted onto sale rows. A price change next year must never
  restate last year's invoices.
- Ratios are never summed. A monthly ratio comes from monthly totals, and a
  month average divides by the days that actually have data.
- A modelled number must never look like a measured one: every line carries
  `METERED` or `MODELLED`, and every calibrated assumption says so in its note.
