# Plan — VPS staging setup execution

**Prompt:** `prompts/2026-04-19-0916-vps-staging-setup.md`
**Author:** CC CLI (Claude Code)
**Date:** 2026-04-19
**Target host:** `root@76.13.22.110` → later `deploy@76.13.22.110`

## Pre-flight checks (already verified)

| Item | Required | Found | OK? |
|------|----------|-------|-----|
| `gh` CLI | for Step 1 | 2.87.3 | yes |
| `gh` account `abedubas-alchemydev` | active for Step 1c push | authenticated (currently inactive — need `gh auth switch`) | yes (with switch) |
| Local SSH key for VPS | for all VPS steps | `~/.ssh/id_ed25519` (Ed25519, picked up by default) | yes |
| SSH agent | not strictly required if default key works | `ssh-agent` service is `Stopped/Disabled` on Windows | n/a — default key works (verified) |
| VPS reachable | for Steps 2–11 | `ssh root@76.13.22.110 uname -a` returned `Linux srv1292086 6.17.0-20-generic … x86_64 GNU/Linux` | yes |
| OS family | drives Step 3 package commands | Ubuntu (kernel 6.17 → likely 25.04 or 26.04); will confirm `/etc/os-release` in Step 2 | yes — Ubuntu/Debian path applies |
| Scaffold prompt complete | prerequisite for Step 1 | yes — 9 commits on local main; `verify.sh` exits 0 | yes |
| Docker stack tested locally | nice-to-have prerequisite | NO — `prompts/2026-04-19-0845-docker-stack-setup.md` has not been run; Docker isn't installed locally either | accept the risk, proceed (see Risks) |
| Uncommitted edits to this prompt file | Step 1a addresses | yes — 1 modified prompt file, ~64-line diff adding the GitHub-push prereq + deploy-key flow (matches Step 1's stated purpose) | covered |

## Step-by-step execution

### Step 0 — This plan
Once approved by the user.

### Step 1 — Push the scaffolded repo to GitHub (local)

**1a.** Commit the in-flight edit to `prompts/2026-04-19-0916-vps-staging-setup.md`:
- `git status` — verify only this prompt file is modified.
- `git add prompts/2026-04-19-0916-vps-staging-setup.md && git commit -m "docs(prompts): add github push prereq and deploy-key flow to vps staging prompt"`.
- `git log -1 --pretty=full` — confirm zero AI attribution.

**1b.** Switch gh account:
- `gh auth switch --user abedubas-alchemydev --hostname github.com`.
- `gh auth status` — confirm `abedubas-alchemydev` is now `Active account: true`.
- `git status` — clean.
- `git log --oneline` — should show 9 scaffold commits + the 1a commit = 10 commits.

**1c.** Create remote (if missing) and push:
- `gh repo view abedubas-alchemydev/email-extractor` — if it errors, create with `gh repo create … --private --source=. --remote=origin --push`.
- If it exists, `git remote add origin https://github.com/abedubas-alchemydev/email-extractor.git` (unless already set), then `git push -u origin HEAD`.
- `gh repo view abedubas-alchemydev/email-extractor --json defaultBranchRef,pushedAt,visibility` — confirm `visibility: PRIVATE`.
- `git log -1 --pretty=full` — re-confirm no AI trailer on the head commit.

### Step 2 — Reach the host and detect OS

```bash
ssh -o StrictHostKeyChecking=accept-new root@76.13.22.110 \
  'uname -a; cat /etc/os-release; head -n 3 /proc/meminfo; df -h /; nproc'
```

Capture into Outcome → Evidence. Already partially verified — kernel 6.17, Ubuntu. If `/etc/os-release` reports Ubuntu, proceed with the Ubuntu apt path in Step 3/4. If Debian, swap the Docker repo URL prefix. If neither, stop.

### Step 3 — Base system update + essentials + swap

On the VPS as root:
- `apt-get update && apt-get upgrade -y` (warning: this can take 5-10 min on a fresh image; will run in foreground but expect noise).
- `apt-get install -y ca-certificates curl git gnupg lsb-release ufw fail2ban unattended-upgrades build-essential pkg-config postgresql-client vim less htop jq`.
- `timedatectl set-timezone UTC`.
- Conditional swap: only if RAM < 2 GB. The 2 GB swapfile creation is gated on `swapon --show | grep -q '/swapfile'`.

### Step 4 — Install Docker Engine + Compose V2

Use Docker's official apt repo (`download.docker.com/linux/ubuntu`). Idempotent: `apt-get install -y docker-ce …` is a no-op if already installed.
- `docker --version` and `docker compose version` should succeed.

### Step 5 — Deploy user + key authorize + SSH harden + UFW

**Critical sequencing — order matters:**

5a. Create `deploy` user (idempotent: `id -u deploy >/dev/null 2>&1 || adduser …`); add to `docker` and `sudo` groups; create `~/.ssh` with mode 700.

5b. Copy `/root/.ssh/authorized_keys` to `/home/deploy/.ssh/authorized_keys`; chown deploy:deploy; chmod 600.

5c. **Verify deploy login works BEFORE hardening sshd:**
```bash
ssh deploy@76.13.22.110 'whoami && groups | tr " " "\n" | grep -E "^(docker|sudo)$"'
```
Expect `deploy` + `docker` + `sudo`. If this fails, fix permissions before proceeding.

5d. Harden `/etc/ssh/sshd_config`:
- `PermitRootLogin no`
- `PasswordAuthentication no`
- `ChallengeResponseAuthentication no`
- `sshd -t && systemctl reload ssh` (sshd -t aborts on syntax error, preserving the live session).

5e. Enable UFW with SSH allowed first:
- `ufw default deny incoming && ufw default allow outgoing`
- `ufw allow 22/tcp` (must come BEFORE enable)
- `ufw allow 3000/tcp && ufw allow 8000/tcp` (staging exposes app ports for internal testing)
- `ufw --force enable && ufw status verbose`

### Step 6 — Install Python 3.11 + Node 20 (host-level convenience)

The prompt says this is optional. I'll execute it for parity with the parent project's tooling expectations on the host (`scripts/run_*.py` ergonomics later). On Ubuntu via deadsnakes PPA + NodeSource. Idempotent.

### Step 7 — Switch to deploy user + clone repo

7a. Generate Ed25519 deploy keypair on the VPS as `deploy` (idempotent: only if `~/.ssh/id_ed25519` doesn't exist), then capture the pubkey back to local.

7b. Register the pubkey as a **read-only** deploy key on the GitHub repo via `gh repo deploy-key add`. Title: `vps-staging-76.13.22.110`. Idempotent: skip if a key with that title already exists.

7c. Pre-seed `known_hosts` for github.com on the deploy user. Then `git clone git@github.com:abedubas-alchemydev/email-extractor.git` (or `git pull --ff-only` if already cloned). Confirm HEAD SHA matches local push.

### Step 8 — Populate `.env` files on the VPS

Copy `.env.example` → `.env` and `backend/.env.example` → `backend/.env`. Edit the root `.env`:
- `DATABASE_URL=postgresql+asyncpg://postgres:postgres@postgres:5432/email_extractor` (compose hostname, not localhost).
- `BACKEND_CORS_ORIGINS=http://76.13.22.110:3000,http://localhost:3000`.
- `EMAIL_EXTRACTOR_API_KEY=<openssl rand -hex 32>` (generated on the VPS, never written down).

Provider API keys (`HUNTER_API_KEY`, `APOLLO_API_KEY`, `SNOV_API_KEY`) left blank for staging; documented as a deviation per the prompt's instruction.

`chmod 0600 .env backend/.env`.

### Step 9 — Bring up the stack

```bash
cd ~/apps/email-extractor
docker compose pull postgres
docker compose up --build -d
sleep 15
docker compose ps
docker compose logs --tail=80 backend
docker compose logs --tail=80 frontend
```

All services Up/Healthy.

### Step 10 — Health checks (on-VPS + off-VPS)

On the VPS:
```bash
curl -fsS http://localhost:8000/health | grep -q '"status":"ok"'
curl -fsS http://localhost:8000/api/v1/health | grep -q '"status":"ok"'
curl -fsS -o /dev/null -w '%{http_code}\n' http://localhost:3000   # 200
```

From local machine (different terminal back on local):
```bash
curl -fsS http://76.13.22.110:8000/health | grep -q '"status":"ok"'
curl -fsS http://76.13.22.110:8000/api/v1/health | grep -q '"status":"ok"'
curl -fsS -o /dev/null -w '%{http_code}\n' http://76.13.22.110:3000
```

### Step 11 — Auto-restart policy check

`grep restart docker-compose.yml`. If `restart: unless-stopped` is missing on each service, file a follow-up prompt — DO NOT edit compose from the VPS (constraint).

### Step 12 — Optional runbook commit (local)

I'll only write `docs/runbooks/vps-staging.md` if something durable surfaces during execution (e.g., an Ubuntu version quirk, a package not in the playbook, a recovery procedure). Empty runbook is worse than none. Default: skip.

## Commit plan

| # | Subject | Files |
|---|---------|-------|
| 0a | `docs(plans): add vps-staging-setup execution plan` | `plans/vps-staging-setup-2026-04-19.md` |
| 1 | `docs(prompts): add github push prereq and deploy-key flow to vps staging prompt` | `prompts/2026-04-19-0916-vps-staging-setup.md` |
| 2 (optional, only if durable lessons surface) | `docs: add staging VPS runbook` | `docs/runbooks/vps-staging.md` |
| 3 (mandatory at the end) | `docs(prompt): record outcome of vps-staging-setup` | `prompts/2026-04-19-0916-vps-staging-setup.md` |

Net commits added by this prompt: 3 mandatory (plan + prompt edit + outcome) plus 1 optional runbook = 3 to 4 commits.

## Risks called out

1. **VPS lockout risk** — Step 5 disables root SSH. The verification sub-step (`ssh deploy@…`) BEFORE the disable is the safety net. If it fails, halt before sshd reload. If `sshd -t` fails, halt. If the post-reload session hangs, the original session stays alive (sshd reload doesn't drop existing connections). Worst case: console access via VPS provider's web console — out-of-scope for this prompt.
2. **UFW lockout risk** — order is `default deny → allow 22 → enable`. Skipping the `allow 22` line locks us out instantly. Plan executes the prompt's commands verbatim; will not deviate.
3. **`apt-get upgrade` may reboot-require** — Ubuntu staging upgrades sometimes flag a reboot needed. Plan: don't auto-reboot; check `[ -f /var/run/reboot-required ]` after upgrade and surface it in Outcome → Risks. A reboot mid-prompt would interrupt SSH and potentially confuse the orchestration.
4. **Repo private + deploy key dependency** — Step 7c clone uses `git@github.com:…`, which requires the deploy key registered in 7b. If 7b silently registers the wrong key (e.g., from a prior run), 7c will fail with "Permission denied (publickey)". Validation: `gh repo deploy-key list` after add.
5. **Docker stack untested locally** — `prompts/2026-04-19-0845-docker-stack-setup.md` was never run because Docker isn't installed locally. The first time the compose file runs end-to-end is on the VPS. If it fails, per the constraint, I stop and file a follow-up. Specific risks:
   - Backend Dockerfile uses `pip install` of `requirements.txt` which includes `psycopg[binary]==3.2.13` and `asyncpg>=0.30.0` — both have native compile steps if a wheel isn't available for the base image. May add minutes to build.
   - Frontend Dockerfile uses `npm ci` which requires the lockfile and `package.json` to be consistent — they are (locally verified).
   - Compose's `depends_on: condition: service_healthy` requires Compose v2 — the prompt installs Compose plugin via official repo, so this is fine.
6. **`gh repo create --source=. --push`** infers the repo name from the directory name. Our directory is literally `Email Extractor` (with a space). The `--source=.` flag may misbehave with the space — I'll use `gh repo create abedubas-alchemydev/email-extractor --private --source=. --remote=origin --push` with the explicit name to defeat directory-name inference.
7. **Time on host** — `apt-get upgrade` + Docker install + first `docker compose up --build` could take 15-30 min total in real time. Plan executes blocking commands serially with appropriate `timeout` settings on the Bash tool calls (5–10 min ceiling each; longer for `up --build`).
8. **Active gh account is `akosiArvin081596` right now.** I'll do the `gh auth switch` first thing in 1b, BEFORE any `gh` operation that creates resources.

## Out of scope (matches prompt §"Out of scope")

- Production TLS / domain / reverse proxy.
- Monitoring / alerting / backups.
- CI/CD push-to-deploy.
- Vault / Doppler / secret manager.
- App-code or Dockerfile/compose changes.

## Approval gate

Awaiting user confirmation before executing Step 1.
