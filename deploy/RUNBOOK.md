# Deploy runbook — extractor.alchemydev.io

Standalone full-parity email-extractor on the **shared** VPS `76.13.22.110` (root SSH).
The box runs other production apps (`app.logisx.com`, the old `email-extractor.abedubas.dev`
stack, `*.abedubas.dev`, …). **Everything here is additive and co-tenant-safe** — fresh
loopback ports, its own compose project + volume, one new nginx server block. Do **not**
touch other sites, UFW, sshd, or reboot the box.

## Slot on the box
- Compose project: `extractor` — containers `extractor-{postgres,backend,frontend}`.
- Ports (loopback only): frontend `127.0.0.1:3011`, backend `127.0.0.1:8002`, postgres `127.0.0.1:5434`.
- Code: `/opt/extractor` (clone of this repo, branch `feat/standalone-fullparity-carveout`).
- DNS: `extractor.alchemydev.io` → `76.13.22.110` (already resolves ✓).

## Prerequisites (already true on this box)
Docker 29 + Compose v5, nginx 1.28, certbot 4. Verified present.

## First-time deploy

```bash
ssh root@76.13.22.110

# 1. Get the code (the box must have read access to the GitHub repo; otherwise
#    push from local + use a deploy token, or rsync the working tree to /opt/extractor).
git clone https://github.com/abedubas-alchemydev/email-extractor.git /opt/extractor
cd /opt/extractor
git checkout feat/standalone-fullparity-carveout

# 2. Secrets
cp deploy/.env.prod.example .env
#   edit .env: set POSTGRES_PASSWORD + BETTER_AUTH_SECRET (openssl rand -hex 32),
#   APOLLO_WEBHOOK_SECRET if using phone-reveal, and any funded provider keys.
nano .env

# 3. Build, start, migrate, health-check (idempotent — safe to re-run)
bash deploy/deploy.sh

# 4. nginx server block (ADD-ONLY — one time)
cp deploy/nginx/extractor.alchemydev.io.conf /etc/nginx/sites-available/extractor.alchemydev.io
ln -sf /etc/nginx/sites-available/extractor.alchemydev.io /etc/nginx/sites-enabled/
nginx -t                 # MUST pass before reloading — protects the co-tenants
systemctl reload nginx   # reload, NOT restart (zero-drop for other sites)

# 5. TLS (Let's Encrypt, same as the other sites)
certbot --nginx -d extractor.alchemydev.io --non-interactive --agree-tos -m arvin.edubas15@gmail.com
nginx -t && systemctl reload nginx
```

## Verify (Phase 5)
- `curl -fsS https://extractor.alchemydev.io/login` → 200, valid cert.
- Browser: sign up → land on the gated tool; reload stays authed; logout re-gates.
- Submit a scan → discovery rows appear. Enrich (no keys → graceful 503; with keys → enriched columns fill).
- Apollo webhook (if configured): `POST https://extractor.alchemydev.io/api/v1/webhooks/apollo/<secret>/phone-reveal` reachable; bad secret → 404.

## Redeploy (after new commits)
```bash
ssh root@76.13.22.110 'cd /opt/extractor && bash deploy/deploy.sh'
```

## Rollback
```bash
cd /opt/extractor
git log --oneline -10            # find last good commit
git checkout <good-commit>
docker compose -f docker-compose.prod.yml --env-file .env up -d --build
```
Data lives in the `extractor-pg-data` volume; a code rollback doesn't touch it.
Migrations are additive — older code reads the newer schema fine.

## Teardown (does NOT affect other tenants)
```bash
cd /opt/extractor && docker compose -f docker-compose.prod.yml --env-file .env down
rm /etc/nginx/sites-enabled/extractor.alchemydev.io && nginx -t && systemctl reload nginx
# keep or drop the data volume: docker volume rm extractor-pg-data
```

## Backups (recommended)
Nightly `pg_dump` of the `extractor-postgres` container to off-box storage:
```bash
docker exec extractor-postgres pg_dump -U postgres email_extractor | gzip > /var/backups/extractor_$(date +%F).sql.gz
```
