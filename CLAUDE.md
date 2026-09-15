# CLAUDE.md

## What this is

**KFI Ice Ops** replaces six hand-maintained Excel workbooks for KFI Cold Storage
Sdn Bhd, an ice manufacturer at Pasar Borong Selangor.

The reason it exists matters more than the feature list. The workbooks compute
cost of ice at a **frozen pre-July-2025 tariff of RM0.484/kWh**, understating the
real rate by 7.6–10.1%, and they carry six other named defects. The rebuild's job
is to make each of those defects *structurally impossible* — not merely absent.

So: a change that reintroduces one of those defects is a regression even if every
test passes. If a figure here looks higher than the old sheet, that is usually the
system working, not a bug.

## Commands

```bash
npm test                    # 434 tests, vitest — the real gate
npm run typecheck           # tsc --noEmit, must be silent
npm run build               # next build (output: standalone)
npm run dev                 # next dev
npm run db:seed             # convergent, safe to re-run
npx tsx scripts/recompute.ts --summary       # monthly cost-of-ice roll-up
npx tsx scripts/create-user.ts --email ... --name ... --role MANAGER
```

**`npm run lint` does not work.** ESLint was never configured, so `next lint`
drops into an interactive setup prompt and hangs. Don't run it; don't "fix" it
as a side quest either. Use `npm run typecheck`.

Local Postgres is at `postgresql://kfi:kfi_dev_password@localhost:5432/kfi_ice`.
If it has been reaped, restart it as its data directory's owner:

```bash
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pgdata -l /tmp/pgdata/server.log start"
```

## Invariants

Each of these exists because a specific spreadsheet defect depended on breaking
it. Don't relax one without understanding which.

- **Money, kWh and kg are `Decimal` (decimal.js, ROUND_HALF_UP). No floats
  anywhere.** A float round-trip loses the cent the bill reconstruction depends
  on, and that reconstruction ties to the cent against six real TNB bills.
- **The tariff rounds per component, not in aggregate.** `reconstructBill()` in
  `src/lib/tariff.ts` rounds Tenaga, Kapasiti, Rangkaian, Peruncitan, Rebat and
  KWTBB individually. KWTBB is 1.6% on a base that **excludes AFA and the retail
  charge**. Aggregate rounding misses July account 7610 by cents.
- **Lookups are dated (`asAt`).** Prices, pack sizes and cost assumptions resolve
  as at a business date, and sale rows snapshot the price they were sold at.
  Restating a price must never rewrite last year's invoices.
- **Never store a total that can be derived.** `CashSalesDaily` deliberately has
  no total column — a column that does not exist cannot drift. Resist adding one
  "for performance".
- **A modelled number must never look like a measured one.** Every line carries
  `METERED` or `MODELLED`; every costed day carries `PROVISIONAL | FINAL |
  NO_RATE` with an explicit `rateBasis`. Days with no bill are left `NO_RATE`,
  not guessed — guessing is exactly what the old workbooks did.
- **Ratios are never summed.** A monthly ratio comes from monthly totals; a month
  average divides by the days that actually have data.
- **Cost of ice carries its support plant.** Ice is the four production lines
  *plus* the 30HP brine compressor and the D10-D12 storage rooms, which freeze
  and hold ice while making none. Leaving them out understated cost of ice by
  about a sen per kilogram and parked the difference in the site residual —
  a quieter version of the legacy report's fatal habit of treating ice as the
  balancing figure. It also carries the ice-feed water, by owner decision —
  the water is free, the electricity that pumps it is not, and it becomes the
  ice (§10.3). Which consumers count is `energy_use.counts_as_ice`, a column,
  not a constant in the cost engine, because a convention frozen into code is
  how RM0.484/kWh survived a decade. `tests/workbook-template.test.ts` pins the
  template's own convention explicitly rather than inheriting the default, so
  changing ours does not read as an arithmetic break.
- **The coldroom has three sources and always says which one it used.**
  `coldroomSplit()` takes the per-room REGISTER first, a WHOLE_METER total
  second, and the BACK_INFERRED ringgit-over-RM0.484 path only as a last resort.
  The last is circular — a quantity from a price — so it is `MODELLED`, its
  basis opens `BACK-INFERRED:`, a check flags it and the entry screen warns. It
  exists so a month nobody read is not absent from the bridge, not because it is
  trustworthy. Dec 2025 – Aug 2026 are on the register and need none of it.
- **Own use follows the occupant, not the room number.** D10-D12 are KFI's rooms
  *by convention*; `isOwnUseTenant()` asks who was actually in them. The owner's
  cost template used the convention and charged a tenant 1,577 kWh of March
  2026's refrigeration to the cost of ice (§11.3). `CONVENTIONAL_OWN_USE_ROOMS`
  is kept only so the importer can report where the two part company.
- **A coldroom row is keyed by position, never by room code.** Two different
  rooms are both labelled `D5`, and a room re-let mid-month appears twice with a
  continuous register across the handover. Keying on the code silently drops one
  row of each pair.
- **A check with nothing to check is not a pass.** `src/lib/checks.ts` returns
  `NO_DATA`, never `OK`, and names what is missing. An early draft read an
  absent coldroom flag as "read from the sub-meter" — a green tick over an empty
  month, which is exactly the failure the checks exist to catch.
- **The seed must stay convergent.** `prisma/seed.ts` deletes any price epoch it
  no longer declares, for the pairs it manages. An upsert-only seed silently left
  orphaned epochs and mis-priced five months of history — that bug shipped once
  and was caught only by the parallel check.

## Dates and time — read this before touching anything date-shaped

The container runs `TZ=UTC`; the plant runs at UTC+8 and staffs a night shift.
Two superficially identical expressions, one correct and one a bug:

```ts
row.prodDate.toISOString().slice(0, 10)   // CORRECT — reading back a `date`
                                          // column, which Prisma hands back as
                                          // UTC midnight.

new Date().toISOString().slice(0, 10)     // BUG — deriving *today*. From
                                          // midnight to 8am Malaysian time this
                                          // is yesterday.
```

Anything meaning **now** goes through `src/lib/clock.ts`: `businessToday()`,
`businessMonth()`, `shiftMonth()`, `formatStamp()`. Server-rendered timestamps
(printed sheets, Excel footers) must name the zone — `toLocaleString('en-MY')` on
the server renders in UTC.

Business dates are `date`. Instants are `timestamptz`.

## Deployment

- **Admin commands run in the `ops` image, never `app`.** The runtime image
  carries no Prisma CLI, no `tsx` and no sources on purpose. Use
  `bash scripts/ops.sh <command>`. `docker compose exec app npx prisma ...` will
  not work.
- **Always pass `--env-file .env`.** Compose reads `.env` from the directory of
  the compose file (`deploy/`), not the repo root. Without the flag every
  `${VAR}` interpolates empty.
- **`.dockerignore` keeps `.env` out of the image.** Next copies a root `.env`
  into `.next/standalone`, which the runner stage copies wholesale. Don't
  weaken those patterns.
- `bash scripts/preflight.sh` before a first deploy. `docs/02-setup-runbook.md`
  is the full sequence; `docs/01-production.md` explains why each stage exists.

## Traps that have already cost hours here

- **A stale `next-server` will serve an old build under a rebuilt `.next`.** If a
  change doesn't appear, find the listener (`lsof -ti :3000`) and kill it *by
  PID*, then verify the served CSS hash. Matching processes by cmdline substring
  also matches your own shell — `pkill -f next` kills the shell running it.
- **`next start` does not exercise what production runs.** The container runs
  `node .next/standalone/server.js`. Verify against that, with `public/`,
  `.next/static/` and `prisma/` copied in as the Dockerfile does.
- **A `next-server` process renames its own cmdline.** It will not match a grep
  for `standalone/server.js`, and `lsof -ti :3000` did not find it either — so
  a rebuilt `.next` was served stale for several checks in a row while every
  kill appeared to succeed. Scan `/proc/*/cmdline` for `next-server` when the
  port is held by something you cannot see, and confirm the new PID is actually
  listening before trusting what you read.
- **The parallel check is the acceptance test, not the unit tests.**
  `/parallel` compares the system against the hand-kept `Daily rekod Ais`. It has
  caught things no unit test could: a missing formula understating May by
  9,000 kg, sheets labelled Oct/Nov that are 2025, a June price rise the sheet
  applied from January.

## Monthly inputs are a separate screen, deliberately

Almost everything is keyed daily, which is right for a plant that runs daily.
Two things are not: the coldroom arrives as a compilation of ringgit and the
water as a delivery tonnage. `/monthly/[month]` takes them, one row per month,
and `recomputeEnergyUses()` spreads them over the days. Forcing either onto the
daily screen would mean inventing a daily figure — a made-up number sitting
where a keyed one belongs.

Blank and zero differ there and the validation enforces it: a blank sub-meter
reading means "not read", a zero claims rooms holding -18C drew nothing.
Clearing every field deletes the row rather than storing zeros, because a row of
zeros reads as a measurement.

## Where the record lives

`docs/00-inputs-required.md` is the running findings log — every discrepancy
found in the source workbooks, what was assumed, and what is still outstanding.
**Append to it when you find something**; it is the reason anyone can trust a
number that disagrees with the old sheet.

Still open, and worth knowing before you touch related code:

- **The pre-June counter small-block price is an inference**, not a reading:
  RM12, from the June rise moving every other product 8–10% and three of five
  months saying 12 (§10.5). The counter-reconciliation check in
  `src/lib/checks.ts` will contradict it the moment counter units are recorded
  for any month from January to May. Load one and look.
- **Good Taste billing.** The system bills per block (RM26.40). The sheet bills
  counted pieces plus crush bags at RM3.30, and the tally runs 7.7–8.2 per block,
  not a fixed 8. That gap is the entire residual in the parallel check. Unresolved
  — see §9.1.
- **The coldroom letting business is nearly underwater.** The tenant rate is
  fixed at RM0.543 while the blended tariff reached RM0.5328 in August 2026 —
  a spread of 1.02 sen/kWh against 9.8 sen in January, worth RM579 on the month.
  One AFA move takes it negative. The check catches the crossing; the decision
  is the owner's and is better taken before it than after. §11.6.
- **`E-2026.xls` covers Dec 2025 – Aug 2026 only.** Months outside that range
  still fall back to the RM0.484 back-inference. The `ave` sheet holds per-room
  2025 history and is deliberately not loaded — §11.8.
- **The Docker image build has never been executed** — no daemon in the
  development environment.
- **The bill parser has never run against a real API key** — tested with a
  stubbed client. Without a key, upload works and the review form opens empty for
  manual keying; that is the designed fallback, not a degraded mode.

## House style

Comments explain *why*, especially where the code encodes a business rule or
guards against a defect that has actually occurred. Match the surrounding density
— this codebase comments the reasoning, not the syntax. Commit messages say what
changed and what it prevents.
