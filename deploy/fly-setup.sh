#!/usr/bin/env bash
# One command for hypertrade's Fly side, from the repo root:   bash deploy/fly-setup.sh
#
# Creates, in Frankfurt: the Postgres app hypertradedb (postgres:17, 3 GB volume, deploy/fly.db.toml) and the app
# hypertrade (fly.toml), sets the secrets that link them, and deploys both. Safe to re-run: what exists is kept and
# redeployed. The app deploys inert (fly.toml), so nothing is copied from Supabase and nothing runs twice.
# Needs flyctl, signed in (fly auth login). FLY_ORG picks the organization (default: personal).
set -euo pipefail
cd "$(dirname "$0")/.."

ORG="${FLY_ORG:-personal}"
REGION=fra
DB=hypertradedb
APP=hypertrade

command -v fly >/dev/null || { echo "flyctl is not installed: https://fly.io/docs/flyctl/install/" >&2; exit 1; }
fly auth whoami >/dev/null || { echo "Not signed in: run fly auth login" >&2; exit 1; }

has_app() { fly apps list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$1"; }
has_secret() { fly secrets list -a "$1" 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$2"; }

# 1. Postgres. The password is made once, here, and only ever stored as Fly secrets.
pw=""
if ! has_app "$DB"; then
  fly apps create "$DB" --org "$ORG"
  pw="$(openssl rand -hex 24)"
  fly secrets set POSTGRES_PASSWORD="$pw" -a "$DB" --stage
fi
if ! fly volumes list -a "$DB" 2>/dev/null | grep -qw pgdata; then
  fly volumes create pgdata -a "$DB" --region "$REGION" --size 3 --snapshot-retention 14 --yes
fi
fly deploy -c deploy/fly.db.toml --ha=false --yes

# 2. The app, linked to Postgres over Fly's private network.
has_app "$APP" || fly apps create "$APP" --org "$ORG"
if ! has_secret "$APP" DATABASE_URL; then
  if [ -z "$pw" ]; then
    echo "$DB already exists but $APP has no DATABASE_URL, and the password can't be read back." >&2
    echo "Delete it (fly apps destroy $DB) and run this again." >&2
    exit 1
  fi
  fly secrets set -a "$APP" --stage \
    DATABASE_URL="postgres://postgres:${pw}@${DB}.internal:5432/postgres?sslmode=disable" \
    APP_URL="https://${APP}.fly.dev"
fi
fly deploy --ha=false --yes

echo
echo "Up: https://${APP}.fly.dev/api/health   (logs: fly logs -a $APP)"
