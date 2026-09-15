# Setup runbook

Every command, in order, from nothing to a running system.

`01-production.md` explains *why* each stage exists and what is still
unverified. This file is the typing. Work top to bottom; each part ends with a
check that tells you whether to continue.

Conventions: `laptop$` runs where you are now, `droplet$` runs over SSH. Replace
anything in `ANGLE BRACKETS`.

---

## Part A — On your laptop, before touching a server

### A1. Confirm the build is good

```bash
laptop$ cd kfi-ice-coldroom
laptop$ git checkout main
laptop$ git pull
laptop$ npm ci
laptop$ npm run typecheck
laptop$ npm test
```

**Check:** typecheck silent, 452 tests pass.

### A2. Take the verified database dump

This is the database that has already been reconciled against the workbooks
month by month. Production should start from it rather than from a second
import that has not been checked.

```bash
laptop$ pg_dump -Fc "postgresql://kfi:kfi_dev_password@localhost:5432/kfi_ice" > kfi-verified.dump
laptop$ ls -lh kfi-verified.dump
```

**Check:** the file exists and is a few hundred KB or more, not empty.

---

## Part B — The droplet

### B1. Create it

DigitalOcean → Create → Droplet.

| Setting | Value |
|---|---|
| Image | Ubuntu 24.04 LTS |
| Plan | Basic → Regular SSD |
| Size | 2 vCPU / 4 GB / 80 GB |
| Region | Singapore (SGP1) — closest to Kuala Lumpur |
| Authentication | **SSH key**, not password |
| Hostname | `kfi-ice-ops` |

2 GB works if you add swap in B4, but the Next build is the heavy step and 4 GB
removes the whole question.

Note the public IPv4 address.

### B2. Point the domain at it

At your DNS provider, add an **A record**:

| Type | Name | Value |
|---|---|---|
| A | `ice` (or whatever subdomain) | `<DROPLET_IP>` |

Do this **now**, before Part C. Caddy requests the TLS certificate on first
start and the ACME challenge fails if DNS is not already live.

```bash
laptop$ dig +short ice.<YOUR_DOMAIN>
```

**Check:** it prints the droplet's IP. If it prints nothing, wait for
propagation and try again before continuing.

### B3. First login, and a non-root user

```bash
laptop$ ssh root@<DROPLET_IP>

droplet$ adduser kfi                      # set a password when prompted
droplet$ usermod -aG sudo kfi
droplet$ rsync --archive --chown=kfi:kfi ~/.ssh /home/kfi
droplet$ exit

laptop$ ssh kfi@<DROPLET_IP>              # from now on, log in as this
```

**Check:** you are logged in as `kfi` and `sudo whoami` prints `root`.

### B4. Swap, only if you chose a 2 GB droplet

```bash
droplet$ sudo fallocate -l 2G /swapfile
droplet$ sudo chmod 600 /swapfile
droplet$ sudo mkswap /swapfile
droplet$ sudo swapon /swapfile
droplet$ echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### B5. Firewall

```bash
droplet$ sudo ufw allow OpenSSH
droplet$ sudo ufw allow 80/tcp
droplet$ sudo ufw allow 443/tcp
droplet$ sudo ufw --force enable
droplet$ sudo ufw status
```

**Check:** OpenSSH, 80 and 443 are allowed. Nothing else needs to be open —
Postgres is reachable only inside the compose network.

### B6. Docker

```bash
droplet$ sudo apt-get update
droplet$ sudo apt-get install -y ca-certificates curl git
droplet$ sudo install -m 0755 -d /etc/apt/keyrings
droplet$ sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
droplet$ sudo chmod a+r /etc/apt/keyrings/docker.asc
droplet$ echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
droplet$ sudo apt-get update
droplet$ sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
droplet$ sudo usermod -aG docker $USER
droplet$ exit
```

Log back in so the group membership takes effect, then:

```bash
laptop$ ssh kfi@<DROPLET_IP>
droplet$ docker run --rm hello-world
```

**Check:** "Hello from Docker!" without `sudo`. If you get a permission error,
you did not log out and back in.

---

## Part C — The application

### C1. Clone

```bash
droplet$ git clone https://github.com/cchua127/kfi-ice-coldroom.git kfi-ice-ops
droplet$ cd kfi-ice-ops
```

`main` is the repository's default branch, so the clone lands on it.

### C2. Configuration

```bash
droplet$ cp .env.example .env
droplet$ openssl rand -base64 32          # copy this for AUTH_SECRET
droplet$ openssl rand -base64 24          # and this for POSTGRES_PASSWORD
droplet$ nano .env
```

Set these. Leave `DATABASE_URL` alone — compose builds the container's own URL
from the parts, and this value is only used by tools you run on the host.

```ini
POSTGRES_USER=kfi
POSTGRES_PASSWORD=<THE 24-BYTE STRING>
POSTGRES_DB=kfi_ice

AUTH_SECRET=<THE 32-BYTE STRING>

SEED_DEV_USERS=false

SITE_DOMAIN=ice.<YOUR_DOMAIN>
ACME_EMAIL=<YOUR EMAIL>

ANTHROPIC_API_KEY=          # optional; see C6
```

```bash
droplet$ chmod 600 .env
```

`SEED_DEV_USERS=false` matters: it stops the seed creating
`staff@kfi.local` and `manager@kfi.local` with a password that is in the source
code.

### C3. Preflight

```bash
droplet$ bash scripts/preflight.sh
```

Read-only — it changes nothing. It checks the Docker daemon, that no
`REPLACE_ME` survives, that `AUTH_SECRET` is long enough and not a placeholder,
that the development password is gone, that the domain resolves **to this
host**, that 80 and 443 are free, and that there is disk and memory to build.

**Check:** it exits with "Ready." Fix anything it calls FAIL before continuing.
A warning about `DATABASE_URL` pointing at localhost is expected and harmless.

### C4. Start

```bash
droplet$ docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d --build
```

First build takes five to fifteen minutes.

> **Always pass `--env-file .env`.** Compose looks for `.env` beside the compose
> file — that is `deploy/`, not the repo root where you just created it. Without
> the flag every `${VAR}` interpolates empty and the stack starts with no
> database password. Every command below carries the flag for the same reason.

```bash
droplet$ docker compose --env-file .env -f deploy/docker-compose.prod.yml ps
```

**Check:** `kfi-postgres-1`, `kfi-app-1` and `kfi-caddy-1` are all `Up`, and
postgres is `healthy`. If the app is restarting:

```bash
droplet$ docker compose --env-file .env -f deploy/docker-compose.prod.yml logs app --tail 50
```

### C5. Schema and reference data

```bash
droplet$ bash scripts/ops.sh npx prisma migrate deploy
droplet$ bash scripts/ops.sh npm run db:seed
```

Four migrations apply. The seed writes lines, units, meters, customers,
products, prices, cost assumptions, AFA rates and the six verified TNB bills.

> **Administration runs in the `ops` image, never in `app`.** The runtime image
> carries no Prisma CLI, no `tsx` and no TypeScript sources on purpose — a web
> server that can rewrite its own schema is a bigger target than it needs to be.
> `scripts/ops.sh` runs the command in a throwaway container built from the same
> commit, against the same database. `docker compose exec app npx prisma ...`
> will not work.

The seed is convergent — it deletes any price epoch it no longer declares — so
re-running it corrects rather than accumulates.

**Check:** the seed prints a count table — 14 prices, 6 bills, 10 customers —
and `users` reads **0**, because `SEED_DEV_USERS=false` stopped it creating the
development logins. If `users` reads 2, the guard did not take: fix `.env` and
re-run, then delete them as in E1.

### C6. Open it

```
https://ice.<YOUR_DOMAIN>
```

**Check:** the login page loads over HTTPS with a valid certificate, no browser
warning. If the certificate is missing:

```bash
droplet$ docker compose --env-file .env -f deploy/docker-compose.prod.yml logs caddy --tail 30
```

Almost always DNS — the A record must resolve to this droplet before Caddy can
complete the challenge.

The `ANTHROPIC_API_KEY` is optional and can be added at any time: put it in
`.env`, then
`docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d app`.
Without it, bill upload still works and the review form opens empty for manual
keying. That is the designed fallback, not a broken state.

---

## Part D — The data

### D1. Copy the dump up

```bash
laptop$ scp kfi-verified.dump kfi@<DROPLET_IP>:~/kfi-ice-ops/
```

### D2. Restore it

```bash
droplet$ cd ~/kfi-ice-ops
droplet$ set -a; . ./.env; set +a
droplet$ docker compose --env-file .env -f deploy/docker-compose.prod.yml \
    exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    --clean --if-exists < kfi-verified.dump
```

Some `does not exist, skipping` notices on `--clean` are normal on a fresh
database.

The restore replaces the whole `app_user` table, which is why accounts come
after it in Part E — including removing the development logins that travel in
the dump.

### D3. Rebuild the derived costs

```bash
droplet$ bash scripts/ops.sh npx tsx scripts/recompute.ts
droplet$ bash scripts/ops.sh npx tsx scripts/recompute.ts --summary
```

**Check:** the monthly table should read

| Month | RM/kg | Status |
|---|---|---|
| 2025-12 | no rate | PROVISIONAL |
| 2026-01 | 0.0565 | PROVISIONAL |
| 2026-02 | 0.0549 | PROVISIONAL |
| 2026-03 | 0.0542 | PROVISIONAL |
| 2026-04 | 0.0566 | PROVISIONAL |
| 2026-05 | 0.0592 | PROVISIONAL |
| 2026-06 | 0.0604 | **FINAL** |
| 2026-07 | 0.0616 | **FINAL** |
| 2026-08 | 0.0613 | **FINAL** |
| 2026-09 | 0.0606 | PROVISIONAL |

December 2025 reads `no rate` because the bills start in January. Those days are
left uncosted rather than guessed — the old workbooks would have carried the
frozen RM0.484 tariff into them and produced a confident wrong number.

If these figures do not match, stop and find out why before going further.

---

## Part E — Accounts

Do this **after** the restore, not before — the restore replaces the whole
`app_user` table.

### E1. Remove every account that came with the dump

These commands need `$POSTGRES_USER` from your `.env`. If you have reconnected
since D2, run `set -a; . ./.env; set +a` again first.

The development database carries the seed's `staff@kfi.local` and
`manager@kfi.local`, whose password is a literal string in `prisma/seed.ts`. The
restore brings them into production. Look at what arrived:

```bash
droplet$ docker compose --env-file .env -f deploy/docker-compose.prod.yml \
    exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "select id, email, name, role, active from app_user order by id;"
```

Delete everything that is not a real person at KFI:

```bash
droplet$ docker compose --env-file .env -f deploy/docker-compose.prod.yml \
    exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "delete from app_user where email like '%@kfi.local';"
```

**Check:** re-run the `select`. It should return **no rows** before you continue.

### E2. Create the real people

One command per person. There is no self-registration.

```bash
droplet$ bash scripts/ops.sh npx tsx scripts/create-user.ts \
    --email <chong@example.com> --name "Chong" --role MANAGER

droplet$ bash scripts/ops.sh npx tsx scripts/create-user.ts \
    --email <siti@example.com> --name "Siti" --role STAFF
```

- **STAFF** keys the day: meter readings, production, cash, outside sales.
- **MANAGER** also confirms TNB bills and sees cost of ice.

Each command prints a generated password **once**. Copy it, hand it over
directly, and do not keep it — it is stored only as a bcrypt hash and cannot be
shown again.

Later, as needed:

```bash
droplet$ bash scripts/ops.sh npx tsx scripts/create-user.ts --email <a@b.com> --reset
droplet$ bash scripts/ops.sh npx tsx scripts/create-user.ts --email <a@b.com> --deactivate
```

`--deactivate` invalidates existing sessions immediately.

**Check:** log in as one of the real accounts. You should land on the dashboard.

---

## Part F — Backups

Do this **before** cutover.

### F1. The script

```bash
droplet$ mkdir -p ~/backups
droplet$ cat > ~/backup-kfi.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd "$HOME/kfi-ice-ops"
set -a; . ./.env; set +a
DAY=$(date +%F)
OUT="$HOME/backups"

docker compose --env-file .env -f deploy/docker-compose.prod.yml \
  exec -T postgres pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > "$OUT/kfi-$DAY.dump"

sudo tar czf "$OUT/uploads-$DAY.tar.gz" -C /var/lib/docker/volumes/kfi_uploads/_data .

find "$OUT" -name '*.dump' -mtime +30 -delete
find "$OUT" -name 'uploads-*.tar.gz' -mtime +30 -delete
EOF
droplet$ chmod +x ~/backup-kfi.sh
droplet$ ~/backup-kfi.sh && ls -lh ~/backups
```

Both files matter. The dump carries the numbers; the tarball carries the
original bill PDFs and delivery orders, which are the evidence behind them.

### F2. Nightly

```bash
droplet$ crontab -e
```

Add — 02:00 UTC is 10:00 in Kuala Lumpur, so pick something quieter:

```cron
0 18 * * * /home/kfi/backup-kfi.sh >> /home/kfi/backups/backup.log 2>&1
```

(18:00 UTC = 02:00 the next day in Kuala Lumpur.)

### F3. Get a copy off the droplet

A backup that lives only on the machine it is backing up is not a backup. Either
`rclone` to DO Spaces, or the simplest thing that works:

```bash
laptop$ scp kfi@<DROPLET_IP>:~/backups/kfi-$(date +%F).dump ./
```

### F4. Rehearse the restore — do not skip this

```bash
droplet$ docker compose --env-file .env -f deploy/docker-compose.prod.yml \
    exec -T postgres createdb -U "$POSTGRES_USER" kfi_restore_test
droplet$ docker compose --env-file .env -f deploy/docker-compose.prod.yml \
    exec -T postgres pg_restore -U "$POSTGRES_USER" -d kfi_restore_test < ~/backups/kfi-$(date +%F).dump
droplet$ docker compose --env-file .env -f deploy/docker-compose.prod.yml \
    exec -T postgres psql -U "$POSTGRES_USER" -d kfi_restore_test \
    -c "select count(*) from production_daily;"
droplet$ docker compose --env-file .env -f deploy/docker-compose.prod.yml \
    exec -T postgres dropdb -U "$POSTGRES_USER" kfi_restore_test
```

**Check:** the count matches production. This is the only step here that people
skip, and the only one where skipping it is discovered at the worst moment.

---

## Part G — Parallel run, then cutover

### G1. Every month, while the workbooks are still kept

Open `/parallel`, upload that month's `Daily rekod Ais`, and read the
differences. Each one is exactly one of three things:

1. **The system is wrong** — fix it.
2. **The sheet is wrong** — the migration already found five of these. Record it
   and move on.
3. **They measure different things** — decide which definition the business
   wants, then make the system match.

### G2. Answer the Good Taste question

Is Good Taste invoiced **per block ordered** (what the system does, RM26.40) or
**per piece delivered** (what the sheet computes: counted pieces plus crush bags
times RM3.30)? The counted tally runs 7.7 to 8.2 pieces per block rather than a
fixed 8, and that gap is the entire remaining difference in the parallel check.

Per piece means the entry screen needs a piece count instead of a block count.
That is a change to how revenue is recognised, so settle it before cutover, not
after.

### G3. The gate

Cut over when all five are true:

- [ ] A full month on `/parallel` with every difference **explained** — not
      necessarily zero, explained.
- [ ] The Good Taste question answered and the system matching the answer.
- [ ] A restore rehearsed (F4).
- [ ] Backups running nightly and landing off the droplet.
- [ ] The people keying the data have used `/entry` for a full month *alongside*
      the sheet, not instead of it.

Then archive the workbooks **read-only**. Keep them — they are the record of how
the business ran, and the parallel check needs them if a question comes up
later.

---

## Afterwards: the routine

| When | Do |
|---|---|
| Daily | Staff key the day on `/entry`. |
| A TNB bill arrives | Upload the PDF on `/bills`, check every parsed field against the paper, confirm. If the reconstruction does not tie to the cent, the parse is wrong — not the tariff. |
| After confirming a bill | `bash scripts/ops.sh npx tsx scripts/recompute.ts` — that month moves PROVISIONAL → FINAL. |
| AFA changes | Add the new rate. It is the only moving component; September 2026 is +3.67 sen/kWh. |
| Monthly | `/parallel`, for as long as the workbooks are kept. |
| Deploying a change | `git pull`, then `up -d --build`, then `bash scripts/ops.sh npx prisma migrate deploy`. |

---

## If something breaks

```bash
# What is running
droplet$ docker compose --env-file .env -f deploy/docker-compose.prod.yml ps

# Logs
droplet$ docker compose --env-file .env -f deploy/docker-compose.prod.yml logs app   --tail 100
droplet$ docker compose --env-file .env -f deploy/docker-compose.prod.yml logs caddy --tail 50

# Restart one service
droplet$ docker compose --env-file .env -f deploy/docker-compose.prod.yml restart app

# Stop everything (data survives — it is in named volumes)
droplet$ docker compose --env-file .env -f deploy/docker-compose.prod.yml down

# Rebuild from scratch, keeping data
droplet$ docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d --build --force-recreate
```

`down` alone never deletes data. Only `down -v` removes the volumes, and that
destroys the database — there is no undo.

| Symptom | Cause, nine times in ten |
|---|---|
| Every `${VAR}` empty, no password | `--env-file .env` was omitted |
| No certificate | DNS does not resolve to this droplet yet |
| `npx prisma` not found | Ran in `app` instead of `scripts/ops.sh` |
| Build killed partway | Out of memory — add swap (B4) |
| App restarting | `logs app` — usually `AUTH_SECRET` missing or under 16 characters |
