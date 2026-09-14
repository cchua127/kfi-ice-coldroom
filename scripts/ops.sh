#!/usr/bin/env bash
#
# Run a one-off administrative command against the production stack.
#
#   bash scripts/ops.sh npx prisma migrate deploy
#   bash scripts/ops.sh npm run db:seed
#   bash scripts/ops.sh npx tsx scripts/create-user.ts --email chong@kfi.com --name Chong --role MANAGER
#   bash scripts/ops.sh npx tsx scripts/recompute.ts --summary
#
# The runtime image carries no Prisma CLI, no tsx and no sources — deliberately.
# This runs in the `ops` image instead, which is built from the same commit and
# talks to the same database, then is thrown away.

set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="${ENV_FILE:-.env}"
[ -f "$ENV_FILE" ] || { echo "No $ENV_FILE. Copy .env.example and fill it in first." >&2; exit 1; }
[ $# -gt 0 ] || { echo "usage: bash scripts/ops.sh <command...>" >&2; exit 2; }

exec docker compose --env-file "$ENV_FILE" -f deploy/docker-compose.prod.yml \
  --profile ops run --rm ops "$@"
