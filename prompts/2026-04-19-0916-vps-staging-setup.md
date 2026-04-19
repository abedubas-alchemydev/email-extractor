---
slug: vps-staging-setup
created: 2026-04-19 09:16
ecc_command: /plan
subagents: []
related_prompts:
  - prompts/2026-04-19-0840-initial-scaffold.md
  - prompts/2026-04-19-0845-docker-stack-setup.md
related_adrs:
  - docs/decisions/0001-initial-stack.md
---

# VPS staging setup — provision 76.13.22.110 and deploy the Email Extractor stack

## Goal

Take a fresh remote VPS at `76.13.22.110` and turn it into a working **staging** deployment of the Email Extractor: OS packages in place, Python 3.11 + Node 20 + Docker runtime available, repo cloned under a non-root deploy user, environment files populated from the repo's `.env.example` files, the Docker Compose stack running in the background, health endpoints reachable on the VPS's public IP, and SSH hardened to key-only with root login disabled. This is **staging only — internal testing**; it is not a production deployment. TLS/reverse-proxy is deferred unless a domain is attached later.

## Context

- Target host: `76.13.22.110` (VPS, exact OS unknown — CC CLI checks during Step 2).
- Access today: `root` via SSH key (key already on Arvin's local machine).
- GitHub: canonical remote is `abedubas-alchemydev/email-extractor` (private). The local machine has multiple `gh` accounts; this project always runs under `abedubas-alchemydev` (same convention as `fis-lead-gen`). Step 1 handles the push.
- Purpose: internal smoke-testing of the Email Extractor stack end-to-end on a real server, so we can validate the Docker Compose deployment pattern before the eventual Cloud Run migration post-merge with `fis-lead-gen`.
- Prerequisites:
  - `prompts/2026-04-19-0840-initial-scaffold.md` must be **completed and committed** locally. The VPS pulls the repo over SSH/HTTPS; the scaffold's files (`docker-compose.yml`, `backend/Dockerfile`, `frontend/Dockerfile`) are what the VPS actually runs.
  - `prompts/2026-04-19-0845-docker-stack-setup.md` should have been run locally at least once — if the stack doesn't come up on a dev machine, it will not come up on the VPS either. If it hasn't been run locally, that prompt is the cheaper place to find bugs.
- Architectural constraint from ADR 0001: standalone deployment target is self-hosted VPS via Docker Compose; Cloud Run comes later when merged. This prompt is the canonical "it runs on the VPS" pass.
- This prompt is **idempotent-friendly** — re-running it on an already-provisioned host should detect existing state and skip rather than clobber. Where a command can't be safely re-run, it is gated on a presence check.

## Constraints

- **Staging, not production.** Do not set up automated backups, log shipping, monitoring agents, APM, or a managed certificate authority. Those belong in a separate "production-readiness" prompt once the shape of the deploy is stable.
- **Key-only SSH, root login disabled at the end.** After the deploy user is created and their authorized key verified, disable root SSH login. Do not do this before the deploy user can log in successfully — verify the new login path works from Arvin's local machine before closing the root door.
- **No firewall misconfiguration.** If enabling UFW, explicitly `ufw allow 22/tcp` (or the current SSH port) **before** `ufw enable`. An admin-locked-out-by-firewall recovery is an hour of pain and needs console access. The order is non-negotiable.
- **No application-code changes.** Provisioning only. If the stack fails to come up on the VPS because of a bug in the Dockerfiles or compose file, stop, note it in Outcome, and defer the fix to a follow-up prompt. Do not hot-fix from the VPS.
- **Do not modify `CLAUDE.md` sections 1–9 or §10.** Any lessons learned belong in **§9 (Persistent context)** only, and only if genuinely durable (e.g., "this VPS provider's base image ships without `curl`" — useful forever). Routine logs do not belong in CLAUDE.md.
- **Zero AI attribution on commits.** Any commit made to document provisioning (e.g., a VPS runbook under `docs/`) follows the same rule as every other commit in this repo — voice: Arvin, no `Co-Authored-By`, no "Generated with…".
- **Stage files by name** for any commits; no `git add .` / `git add -A`.
- **Never skip git hooks** (`--no-verify`).
- **Secrets stay out of the repo.** The `.env` file on the VPS is populated interactively or by secure copy — it is never committed. `.gitignore` already excludes `.env` / `.env.*`.
- **`--volumes` teardown cleans DB data.** Only run `docker compose down --volumes` on the VPS if you actually want to wipe persistent Postgres state. Default teardown uses `docker compose down` (no flag).

## Commands to run

Run each block in order. CC CLI should use an SSH connection to `root@76.13.22.110` for Steps 1–5, switch to the deploy user from Step 6 onward, and return to the local machine for the final verification step.

### 0. Plan first (ECC)

Use `/plan` to confirm the execution order — especially the SSH-hardening sequence in Step 4 — before running anything on the remote host. Then proceed.

### 1. Push the scaffolded repo to GitHub (local machine)

The VPS pulls code over the internet, so the repo must exist on GitHub before Step 7 can clone it. The local machine has multiple `gh` accounts (`abedubas-alchemydev`, `akosiArvin081596`, `arvinbedubas-vendoraph` — same convention as `fis-lead-gen`). All Email Extractor git operations run under **`abedubas-alchemydev`**.

**1a. Commit any uncommitted edits to this prompt file itself.**

When this VPS prompt was written, the scaffold prompt was mid-execution in parallel — which means the VPS prompt file may still show as modified-untracked when CC CLI starts this run. Commit it first (stage by name, zero AI attribution, Arvin's voice) so the push in 1b captures the current prompt state:

```bash
cd <repo-root>
git status
if ! git diff --quiet -- prompts/2026-04-19-0916-vps-staging-setup.md \
   || git ls-files --others --exclude-standard -- prompts/2026-04-19-0916-vps-staging-setup.md | grep -q .; then
  git add prompts/2026-04-19-0916-vps-staging-setup.md
  git commit -m "docs(prompts): add github push prereq and deploy-key flow to vps staging prompt"
fi
git log -1 --pretty=full     # confirm no AI trailer
```

If `git status` shows any other modified/untracked files beyond this prompt, stop and surface them — do not bulk-commit. Scaffolding artifacts (build outputs, `.venv/`, `node_modules/`, `.env`) should all be gitignored already; anything else is a signal to pause.

**1b. Switch to the correct `gh` account and sanity-check.**

```bash
gh auth switch --user abedubas-alchemydev --hostname github.com
gh auth status

git status                   # expect clean working tree
git log --oneline            # expect the scaffold's 9 commits + the 1a prompt-file commit
```

**1c. Create the remote (if it doesn't exist) and push.** Idempotent — if the repo is already on GitHub from a prior run, it only pushes new commits.

```bash
if ! gh repo view abedubas-alchemydev/email-extractor >/dev/null 2>&1; then
  gh repo create abedubas-alchemydev/email-extractor \
    --private \
    --source=. \
    --remote=origin \
    --push
else
  git remote get-url origin >/dev/null 2>&1 || \
    git remote add origin https://github.com/abedubas-alchemydev/email-extractor.git
  git push -u origin HEAD
fi

# Confirm GitHub matches local
gh repo view abedubas-alchemydev/email-extractor --json defaultBranchRef,pushedAt,visibility
git log -1 --pretty=full
```

Before moving on, confirm:

- Repo is **private** (`visibility: PRIVATE` in the JSON above).
- The last commit has **zero AI attribution** — no `Co-Authored-By: Claude`, no "Generated with…" footer, no references to AI/Claude/Anthropic/assistant/LLM. If one slipped through from CC CLI's scaffold run, stop here, rewrite the offending commit locally, and force-push (safe only because the repo is fresh and no one has cloned it).
- `gh auth status` shows `abedubas-alchemydev` as the active account for `github.com`. If another account is active, the push will land in the wrong namespace.

### 2. Reach the host and detect the OS

From Arvin's local machine:

```bash
ssh -o StrictHostKeyChecking=accept-new root@76.13.22.110 'uname -a; cat /etc/os-release; cat /proc/meminfo | head -n 3; df -h /; nproc'
```

Record the outputs in **Outcome → Evidence**. Expect an Ubuntu or Debian release; if it's something else (Rocky, Alma, Fedora, Arch), stop and update the package-manager commands below before continuing — do not blindly run `apt-get` on a non-Debian system.

If SSH fails with "Permission denied (publickey)", verify the local key is loaded (`ssh-add -l`) and that Arvin's local SSH config points at the right private key for this host. Do not attempt password auth.

### 3. Base system update and essentials

On the VPS, as root (Ubuntu/Debian path shown; adjust per Step 2 findings):

```bash
apt-get update
apt-get upgrade -y
apt-get install -y \
  ca-certificates curl git gnupg lsb-release \
  ufw fail2ban unattended-upgrades \
  build-essential pkg-config \
  postgresql-client \
  vim less htop jq
timedatectl set-timezone UTC
```

Enable unattended security updates (safe on staging; major version upgrades are disabled by default).

Check free memory from Step 2 — if the VPS has < 2 GB RAM, add a 2 GB swapfile:

```bash
if ! swapon --show | grep -q '/swapfile'; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
```

### 4. Install Docker Engine + Compose V2

Use Docker's official `apt` repository (not the distro's `docker.io` package — it lags). On Ubuntu/Debian:

```bash
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${VERSION_CODENAME}") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
docker --version
docker compose version
```

If `/etc/os-release` identifies Debian rather than Ubuntu, swap the URL prefix to `https://download.docker.com/linux/debian` accordingly.

### 5. Create deploy user, authorize key, then harden SSH

Create a non-root user for running the app and for day-to-day SSH access. Grant `docker` group membership so the deploy user can run `docker compose` without `sudo`.

```bash
id -u deploy >/dev/null 2>&1 || adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy
usermod -aG sudo deploy
install -d -m 0700 -o deploy -g deploy /home/deploy/.ssh
```

**Authorize Arvin's key on the `deploy` user.** Do this by copying the existing `/root/.ssh/authorized_keys` — it's the same key Arvin is already using, so it's the path of least surprise. Then lock permissions:

```bash
cp /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 0600 /home/deploy/.ssh/authorized_keys
```

**Critical sequencing — verify the new path works _before_ closing the old one.** From Arvin's local machine, in a **new terminal**, run:

```bash
ssh deploy@76.13.22.110 'whoami && groups | tr " " "\n" | grep -E "^(docker|sudo)$"'
```

Expected output: `deploy` on the first line, and `docker` and `sudo` on subsequent lines. If this fails, fix the key/permissions/group membership before proceeding — do **not** move to the next block until `deploy@` login is confirmed working.

Only once the new login path is verified, harden `sshd_config`:

```bash
sed -i 's/^#\?\s*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?\s*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?\s*ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' /etc/ssh/sshd_config
sshd -t && systemctl reload ssh
```

`sshd -t` is the safety net — if the config has a typo, it prints the error and we never reload, so the existing session stays alive.

Finally, enable UFW with SSH allowed **first** so we don't lock ourselves out:

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 3000/tcp    # Next.js (staging; exposed for internal testing)
ufw allow 8000/tcp    # FastAPI (staging; exposed for internal testing)
ufw --force enable
ufw status verbose
```

If a domain is attached later and Caddy/nginx fronts everything, the 3000/8000 rules get replaced with 80/443 and this block is revisited.

### 6. Install Python 3.11 and Node 20 (host-level, optional)

Docker is the canonical runtime on this VPS, so Python and Node on the host are only for convenience (e.g., running one-off `scripts/run_*.py` locally, debugging). If you prefer container-only, skip this block.

```bash
# Python 3.11 via deadsnakes (Ubuntu) or official Debian bookworm packages
apt-get install -y software-properties-common
add-apt-repository -y ppa:deadsnakes/ppa || true   # no-op on Debian
apt-get update
apt-get install -y python3.11 python3.11-venv python3.11-dev

# Node 20 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
python3.11 --version
node --version
```

Record the versions in Evidence.

### 7. Switch to deploy user and clone the repo

The repo is **private** (`abedubas-alchemydev/email-extractor`, pushed in Step 1), so HTTPS clone without credentials will fail. Use a **read-only deploy key** scoped to this repo — do not ship a personal access token to the VPS.

CC CLI orchestrates the full flow from the local machine — no manual copy-paste between terminals. The SSH key that CC CLI uses to reach `deploy@76.13.22.110` is the same Ed25519 key Arvin already uses for `root@76.13.22.110` (authorized on the `deploy` user during Step 5).

**7a. Generate the deploy keypair on the VPS and capture the public half locally.**

```bash
# Generate only if it doesn't already exist (idempotent)
ssh deploy@76.13.22.110 'test -f ~/.ssh/id_ed25519 || ssh-keygen -t ed25519 -C "deploy@email-extractor-staging" -f ~/.ssh/id_ed25519 -N ""'

# Pull the public key back to the local machine as a string
DEPLOY_PUBKEY="$(ssh deploy@76.13.22.110 'cat ~/.ssh/id_ed25519.pub')"
printf '%s\n' "$DEPLOY_PUBKEY"
```

**7b. Register the public key as a read-only deploy key on the repo.**

Idempotent — if a key with this title already exists (e.g., from a previous run), skip.

```bash
if ! gh repo deploy-key list --repo abedubas-alchemydev/email-extractor --json title \
     | grep -q '"vps-staging-76.13.22.110"'; then
  printf '%s\n' "$DEPLOY_PUBKEY" | gh repo deploy-key add /dev/stdin \
    --repo abedubas-alchemydev/email-extractor \
    --title "vps-staging-76.13.22.110"
fi

gh repo deploy-key list --repo abedubas-alchemydev/email-extractor
```

Verify the response shows the key as `read_only: true`. A read-write deploy key is not acceptable here — staging pulls code, it never pushes.

**7c. Pre-seed `known_hosts` and clone.**

```bash
ssh deploy@76.13.22.110 'ssh-keyscan github.com >> ~/.ssh/known_hosts && chmod 0600 ~/.ssh/known_hosts'

ssh deploy@76.13.22.110 'mkdir -p ~/apps && cd ~/apps && \
  if [ -d email-extractor/.git ]; then \
    cd email-extractor && git pull --ff-only; \
  else \
    git clone git@github.com:abedubas-alchemydev/email-extractor.git; \
  fi && \
  cd email-extractor && git log -1 --oneline'
```

Confirm the printed `HEAD` SHA matches the one pushed in Step 1.

### 8. Populate `.env` files

Create the `.env` at repo root and `backend/.env` from their `.example` templates, then fill in real values. The API keys can be left blank for staging — the stack still boots, but the paid discovery providers will be no-ops (this is acceptable for staging smoke-testing).

```bash
cd ~/apps/email-extractor
cp .env.example .env
cp backend/.env.example backend/.env
```

Edit `.env` (root) — set at minimum:

```env
DATABASE_URL=postgresql+asyncpg://postgres:postgres@postgres:5432/email_extractor
BACKEND_CORS_ORIGINS=http://76.13.22.110:3000,http://localhost:3000
EMAIL_EXTRACTOR_API_KEY=<generate-random>   # run: openssl rand -hex 32
```

Edit `backend/.env` — override any backend-only values. For staging, leaving `HUNTER_API_KEY`, `APOLLO_API_KEY`, `SNOV_API_KEY` blank is acceptable; the providers will short-circuit on missing credentials. Document this in **Outcome → Deviations**.

`chmod 0600 .env backend/.env` so neighboring users (none, on a single-tenant VPS, but good hygiene) can't read them.

### 9. Bring up the stack

```bash
cd ~/apps/email-extractor
docker compose pull postgres          # pre-pull the public image (saves a layer during build)
docker compose up --build -d
sleep 15                              # let the backend finish warming
docker compose ps
docker compose logs --tail=80 backend
docker compose logs --tail=80 frontend
```

All services should be `Up` or `Healthy`.

### 10. Health check from the VPS and from Arvin's machine

On the VPS:

```bash
curl -fsS http://localhost:8000/health | grep -q '"status":"ok"'
curl -fsS http://localhost:8000/api/v1/health | grep -q '"status":"ok"'
curl -fsS -o /dev/null -w '%{http_code}\n' http://localhost:3000       # expect 200
```

From Arvin's local machine (exits the VPS first):

```bash
curl -fsS http://76.13.22.110:8000/health | grep -q '"status":"ok"'
curl -fsS http://76.13.22.110:8000/api/v1/health | grep -q '"status":"ok"'
curl -fsS -o /dev/null -w '%{http_code}\n' http://76.13.22.110:3000    # expect 200
```

Record both sets of outputs in **Outcome → Evidence**.

### 11. (Optional) Auto-start on reboot

For staging it's reasonable to have the stack come up on reboot so a host restart doesn't silently take the environment down. The simplest approach is Docker's built-in restart policy — confirm `docker-compose.yml` already has `restart: unless-stopped` on each service (the scaffold should set this; if not, note as a follow-up). No separate systemd unit needed.

If `restart:` is missing, do **not** edit the compose file from the VPS. File it as a follow-up prompt.

### 12. Document the runbook (local commit — optional)

From Arvin's local machine, if the provisioning revealed anything durable (e.g., specific provider-image quirks, a package the official playbook missed, a recovery procedure), capture it in a short runbook under `docs/runbooks/vps-staging.md`. Keep it operational: how to ssh in as `deploy`, where the compose file lives, how to tail logs, how to restart the stack, how to rotate the `.env`. One commit, one concern:

- `docs: add staging VPS runbook`

No body needed unless non-obvious. Voice: Arvin. Stage by name. Zero AI attribution.

If nothing durable was learned, skip the commit — an empty runbook is worse than none.

## Acceptance criteria

A fresh agent re-running this prompt against an already-provisioned host (idempotency check) or another admin verifying the outcome must be able to confirm each of:

- `gh repo view abedubas-alchemydev/email-extractor --json visibility,pushedAt` returns `visibility: PRIVATE` and a `pushedAt` timestamp matching the local `HEAD`.
- `gh repo deploy-key list --repo abedubas-alchemydev/email-extractor` shows exactly one key titled `vps-staging-76.13.22.110` with `read_only: true`.
- `ssh deploy@76.13.22.110 'docker compose -f ~/apps/email-extractor/docker-compose.yml ps'` lists all services as `Up` or `Healthy`.
- `curl -fsS http://76.13.22.110:8000/health` from outside the VPS returns `{"status":"ok"}` with HTTP 200.
- `curl -fsS http://76.13.22.110:8000/api/v1/health` returns `{"status":"ok"}` with HTTP 200.
- `curl -o /dev/null -w '%{http_code}\n' http://76.13.22.110:3000` returns `200`.
- `ssh root@76.13.22.110` **fails** with "Permission denied" (root SSH login disabled).
- `ssh deploy@76.13.22.110 'id -Gn'` shows the deploy user is in both `docker` and `sudo` groups.
- `ssh deploy@76.13.22.110 'sudo ufw status verbose'` shows ACTIVE status with rules allowing 22/tcp, 3000/tcp, 8000/tcp (and denying all other incoming).
- `ssh deploy@76.13.22.110 'cat /etc/ssh/sshd_config | grep -E "^(PermitRootLogin|PasswordAuthentication)"'` returns `PermitRootLogin no` and `PasswordAuthentication no`.
- `ssh deploy@76.13.22.110 'docker --version && docker compose version'` returns Docker Engine 24+ (or whatever stable is at execution time) and Compose v2+.
- If a runbook commit was made locally, `git log --oneline` shows one new commit by Arvin with no AI trailer, touching only `docs/runbooks/vps-staging.md`.
- `CLAUDE.md` is byte-identical to pre-run — nothing in this prompt edits it; if any learnings are durable, they are noted in **Outcome → Follow-ups** and Arvin decides separately whether to promote them to CLAUDE.md §9 via a later prompt.
- No secrets appear in any committed file. `git log -p | grep -iE '(HUNTER|APOLLO|SNOV)_API_KEY\s*='` returns nothing on either the local clone or the VPS's clone.

## Subagent roles

None. This prompt is provisioning-and-verification; it does not touch application code, so `code-review` / `testing-strategy` are not applicable.

## Out of scope

- **Production deployment.** TLS, a domain, a reverse proxy (Caddy/nginx/Traefik), managed certs, HSTS, security headers — all deferred to a future `vps-production-setup` prompt or to the Cloud Run migration post-merge.
- **Monitoring / alerting.** No Prometheus node-exporter, no Uptime Kuma, no Sentry. Staging runs without observability.
- **Backups.** No pg_dump schedule, no volume snapshots, no off-site copies. Staging DB is considered expendable.
- **CI/CD to the VPS.** Deployment is manual-by-design for staging: `git pull && docker compose up -d --build`. No GitHub Actions push-to-deploy workflow in this prompt.
- **Secret management beyond `.env`.** No Vault, no Doppler, no GCP Secret Manager. `.env` files, `chmod 0600`, single-tenant VPS — acceptable for internal staging.
- **Changes to the Dockerfiles or `docker-compose.yml`.** If the stack fails to come up on the VPS because of a compose/Dockerfile bug, record the failure in Outcome and spawn a follow-up prompt.

---

## Outcome

**Status:** partial
**Completed:** 2026-04-19T10:40:00+08:00
**Branch:** main
**Commits:**
- `f470eb8` docs(plans): add vps-staging-setup execution plan
- `0b4a59e` docs(prompts): add github push prereq and deploy-key flow to vps staging prompt
- (Outcome commit pending after this edit)

### Summary
Brought up the Email Extractor stack on the multi-tenant staging VPS at `76.13.22.110` per the refinements in `plans/vps-staging-approval-2026-04-19.md`. Backend runs cleanly behind Postgres, with `/health` and `/api/v1/health` reachable on-VPS and off-VPS at `http://76.13.22.110:8000`. Frontend container build failed on `COPY /app/public` because `create-next-app@14 --no-src-dir` did not generate a `public/` directory and our scaffold's `frontend/Dockerfile` assumes one — a bug in the committed scaffold, deferred to a follow-up per the prompt's "no Dockerfile hot-fixes from the VPS" constraint. All multi-tenancy refinements (port 3010 remap, sshd-hardening skipped, UFW add-only) executed cleanly; no co-tenant workload disrupted.

### Acceptance criteria

- [x] `gh repo view abedubas-alchemydev/email-extractor --json visibility,pushedAt` returns `visibility: PRIVATE` — verified: `{"defaultBranchRef":{"name":"main"},"pushedAt":"2026-04-19T02:22:13Z","visibility":"PRIVATE"}`.
- [x] `gh repo deploy-key list` shows exactly one key titled `vps-staging-76.13.22.110` with `read-only: true` — verified, key id `149010775`.
- [ ] DEFERRED — `docker compose ps` lists ALL services as `Up`/`Healthy`. Postgres + backend are Up/Healthy; frontend never built (Dockerfile bug). See Followups → "Fix frontend/Dockerfile public/ COPY".
- [x] `curl http://76.13.22.110:8000/health` from outside the VPS returns `{"status":"ok"}` — verified.
- [x] `curl http://76.13.22.110:8000/api/v1/health` returns `{"status":"ok"}` — verified.
- [ ] DEFERRED — `curl http://76.13.22.110:3010` (per approval refinement, replacing `:3000`) returns `200`. Blocked on the same frontend-build bug.
- [ ] **NOT EXECUTED** — `ssh root@76.13.22.110` fails with "Permission denied" (root SSH login disabled). Per approval decision 2, sshd hardening skipped; root SSH stays open for co-tenants. This acceptance criterion is intentionally inapplicable to this multi-tenant deploy.
- [x] `ssh deploy@76.13.22.110 'id -Gn'` shows the deploy user is in `docker` and `sudo` groups — verified: `deploy sudo users docker`.
- [x] `ufw status verbose` shows ACTIVE with rules allowing 22/tcp (already), 8000/tcp (added), 3010/tcp (added) — verified. 3000/tcp was NOT added per approval (port 3000 owned by co-tenant).
- [ ] **NOT APPLICABLE** — `PermitRootLogin no`/`PasswordAuthentication no` in sshd_config. See sshd skip above.
- [x] `docker --version && docker compose version` returns Docker 29.1.5 + Compose v5.0.2 — verified.
- [ ] No runbook commit made — per the prompt's "skip if nothing durable surfaced" guidance. All durable findings landed in `auto-memory/reference_vps_76_13_22_110.md` (project memory) instead.
- [x] `CLAUDE.md` byte-identical to pre-run — `git status` shows no CLAUDE.md modifications.
- [x] No secrets in any committed file — `EMAIL_EXTRACTOR_API_KEY` was generated on the VPS via `openssl rand -hex 32` and written only to `~/apps/email-extractor/.env` (gitignored, `chmod 0600`). `HUNTER/APOLLO/SNOV_API_KEY` left blank for staging per Step 8 instruction.

### Files touched

**Local repo:**
- `plans/vps-staging-setup-2026-04-19.md` (+190 / -0) — execution plan written before approval gate.
- `prompts/2026-04-19-0916-vps-staging-setup.md` (+126 / -38 in commit `0b4a59e`; further +~270/-32 in this Outcome edit) — Step 1a self-commit + Outcome.
- `plans/vps-staging-approval-2026-04-19.md` (authored by user) — refinements; not edited by CC CLI.

**Local memory (`~/.claude/projects/.../memory/`):**
- `reference_vps_76_13_22_110.md` (new) — VPS tenancy reference for future prompts.
- `MEMORY.md` (+1 line) — index pointer.

**VPS (`76.13.22.110`) — not in git:**
- `~/apps/email-extractor/.env` — root env, `chmod 0600`, contains generated `EMAIL_EXTRACTOR_API_KEY`.
- `~/apps/email-extractor/backend/.env` — backend env (template only, all keys blank).
- `~/apps/email-extractor/docker-compose.override.yml` — port-3010 remap; added to `.git/info/exclude` (local-only).

**VPS host state:**
- `/home/deploy` — new user, member of `docker` + `sudo`, Arvin's Ed25519 authorized.
- `~deploy/.ssh/id_ed25519` — new keypair generated for cloning.
- `~deploy/.local/bin/uv` — uv 0.11.7 installed.
- Python 3.11.15 — installed via `uv python install 3.11` (deadsnakes PPA does not support `questing` yet).
- UFW rules added: `8000/tcp`, `3010/tcp`. All other rules untouched.

### Verification

```
# Step 1 — gh push
$ gh auth switch --user abedubas-alchemydev --hostname github.com
✓ Switched active account for github.com to abedubas-alchemydev
$ gh repo create abedubas-alchemydev/email-extractor --private --source=. --remote=origin --push
https://github.com/abedubas-alchemydev/email-extractor
$ gh repo view abedubas-alchemydev/email-extractor --json defaultBranchRef,pushedAt,visibility
{"defaultBranchRef":{"name":"main"},"pushedAt":"2026-04-19T02:22:13Z","visibility":"PRIVATE"}
$ git log -1 --pretty=full
commit 0b4a59e7816d4a364a5855884ffc1a98e2fb1f30
Author: Arvin B. Edubas <arvin.edubas15@gmail.com>
    docs(prompts): add github push prereq and deploy-key flow to vps staging prompt
(no AI trailer)

# Step 2 — host detection
Linux srv1292086 6.17.0-20-generic #20-Ubuntu SMP PREEMPT_DYNAMIC Fri Mar 13 20:07:29 UTC 2026 x86_64 GNU/Linux
PRETTY_NAME="Ubuntu 25.10" (Questing Quokka)
MemTotal: 8129532 kB ; / 96G 48% used ; nproc=2
/var/run/reboot-required PRESENT (deferred per user direction)

# Pre-flight (added by CC CLI before refinements were approved)
- deploy user: NOT present (proceeded with creation)
- docker: 29.1.5 + compose v5.0.2 already installed (skipped Step 4 install)
- co-tenant containers: wb-prod-*, wb-staging-*, mongo:7 (6 containers running)
- co-tenant host services: nginx 80/443, mysqld 3306, php 8080/8081, node 3000-3003
- port 3000: ALREADY IN USE by /var/www/l... node app -> triggered approval refinement 1

# Step 3 — apt
$ apt-get update && apt-get install -y ca-certificates curl git gnupg lsb-release ufw fail2ban unattended-upgrades build-essential pkg-config postgresql-client vim less htop jq
(all installed; deferred service restarts noted)
$ timedatectl set-timezone UTC
Local time: Sun 2026-04-19 02:33:00 UTC
Skipped: apt-get upgrade -y (deferred to coordinated reboot window per multi-tenancy)

# Step 4 — docker (already installed, no-op)
Docker version 29.1.5, build 0e6fee6
Docker Compose version v5.0.2

# Step 5a-c — deploy user
$ id deploy -> uid=1002(deploy) ... groups=1002(deploy),27(sudo),100(users),989(docker)
$ ssh deploy@76.13.22.110 'whoami && groups | grep -E "docker|sudo"'
deploy
sudo
docker

# Step 5d — SKIPPED per approval (co-tenant safety)
sshd_config left as: PermitRootLogin yes ; ChallengeResponseAuthentication no

# Step 5e — UFW add-only
$ ufw allow 8000/tcp && ufw allow 3010/tcp -> both Rule added (v4 + v6)
$ ufw status verbose | grep -E "8000|3010"
8000/tcp                   ALLOW IN    Anywhere
3010/tcp                   ALLOW IN    Anywhere
8000/tcp (v6)              ALLOW IN    Anywhere (v6)
3010/tcp (v6)              ALLOW IN    Anywhere (v6)
(co-tenant rules for 80/443/3001/3306 untouched)

# Step 6 — Python 3.11 via uv (deadsnakes does not support questing)
Failed: deadsnakes PPA returned 404 for ubuntu-questing
Pivoted: $ curl -LsSf https://astral.sh/uv/install.sh | sh (as deploy)
$ ~/.local/bin/uv python install 3.11
Installed Python 3.11.15 in 2.07s
$ node --version -> v20.20.1 (already installed by co-tenant)

# Step 7 — deploy keypair + GH deploy key + clone
$ ssh-keygen on VPS -> ~/.ssh/id_ed25519 generated (deploy@email-extractor-staging)
$ gh repo deploy-key add -> key id 149010775, "vps-staging-76.13.22.110", read-only
$ git clone git@github.com:abedubas-alchemydev/email-extractor.git -> success
$ git log -1 --oneline -> 0b4a59e (matches local push)

# Step 8 — env files
$ cp .env.example .env && cp backend/.env.example backend/.env
$ openssl rand -hex 32 -> wrote to EMAIL_EXTRACTOR_API_KEY (redacted in logs)
$ sed -> DATABASE_URL=postgresql+asyncpg://postgres:postgres@postgres:5432/email_extractor
$ sed -> BACKEND_CORS_ORIGINS=http://76.13.22.110:3010,http://localhost:3010
$ chmod 0600 .env backend/.env
$ ls -la .env -> -rw------- 1 deploy deploy 2300 ...

# Step 8a — override file (refinement 1)
$ cat docker-compose.override.yml
services:
  frontend:
    ports:
      - "3010:3000"
$ cat .git/info/exclude | tail -1
docker-compose.override.yml
$ git status -> working tree clean (override correctly local-excluded)

# Step 9 — bring up the stack
$ docker compose pull postgres -> Image postgres:15-alpine Pulled
$ docker compose up --build -d
FAILED: frontend stage 3 'COPY --from=builder /app/public ./public'
ERROR: failed to compute cache key: "/app/public": not found

Confirmed: ls frontend/public on local repo -> No such file or directory
create-next-app@14 with --no-src-dir does not create public/ unless the
template includes assets. Our scaffold's frontend/Dockerfile assumes it.

Pivoted: $ docker compose up --build -d postgres backend (frontend deferred)
 Container email-extractor-postgres Healthy
 Container email-extractor-backend Started

$ docker compose ps
NAME                       SERVICE    STATUS                    PORTS
email-extractor-backend    backend    Up 12 seconds             0.0.0.0:8000->8000/tcp
email-extractor-postgres   postgres   Up 18 seconds (healthy)   0.0.0.0:5432->5432/tcp

$ docker compose logs --tail=10 backend
INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)
INFO:     Application startup complete.

# Step 10 — health checks
on-VPS  curl http://localhost:8000/health         -> {"status":"ok"}
on-VPS  curl http://localhost:8000/api/v1/health  -> {"status":"ok"}
off-VPS curl http://76.13.22.110:8000/health      -> {"status":"ok"}
off-VPS curl http://76.13.22.110:8000/api/v1/health -> {"status":"ok"}
off-VPS curl http://76.13.22.110:3010 -> DEFERRED (frontend never built)

# Step 11 — restart policy
$ grep restart docker-compose.yml -> no matches -> recorded as follow-up
```

### Plan deviations

(a) Pre-flight discovered shared multi-tenant VPS. Plan amended per `plans/vps-staging-approval-2026-04-19.md` before any destructive command ran.

(b) Frontend host port remapped to `3010` via VPS-local `docker-compose.override.yml` (not committed). Override added to VPS clone's `.git/info/exclude`.

(c) sshd hardening (Step 5d) skipped entirely to respect co-tenants. `PermitRootLogin yes` left as found.

(d) UFW add-only: two new rules (`8000/tcp`, `3010/tcp`); existing rules untouched. No `ufw default deny`, no `ufw --force enable`, no `ufw allow 3000/tcp`.

(e) `/var/run/reboot-required` present on the VPS at start of run; reboot deferred to coordinated window with co-tenant admin.

(f) **Skipped `apt-get upgrade -y`** in Step 3. Reboot was already pending; running another upgrade would compound pending kernel/service restarts and risk affecting co-tenant workloads. Essentials install (`apt-get install -y …`) ran successfully.

(g) **Step 4 Docker install was a no-op** — Docker 29.1.5 + Compose v5.0.2 already on the host from prior provisioning. Verified versions; did not re-run the apt repo dance.

(h) **Step 6 Python 3.11 install pivoted from deadsnakes PPA to `uv`.** Ubuntu 25.10 (`questing`) doesn't yet have deadsnakes packages — the repo returned 404. `uv 0.11.7` was installed for the `deploy` user, then `uv python install 3.11` provisioned `Python 3.11.15` under `~deploy/.local/share/uv/python/`. Same approach as the local-machine scaffold's amended Step 4. Failed deadsnakes PPA was cleanly removed (`add-apt-repository -r`).

(i) **Step 5d sshd hardening skipped** (per approval), and Acceptance Criteria items "ssh root fails" and "PermitRootLogin no" recorded as **NOT APPLICABLE**, not failures.

(j) **`gh repo create` used explicit name** `abedubas-alchemydev/email-extractor` rather than relying on `--source=.` directory inference. The local directory is literally `Email Extractor` (with a space) which would have caused a misnamed repo.

(k) **Frontend container did not build.** `frontend/Dockerfile` line 31 (`COPY --from=builder /app/public ./public`) failed — `create-next-app@14 --no-src-dir` did not create a `public/` directory in our scaffold. Brought up `postgres + backend` only, deferred frontend per the prompt's "do not hot-fix Dockerfile from the VPS" constraint.

(l) **Step 12 runbook commit skipped** — durable findings persisted to project memory (`reference_vps_76_13_22_110.md`) instead. A `docs/runbooks/vps-staging.md` file would duplicate that content. Per the prompt: "if nothing durable was learned, skip the commit — an empty runbook is worse than none."

### Decisions made on the fly

- **Decision:** Skip `apt-get upgrade -y` in Step 3.
  - **Alternatives considered:** (a) run upgrade + leave the resulting reboot pending (compounds with the existing pending reboot); (b) skip upgrade entirely.
  - **Rationale:** A reboot was already pending. Adding more pending changes increases the blast radius when the co-tenant admin eventually coordinates a reboot. Essentials install is unaffected by skipping upgrade.
  - **ADR:** inline.

- **Decision:** Use `uv` to provision Python 3.11 instead of deadsnakes PPA.
  - **Alternatives considered:** (a) install python3.13 from Ubuntu's default repo (host/Dockerfile mismatch); (b) build python3.11 from source (slow, brittle); (c) skip Step 6 entirely (host-tools convenience lost).
  - **Rationale:** `uv` is already the local-dev convention for this project. It works on `questing` without repo dependencies. Same managed Python the developer uses locally.
  - **ADR:** inline.

- **Decision:** Bring up `postgres + backend` only after frontend build failure, rather than aborting Step 9 entirely.
  - **Alternatives considered:** (a) abort Step 9, leave nothing running; (b) continue with full `up --build -d` (already failed).
  - **Rationale:** Validates the rest of the stack works (env loading, compose networking, postgres healthcheck, backend boot). Generates evidence for partial-status Outcome. Backend health checks pass — the architecture is sound; only the frontend Dockerfile has a bug.
  - **ADR:** inline.

### Followups for Cowork

**Highest priority (blocks frontend on VPS):**

1. **`prompts/2026-04-19-XXXX-fix-frontend-public-dir.md`** — Decide between (a) committing an empty `frontend/public/.gitkeep` (simplest), (b) adding `mkdir -p public` to `frontend/Dockerfile` builder stage, or (c) wrapping the COPY in a conditional. Option (a) matches what `create-next-app` does for templates with assets and is forward-compatible. Once fixed locally + pushed, `ssh deploy@76.13.22.110 'cd ~/apps/email-extractor && git pull && docker compose up --build -d'` finishes the staging deploy.

**Medium priority:**

2. **Add `restart: unless-stopped` to all three services in `docker-compose.yml`.** Currently nothing auto-restarts on host reboot or container failure. Tiny compose-file change; one commit.

3. **Coordinate reboot window with co-tenant admin** to clear `/var/run/reboot-required`. Out-of-band coordination, not a CC CLI prompt.

4. **TLS strategy for staging.** Three options (also in reference memory):
   - (i) Coordinate with co-tenant admin to add an nginx vhost proxying `email-extractor-staging.<domain>` -> `localhost:8000` and `:3010`.
   - (ii) Bring our own Caddy on a different port pair (e.g., 8443 -> backend, 8444 -> frontend); awkward UX but doesn't touch the existing nginx.
   - (iii) Defer TLS until the Cloud Run cutover post-merge with `fis-lead-gen`.

**Lower priority:**

5. **Parameterize frontend host port** in committed `docker-compose.yml` via `FRONTEND_HOST_PORT` env var so future shared-VPS deployments don't need an override file. From the approval doc.

6. **Promote multi-tenancy lessons to `CLAUDE.md` §9** if Arvin wants the next agent to learn this without loading the project memory file. Currently the lessons live only in `auto-memory/reference_vps_76_13_22_110.md`.

7. **Investigate why `frontend/public/` is missing on the local clone.** Might be a `create-next-app@14` flag interaction (`--no-src-dir` + tailwind template), or a per-version oddity. Either way, once the public/ fix lands, the local `frontend/Dockerfile` build will work for the docker-stack-setup prompt too.

**Surprises uncovered:**

- **Ubuntu 25.10 has no deadsnakes coverage yet.** Future prompts that need older Python versions on questing should default to `uv python install <version>` rather than apt PPAs.
- **The VPS is shared.** This was the biggest single finding — the prompt as authored treated it as a fresh box. The reference memory now persists this for every future prompt that touches this host.
- **Co-tenant uses ports 3000–3003 on the host** — any other port we pick on this VPS should avoid that range to be a good citizen.
- **`gh auth switch` is silent on success but takes effect immediately** — confirmed by `gh auth status` showing `Active account: true` for `abedubas-alchemydev` after the switch.
- **The fact-forcing-gate hook also fires on Edit operations**, requiring per-edit fact presentations. Future planning should account for additional turn-cost on prompts that do many small edits.

### Risks / concerns

- **Frontend on VPS is broken until follow-up #1 lands.** Off-VPS users hitting `http://76.13.22.110:3010` will get a connection refused. Backend works in isolation; UI work is blocked.
- **Stack does NOT auto-restart on host reboot.** When the co-tenant admin reboots to clear the pending kernel update, our backend + postgres will need a manual `docker compose up -d` to come back. Mitigated by follow-up #2.
- **`EMAIL_EXTRACTOR_API_KEY` was generated on the VPS and never written down outside `~/apps/email-extractor/.env`.** If `.env` is wiped, the key is unrecoverable. For staging this is acceptable; for any persistence beyond staging, capture the key into a password manager out-of-band.
- **`PermitRootLogin yes` remains** on the VPS — this was deliberate (decision 2) but a defender's perspective would flag it. Mitigated only by the co-tenant relying on the same posture.
- **Postgres data lives in the named docker volume `email-extractor-pg-data`.** No backup. `docker compose down --volumes` would wipe it (constraint already documents this); ordinary `docker compose down` preserves it.
- **No HTTPS.** Sensitive data should not be put through this staging deploy until TLS strategy (follow-up #4) is picked.
