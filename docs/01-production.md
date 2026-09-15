# Going into production

From a bare droplet to the day the workbooks are archived read-only.

Written to be followed in order. Each stage ends with something you can check,
because the failure mode that matters here is not a crash — it is a system that
comes up, looks right, and quietly reports a different number than the sheet.

---

## 0. Where this stands today

**Verified, on real data.** All six TNB bills reconstruct component by component
to the cent. The full history is migrated: 582 meter readings, 1,093 production
rows, 287 cash days, 1,235 outside sales, 21 purchases. Monthly tube and big-pool
kWh tie to the workbooks for every month January to June. 452 tests pass and the
typecheck is clean.

**Verified against the runtime the container actually runs.** `node
.next/standalone/server.js`, with the image's file layout: login, all five
screens, styles applied, Excel export downloads, no console errors. Worth
stating because every earlier browser test used `next start`, which Next warns
does not work with `output: standalone` — so until now the production runtime
had never been exercised. Doing it found four blockers, all fixed: a missing
`public/` that would have failed the image build outright, a missing
`.dockerignore` that baked the real `.env` into a published image layer, a
`today` derived in UTC on a plant that runs at UTC+8, and a reports index that
replaced an explicit `?month=` with the current month.

**Not verified.** The Docker image build itself. There is no Docker daemon in
the environment this was built in, so `docker compose build` has never run. The
Dockerfile is read carefully and its inputs all exist, but stage 2 below is the
first time it executes. Budget for one round of fixing there.

**Not verified.** The TNB bill parser against a live API key. The code path is
tested with a stubbed client; no real key has ever been in this environment. The
upload path works without a key — the review form simply opens empty for manual
keying, which is the intended fallback, not a degraded mode.

---

## 1. What only you can supply

Nothing sensitive has passed through the build. Every credential in the repo is
a `REPLACE_ME`. These are the values you fill in on the host.

### Blocks the first start

| | What | Notes |
|---|---|---|
| ☐ | **Droplet** with Docker and the compose plugin | 2 vCPU / 4 GB is comfortable. 2 GB works if you add swap — the Next build is the heavy step. ~5 GB disk. |
| ☐ | **Domain**, with an A record already pointing at the droplet | Caddy gets the certificate automatically, but the ACME challenge fails if DNS is not live *first*. |
| ☐ | **Ports 80 and 443 free** | `preflight.sh` checks this. An existing nginx is the usual culprit. |
| ☐ | **`AUTH_SECRET`** | `openssl rand -base64 32`. The app refuses to start under 16 characters. |
| ☐ | **`POSTGRES_PASSWORD`** | Anything long and random. Not the development one. |
| ☐ | **`ACME_EMAIL`** | Let's Encrypt expiry notices go here. |

### Blocks accounts

| | What | Notes |
|---|---|---|
| ☐ | **Names, emails and roles** for the three or four people | STAFF keys the day; MANAGER also confirms bills and sees cost of ice. Outstanding item 9. |

### Can follow later, without blocking anything

| | What | Notes |
|---|---|---|
| ☐ | **`ANTHROPIC_API_KEY`** | Only accelerates bill entry. Without it, upload and manual keying work normally. |
| ☐ | **DO Spaces credentials** | For off-droplet backup copies. Stage 5 works locally without them; do not stay there. |
| ☐ | **Coldroom sub-meter readings** | The site bridge reads 46.7% unaccounted without them. The system runs; that one figure stays unexplained. Outstanding item 1. |
| ☐ | **Product mapping** for Wai Mah, The Wet World, Hypecircus, Snow Theme Park | Their sales import under a generic product until mapped. |

### One question to answer before cutover

**Is Good Taste invoiced per block ordered, or per piece delivered?** The system
bills per block at RM26.40. The sheet bills `(pieces + crush bags) x RM3.30`,
where the piece tally is counted and runs 7.7 to 8.2 per block rather than a
fixed 8. That is the entire residual difference in the parallel check — every
remaining gap is an exact multiple of the crush rate.

If the answer is *per block*, the system is right and the sheet was
under-billing on short-yield days. If it is *per piece*, the entry screen needs a
piece count instead of a block count. That is a change to how revenue is
recognised, not a rounding matter, and it is cheaper to answer now than after
cutover. See `docs/00-inputs-required.md` §9.1.

---

## 2. First start

On the droplet, as a user in the `docker` group:

```bash
git clone <this repo> kfi-ice-ops && cd kfi-ice-ops
cp .env.example .env
```

Edit `.env` and fill every `REPLACE_ME`. Then:

```bash
bash scripts/preflight.sh
```

Read-only. It checks the daemon, that no `REPLACE_ME` survives, that
`AUTH_SECRET` is real and long enough, that the domain resolves *to this host*,
that 80 and 443 are free, and that there is disk and memory to build. It exits
non-zero with a sentence you can act on, rather than letting the stack fail four
layers down on an empty variable.

When it passes:

```bash
docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d --build
```

> **Always pass `--env-file .env`.** Compose looks for `.env` next to the
> compose file — that is `deploy/`, not the repo root where `.env.example`
> lives. Without the flag every `${VAR}` interpolates to empty and the stack
> starts with no database password. This is the single easiest thing to get
> wrong here, which is why every command in this document carries the flag.

Then the schema:

```bash
bash scripts/ops.sh npx prisma migrate deploy
bash scripts/ops.sh npm run db:seed
```

> **Administration runs in the `ops` image, not in `app`.** The runtime image
> deliberately carries no Prisma CLI, no `tsx` and no TypeScript sources — a web
> server that can rewrite its own schema is a bigger target than it needs to be.
> `scripts/ops.sh` runs the command in a throwaway container built from the same
> commit, against the same database. `docker compose exec app npx prisma ...`
> will not work, and that is on purpose.

The seed is convergent: it deletes any price epoch it no longer declares, so
re-running it corrects rather than accumulates. Re-run it freely.

**Check:** `https://your-domain` serves the login page over HTTPS with a valid
certificate. If the certificate is missing, `docker compose ... logs caddy` will
say whether the ACME challenge failed, which almost always means DNS.

---

## 3. Accounts

Set `SEED_DEV_USERS=false` in `.env` **before** running the seed, and the two
development logins are never created. If you have already seeded without it, set
it and re-seed, then deactivate them:

```bash
bash scripts/ops.sh npx tsx scripts/create-user.ts --email staff@kfi.local --deactivate
bash scripts/ops.sh npx tsx scripts/create-user.ts --email manager@kfi.local --deactivate
```

Create the real people:

```bash
bash scripts/ops.sh npx tsx scripts/create-user.ts \
  --email chong@kfi.com --name "Chong" --role MANAGER
bash scripts/ops.sh npx tsx scripts/create-user.ts \
  --email siti@kfi.com --name "Siti" --role STAFF
```

Each creation prints a generated password **once**. Hand it over directly; it is
stored only as a bcrypt hash and cannot be shown again. `--reset` issues a new
one; `--deactivate` kills existing sessions immediately.

There is no self-registration and no email password reset — with four users,
neither is worth the attack surface.

**Check:** a real account logs in; a deactivated one is refused. Both were
exercised end to end against the standalone runtime during the build.

---

## 4. The data

Two routes. **Prefer the first.**

### 4a. Move the verified database (recommended)

The local database has already been imported from the workbooks *and* checked
against them month by month. Moving it wholesale means production starts from
numbers that have been verified, rather than from a second import that has not.

```bash
# On the machine holding the verified database
pg_dump -Fc "$DATABASE_URL" > kfi-verified.dump

# On the droplet
docker compose --env-file .env -f deploy/docker-compose.prod.yml \
  exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --clean --if-exists < kfi-verified.dump
```

Then recompute, because costs are derived and should be rebuilt where they will
be read:

```bash
bash scripts/ops.sh npx tsx scripts/recompute.ts
bash scripts/ops.sh npx tsx scripts/recompute.ts --summary
```

### 4b. Re-import from the workbooks

Only if 4a is not possible. Copy the workbooks onto the droplet, mount them, and
run the import, then recompute. Expect to re-verify every month afterwards —
that is the work 4a avoids.

**Check:** `--summary` prints the monthly table. Compare it against what the
same command prints locally. Cost of ice should read RM0.0542 to RM0.0616 per kg
across January to September 2026, December 2025 should show `no rate` (bills
start in January), and June through August should read FINAL with everything
else PROVISIONAL.

---

## 5. Backups, and one rehearsed restore

Do this **before** cutover, not after.

```bash
# Nightly, via cron on the droplet
docker compose --env-file .env -f deploy/docker-compose.prod.yml \
  exec -T postgres pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > "kfi-$(date +%F).dump"
tar czf "uploads-$(date +%F).tar.gz" -C /var/lib/docker/volumes/kfi_uploads/_data .
```

Both matter. The dump carries the numbers; the tarball carries the original bill
PDFs and delivery orders, which are the evidence behind them and are kept
forever. Copy both off the droplet — Spaces, or anywhere that is not this
machine. A backup that lives only on the thing it is backing up is not a backup.

**Then restore one, into a throwaway database, and open it.** Confirm the bill
PDFs are present and a month's figures match. This is the only step in this
document that people skip and the only one where skipping it is discovered at
the worst possible moment.

---

## 6. The parallel run

Both systems run side by side. The `/parallel` screen takes the month's
`Daily rekod Ais` and reports, field by field, where the two disagree.

Where it stands now:

| Month | Agree | Differ |
|---|---:|---:|
| Jan 2026 | 233 | 15 |
| Mar 2026 | 230 | 18 |
| Jun 2026 | 221 | 19 |
| Jul 2026 | 221 | 27 |
| Aug 2026 | 223 | 25 |

Every remaining difference is an exact multiple of the crush rate — the Good
Taste piece drift in §1, and nothing else. Cash, total kilograms, tube
kilograms, big pool plus BIMC kilograms, tube kWh and big pool kWh all tie on
every day of every month checked.

Run it monthly. Each difference is one of three things, and it is worth naming
which before moving on:

1. **The system is wrong** — fix it.
2. **The sheet is wrong** — the migration already found five of these: a missing
   formula understating May by 9,000 kg, sheets labelled Oct/Nov that are 2025,
   a price rise in June that the sheet applied from January, the small pool
   stopping on 5 January, BIMC output never actually recorded. Record it and
   move on.
3. **They measure different things** — the Good Taste case. Decide which
   definition the business wants, then make the system match that.

Cutover when a month comes through with every difference explained. Not
necessarily zero — explained.

---

## 7. Cutover

1. A full month has been explained on `/parallel`.
2. The Good Taste question in §1 is answered, and the system matches the answer.
3. A restore has been rehearsed.
4. The people who key the data have used the entry screen for a full month
   alongside the sheet, not instead of it.
5. **Then** archive the workbooks read-only. Keep them — they are the record of
   how the business ran, and the parallel check needs them if a question comes
   up later.

---

## 8. The monthly rhythm afterwards

- **Daily** — staff key the day on `/entry`. Meter readings, production, cash,
  outside sales.
- **When a TNB bill arrives** — upload the PDF on `/bills`, check the parsed
  figures against the paper, confirm. Confirming reconstructs the bill component
  by component; if it does not tie to the cent, the parse is wrong, not the
  tariff.
- **After confirming a bill** — `bash scripts/ops.sh npx tsx scripts/recompute.ts`.
  That month's costs move from PROVISIONAL to FINAL.
- **Monthly** — run `/parallel` for as long as the workbooks are still kept.
- **When AFA changes** — add the new rate. It is the only moving component;
  September 2026 is +3.67 sen/kWh. Until a bill confirms it, that month's costs
  are marked PROVISIONAL with the basis shown as a forecast, which is the point:
  a modelled number never looks like a measured one.

---

## 9. Known risks, stated plainly

**The image build has never run.** No Docker daemon existed in the build
environment. Stage 2 is its first execution. Everything it consumes has been
checked to exist, and the runtime it produces has been exercised directly, but
expect one round of fixing.

**The bill parser has never seen a real key.** Tested against a stub. First real
bill, check every parsed field against the paper before confirming — which is
what the review screen is for, and what you should do on the tenth bill too.

**Cost of ice is understated while the coldroom sub-meter is missing.** The site
bridge shows 46.7% of site consumption unaccounted. Everything the system
reports is correct for what it can measure; that share is simply not yet
attributed. It is outstanding item 1.

**December 2025 has no rate.** Bills start in January. Those days are costed
`NO_RATE` rather than guessed — deliberately. The old workbooks would have
carried the frozen RM0.484 tariff into them and produced a confident wrong
number.

**The frozen tariff is the whole point.** The legacy workbooks computed cost of
ice at RM0.484/kWh, a pre-July-2025 rate, understating the real cost by 7.6 to
10.1%. If a figure here looks higher than the sheet, that is the system
working.
