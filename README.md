# KFI Ice Ops

Ice production, sales and electricity costing for KFI Cold Storage Sdn Bhd,
Pasar Borong Selangor. Replaces six hand-maintained Excel workbooks.

**Status: foundation complete.** Schema, tariff engine, cost engine and seed are
built and tested against the real bills and meter books. Entry screens,
dashboard, reports and importers are next. See `docs/00-inputs-required.md` for
the source review and what is still outstanding.

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

Without Docker, point `DATABASE_URL` at any PostgreSQL 16 instance.

## Layout

```
prisma/schema.prisma      schema; every table carries a note on why it exists
prisma/seed.ts            reference data, traceable to a source
src/lib/money.ts          Decimal helpers — half-up to the sen, set once
src/lib/tariff.ts         rate card and bill reconstruction
src/lib/bill-validation.ts  the checks that run before a bill review form opens
src/lib/cost-engine.ts    rate series, line energy, site bridge, cost of ice
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

## Testing

```bash
npm test          # 109 tests
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
