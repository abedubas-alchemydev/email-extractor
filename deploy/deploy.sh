#!/usr/bin/env bash
# Idempotent deploy for extractor.alchemydev.io on the shared VPS (76.13.22.110).
#
# Safe to re-run. Scope is ONLY the `extractor` compose project — it never
# touches the co-tenants (app.logisx.com, the old email-extractor.abedubas.dev
# stack, *.abedubas.dev, etc.), nginx, certbot, UFW, or sshd. First-time nginx +
# TLS setup is a separate one-time step — see deploy/RUNBOOK.md.
#
# Run on the box:  cd /opt/extractor && bash deploy/deploy.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/extractor}"
REPO="${REPO:-https://github.com/abedubas-alchemydev/email-extractor.git}"
BRANCH="${BRANCH:-feat/standalone-fullparity-carveout}"
COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env"

if [ ! -d "$APP_DIR/.git" ]; then
  echo "==> cloning $REPO -> $APP_DIR"
  git clone "$REPO" "$APP_DIR"
fi

cd "$APP_DIR"
echo "==> fetching $BRANCH"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

if [ ! -f "$APP_DIR/.env" ]; then
  echo "ERROR: $APP_DIR/.env is missing." >&2
  echo "       cp deploy/.env.prod.example .env  &&  edit it (fill secrets), then re-run." >&2
  exit 1
fi

echo "==> building + starting the 'extractor' stack (loopback ports 3011/8002/5434)"
$COMPOSE up -d --build

echo "==> applying database migrations"
$COMPOSE run --rm backend alembic upgrade head

echo "==> health checks"
sleep 6
curl -fsS http://127.0.0.1:8002/health && echo "  backend OK"
curl -fsS -o /dev/null -w "  frontend /login -> HTTP %{http_code}\n" http://127.0.0.1:3011/login

echo "==> stack is up. First deploy? Enable nginx + TLS once, per deploy/RUNBOOK.md."
