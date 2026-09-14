#!/usr/bin/env bash
#
# Run on the droplet, from the repo root, before the first `docker compose up`.
# Everything here is a read-only check; it changes nothing.
#
#   bash scripts/preflight.sh
#
# The point is that the first production start fails on a sentence you can act
# on, rather than on an empty variable four layers down.

set -uo pipefail

ENV_FILE="${ENV_FILE:-.env}"
fail=0
warn=0

say()  { printf '  %s\n' "$*"; }
ok()   { printf '  \033[32m ok \033[0m %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; fail=$((fail + 1)); }
soft() { printf '  \033[33mwarn\033[0m %s\n' "$*"; warn=$((warn + 1)); }
section() { printf '\n\033[1m%s\033[0m\n' "$*"; }

section "Tooling"
if command -v docker >/dev/null 2>&1; then ok "docker $(docker --version | awk '{print $3}' | tr -d ,)"
else bad "docker is not installed"; fi
if docker compose version >/dev/null 2>&1; then ok "docker compose $(docker compose version --short)"
else bad "the docker compose plugin is missing (v1 'docker-compose' is not enough)"; fi
if docker info >/dev/null 2>&1; then ok "the docker daemon is reachable"
else bad "cannot reach the docker daemon — is it running, and are you in the docker group?"; fi

section "Configuration ($ENV_FILE)"
if [ ! -f "$ENV_FILE" ]; then
  bad "$ENV_FILE does not exist. Start from the template:  cp .env.example $ENV_FILE"
else
  ok "$ENV_FILE exists"

  # Compose reads its .env from the directory holding the compose file, which
  # is deploy/ — not the repo root. Every documented command therefore passes
  # --env-file explicitly. Warn if a stray deploy/.env could win instead.
  if [ -f deploy/.env ] && [ "$ENV_FILE" != "deploy/.env" ]; then
    soft "deploy/.env also exists. Two config files is one too many — delete the one you are not using."
  fi

  # Read values without sourcing. Sourcing a .env executes it — a stray
  # backtick or $(...) in a password would run as a command — and it breaks on
  # an absolute ENV_FILE. This just reads the assignment.
  getval() {
    sed -n "s/^[[:space:]]*$1=//p" "$ENV_FILE" | tail -1 \
      | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\\(.*\\)'$/\\1/"
  }
  POSTGRES_USER=$(getval POSTGRES_USER)
  POSTGRES_PASSWORD=$(getval POSTGRES_PASSWORD)
  POSTGRES_DB=$(getval POSTGRES_DB)
  DATABASE_URL=$(getval DATABASE_URL)
  AUTH_SECRET=$(getval AUTH_SECRET)
  SITE_DOMAIN=$(getval SITE_DOMAIN)
  ACME_EMAIL=$(getval ACME_EMAIL)
  ANTHROPIC_API_KEY=$(getval ANTHROPIC_API_KEY)
  SEED_DEV_USERS=$(getval SEED_DEV_USERS)

  left=$(grep -c 'REPLACE_ME' "$ENV_FILE" || true)
  if [ "$left" -gt 0 ]; then
    bad "$left value(s) still say REPLACE_ME:"
    grep -n 'REPLACE_ME' "$ENV_FILE" | sed 's/^/        /'
  else
    ok "no REPLACE_ME left"
  fi

  for v in POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB DATABASE_URL AUTH_SECRET SITE_DOMAIN ACME_EMAIL; do
    if [ -z "${!v:-}" ]; then bad "$v is empty"; fi
  done

  if [ -n "${AUTH_SECRET:-}" ]; then
    if [ "${#AUTH_SECRET}" -lt 16 ]; then
      bad "AUTH_SECRET is ${#AUTH_SECRET} characters; the app refuses to start under 16"
    elif printf '%s' "$AUTH_SECRET" | grep -qi 'dev_only\|change.me\|replace'; then
      bad "AUTH_SECRET is still a placeholder. Generate one:  openssl rand -base64 32"
    else
      ok "AUTH_SECRET looks like a real key (${#AUTH_SECRET} chars)"
    fi
  fi

  if [ "${POSTGRES_PASSWORD:-}" = "kfi_dev_password" ]; then
    bad "POSTGRES_PASSWORD is still the development password"
  fi

  # A DATABASE_URL pointing at localhost is the development one; inside the
  # compose network the host is the postgres service.
  case "${DATABASE_URL:-}" in
    *@localhost:*|*@127.0.0.1:*)
      soft "DATABASE_URL points at localhost. The app container reaches the database at host 'postgres'; compose builds that URL itself, so this only matters for scripts you run on the host." ;;
  esac

  if [ "${SEED_DEV_USERS:-true}" != "false" ]; then
    soft "SEED_DEV_USERS is not false. The seed will create staff@kfi.local and manager@kfi.local with a known password."
  else
    ok "SEED_DEV_USERS=false — no development logins will be created"
  fi

  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    soft "ANTHROPIC_API_KEY is empty. Bill upload still works; the review form opens blank for manual keying."
  else
    ok "ANTHROPIC_API_KEY is set"
  fi
fi

section "DNS and ports"
if [ -n "${SITE_DOMAIN:-}" ] && [ "${SITE_DOMAIN}" != "REPLACE_ME.example.com" ]; then
  # Compare like with like: the A record against this host's IPv4. Mixing an
  # AAAA lookup with an IPv4 public address reports a mismatch that is not one.
  resolved=$(getent ahostsv4 "$SITE_DOMAIN" 2>/dev/null | awk '{print $1}' | head -1)
  public=$(curl -s4 --max-time 5 https://api.ipify.org 2>/dev/null)
  if [ -z "$resolved" ]; then
    bad "$SITE_DOMAIN has no A record. Caddy's ACME challenge will fail and you will get no certificate."
  elif [ -z "$public" ]; then
    soft "$SITE_DOMAIN resolves to $resolved, but this host's public IP could not be determined — check it by eye."
  elif [ "$resolved" != "$public" ]; then
    bad "$SITE_DOMAIN resolves to $resolved but this host is $public. Point the A record here first."
  else
    ok "$SITE_DOMAIN resolves to $resolved, which is this host"
  fi
fi

for port in 80 443; do
  if command -v ss >/dev/null 2>&1; then listening=$(ss -ltn "sport = :$port" 2>/dev/null | tail -n +2)
  else listening=$(lsof -iTCP:"$port" -sTCP:LISTEN -P -n 2>/dev/null); fi
  if [ -n "$listening" ]; then bad "port $port is already in use — Caddy cannot bind it"
  else ok "port $port is free"; fi
done

section "Host capacity"
avail_kb=$(df -Pk . | awk 'NR==2 {print $4}')
if [ "$avail_kb" -lt 5242880 ]; then
  soft "$(( avail_kb / 1024 ))MB free here. The image build plus the database wants ~5GB."
else
  ok "$(( avail_kb / 1024 / 1024 ))GB free"
fi
mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
if [ "$mem_mb" -gt 0 ] && [ "$mem_mb" -lt 1900 ]; then
  soft "${mem_mb}MB RAM. The Next build is the heavy step; add swap if it is killed."
else
  ok "${mem_mb}MB RAM"
fi

section "Result"
if [ "$fail" -gt 0 ]; then
  say "$fail blocking problem(s). Fix these before starting the stack."
  exit 1
fi
[ "$warn" -gt 0 ] && say "$warn warning(s) — read them, then carry on."
say "Ready. Next:"
say "  docker compose --env-file $ENV_FILE -f deploy/docker-compose.prod.yml up -d --build"
exit 0
