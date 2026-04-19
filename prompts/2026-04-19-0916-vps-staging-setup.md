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
<!-- Filled in by CC CLI after execution. Do not pre-fill. -->

**Status:** _(succeeded | partial | blocked)_

**Summary:** _(2–4 sentences)_

**Commits:** _(SHA and message if the optional runbook commit was made; "none" otherwise)_

**Deviations from plan:** _(anything done differently from Commands / Constraints, and why — especially if the OS was not Ubuntu/Debian, if Docker install path diverged, or if API keys were actually populated)_

**Follow-ups:** _(suggested next prompts — e.g. "attach domain + Caddy reverse proxy", "add GH Actions staging deploy", "promote VPS restart-policy learnings to CLAUDE.md §9")_

**Evidence:**

```
# gh auth status + gh repo view (Step 1, confirms push landed under abedubas-alchemydev and repo is private)
<paste Step 1 tail>

# uname -a / os-release / meminfo / df / nproc (Step 2)
<paste Step 2 output>

# docker / compose versions (Step 4)
<paste Step 4 tail>

# ssh deploy@76.13.22.110 verification — whoami + groups (Step 5)
<paste Step 5 verification output>

# ufw status verbose
<paste>

# On-host curls (Step 10)
<paste Step 10 on-VPS block>

# Off-host curls from Arvin's machine (Step 10)
<paste Step 10 off-VPS block>

# docker compose ps
<paste>
```
