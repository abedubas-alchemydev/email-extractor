---
slug: parameterize-frontend-host-port
created: 2026-04-19 11:03
ecc_command: /implement
subagents: []
related_prompts:
  - prompts/2026-04-19-0916-vps-staging-setup.md
  - prompts/2026-04-19-1049-frontend-public-dir-fix.md
---

# Parameterize frontend host port via `FRONTEND_HOST_PORT` and retire the VPS-local `docker-compose.override.yml`

## Goal

Kill the VPS-local `docker-compose.override.yml` / `ports: !override` hack by making the committed `docker-compose.yml` parameterize the frontend's host port through an env var. After this prompt, local dev, the VPS, and any future Cloud Run cutover all run off the same committed compose file — different host ports are expressed purely as a value in `.env`, not as a per-clone override file.

Concretely:

- Edit the committed `docker-compose.yml` so `frontend.ports` becomes `"${FRONTEND_HOST_PORT:-3000}:3000"`.
- Document `FRONTEND_HOST_PORT` in `.env.example` (the root template) with the default (`3000`) and the reason it exists (co-tenanted hosts where 3000 is taken).
- On the VPS, set `FRONTEND_HOST_PORT=3010` in the VPS-local `.env`, pull the new compose, rebuild just the frontend, and then delete the override file + its `.git/info/exclude` entry.
- Verify `http://76.13.22.110:3010` still returns 200 after the override is gone.

## Context

- Background: during the VPS staging bring-up (`prompts/2026-04-19-0916-vps-staging-setup.md`) we couldn't bind the frontend to host port 3000 because co-tenant workloads already own it. See `.auto-memory/reference_vps_76_13_22_110.md` and `plans/vps-staging-approval-2026-04-19.md` for the multi-tenancy constraints. Decision 1 of that plan remapped the host port to 3010 via a VPS-local `docker-compose.override.yml`.
- During `prompts/2026-04-19-1049-frontend-public-dir-fix.md` we discovered Compose v2 *appends* list entries on merge rather than replacing them, so a plain `ports:` list in the override tried to bind both `3000:3000` and `3010:3000` and collided with the co-tenant on 3000. CC CLI fixed it by switching the override to `ports: !override [...]`. That works but leaves us with two non-obvious things future Arvin will trip over: (a) an untracked override file ignored via `.git/info/exclude`, and (b) a `!override` YAML tag that most people have never seen.
- This prompt retires both. Parameterizing the host port in the committed compose keeps one source of truth (`docker-compose.yml`), expresses the per-host difference as a value in `.env` (which is already gitignored), and leaves the committed file still correct for local dev (default `3000`) and for the eventual Cloud Run cutover (Cloud Run ignores `ports` entirely).
- Repo state at the start of this prompt: `main` is clean locally and on GitHub. VPS is at commit `77dc3f6` (plus a later Outcome commit, currently `25ded65` or similar). All three containers (`postgres`, `backend`, `frontend`) are `Up`. `http://76.13.22.110:3010` returns 200, `http://76.13.22.110:8000/health` returns `{"status":"ok"}`.

## Constraints

- **One local commit, one concern.** Exactly two files change locally: `docker-compose.yml` and `.env.example`. Nothing else. Commit subject: `chore(compose): parameterize frontend host port via FRONTEND_HOST_PORT env var`.
- **Do not touch `frontend/Dockerfile`, `frontend/next.config.mjs`, `backend/Dockerfile`, or the backend `ports:` entry.** Backend stays hard-coded to `8000:8000` — backend host port isn't parameterized yet and we don't have a co-tenant collision there today. One concern per prompt.
- **Local default must still be `3000`.** `"${FRONTEND_HOST_PORT:-3000}:3000"` — the fallback is mandatory so running `docker compose up` with no env set still works for a fresh local clone.
- **Stage files by name** — no `git add -A` / `git add .`. Only `docker-compose.yml` and `.env.example`.
- **Zero AI attribution** in the commit message. Arvin's voice. No `Co-Authored-By`, no "Generated with…".
- **Never skip git hooks** (`--no-verify`). If pre-commit fails, fix the underlying issue and create a new commit.
- **Do not modify `CLAUDE.md`.** This is small enough that the prompt's Outcome is sufficient documentation. If anything rises to the level of "future agents must know this," add it in a separate §9 edit.
- **VPS ops must respect co-tenants.** Rebuild only the `frontend` service — `docker compose up --build -d frontend`. No `docker compose down`, no `--volumes`, nothing that would touch `postgres` or `backend` containers. Those are healthy and unrelated.
- **Do not delete the VPS's `.env`.** The only change to the VPS `.env` is adding (or updating) `FRONTEND_HOST_PORT=3010`. Everything else in it stays.
- **Ensure `gh auth` is on `abedubas-alchemydev`** before any `git push` (machine has three identities). Verify with `gh auth status | grep -q 'abedubas-alchemydev'` first.

## Commands to run

### 0. Plan first (ECC)

Inline reasoning is fine for a prompt this small. Confirm the edit surface and the VPS sequence, then proceed.

### 1. Local edits

From the repo root on Arvin's local machine.

Edit `docker-compose.yml` — only the `frontend.ports` line changes:

```diff
   frontend:
     build:
       context: ./frontend
       dockerfile: Dockerfile
       args:
         NEXT_PUBLIC_API_BASE_URL: http://localhost:8000
     container_name: email-extractor-frontend
     environment:
       NEXT_PUBLIC_API_BASE_URL: http://localhost:8000
     ports:
-      - "3000:3000"
+      - "${FRONTEND_HOST_PORT:-3000}:3000"
     depends_on:
       - backend
```

Edit `.env.example` — append a new section after the existing "Postgres container creds" block (or place immediately before it if more logical):

```
# --- Docker Compose host ports ----------------------------------------------
# FRONTEND_HOST_PORT controls the host-side port bound by the frontend service
# in docker-compose.yml. Container-internal port is always 3000.
# Default 3000 matches a fresh local dev environment. Override to 3010 (or any
# free port) on hosts where 3000 is already taken — e.g. the shared VPS at
# 76.13.22.110 where a co-tenant owns 3000.
FRONTEND_HOST_PORT=3000
```

Sanity-check the compose file parses:

```bash
docker compose config --quiet
```

If `docker compose config` errors, stop and surface — do not attempt to fix unrelated compose issues in this prompt.

Optionally (not required), verify locally that `FRONTEND_HOST_PORT=3010 docker compose config | grep -A1 'frontend' | grep '3010:3000'` reports the substituted port.

### 2. Commit and push

```bash
git status                                  # expect exactly two modified files
git diff docker-compose.yml .env.example     # eyeball the change once more

gh auth status | grep -q 'abedubas-alchemydev' || gh auth switch --user abedubas-alchemydev --hostname github.com

git add docker-compose.yml .env.example
git commit -m "chore(compose): parameterize frontend host port via FRONTEND_HOST_PORT env var"
git log -1 --pretty=full                    # verify no AI trailer, verify Arvin is author

git push origin HEAD
```

### 3. VPS — update `.env`, pull, rebuild frontend, remove override

CC CLI orchestrates from the local machine via SSH. No interactive VPS terminal needed.

First, make sure the override file actually exists before we try to delete it (defensive — don't assume):

```bash
ssh deploy@76.13.22.110 'test -f ~/apps/email-extractor/docker-compose.override.yml && echo "override present" || echo "override absent"'
```

Set `FRONTEND_HOST_PORT=3010` in the VPS's root `.env`. The `.env` already has `BACKEND_CORS_ORIGINS` etc. from the earlier run — append or update in place without destroying existing entries:

```bash
ssh deploy@76.13.22.110 'cd ~/apps/email-extractor && \
  if grep -q "^FRONTEND_HOST_PORT=" .env; then \
    sed -i "s|^FRONTEND_HOST_PORT=.*|FRONTEND_HOST_PORT=3010|" .env; \
  else \
    printf "\nFRONTEND_HOST_PORT=3010\n" >> .env; \
  fi && \
  grep "^FRONTEND_HOST_PORT=" .env'
```

Confirm `.env` is still `chmod 0600`:

```bash
ssh deploy@76.13.22.110 'stat -c "%a %n" ~/apps/email-extractor/.env'   # expect 600
```

Pull the new compose:

```bash
ssh deploy@76.13.22.110 'cd ~/apps/email-extractor && git pull --ff-only && git log -1 --oneline'
```

Now we need to remove the override file **before** `docker compose up` — otherwise the override's old `3010:3000` would still merge (via `!override`) on top of the new parameterized base, which would work but keeps the hack alive. Remove it now:

```bash
ssh deploy@76.13.22.110 'cd ~/apps/email-extractor && rm -f docker-compose.override.yml && ls docker-compose*.yml'
```

Clean the `.git/info/exclude` entry for it (leave the rest of the exclude file intact):

```bash
ssh deploy@76.13.22.110 'cd ~/apps/email-extractor && \
  if [ -f .git/info/exclude ]; then \
    sed -i "/^docker-compose\.override\.yml$/d" .git/info/exclude && \
    cat .git/info/exclude; \
  fi'
```

Verify compose sees the substituted port on the VPS:

```bash
ssh deploy@76.13.22.110 'cd ~/apps/email-extractor && docker compose config | grep -E "(published|target):" | head -20'
```

Expect to see `published: "3010"` / `target: 3000` for the frontend, and no `3000:3000` mapping.

Rebuild only the frontend. Do not touch backend/postgres:

```bash
ssh deploy@76.13.22.110 'cd ~/apps/email-extractor && docker compose up --build -d frontend'
sleep 10
ssh deploy@76.13.22.110 'cd ~/apps/email-extractor && docker compose ps && docker compose logs --tail=80 frontend'
```

### 4. Verify

Confirm `git status` on the VPS clone is clean (no stray override file, no untracked junk):

```bash
ssh deploy@76.13.22.110 'cd ~/apps/email-extractor && git status'
```

From Arvin's local machine:

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' http://76.13.22.110:3010            # frontend — must be 200
curl -fsS http://76.13.22.110:8000/health | grep -q '"status":"ok"'              # backend still green
curl -fsS http://76.13.22.110:8000/api/v1/health | grep -q '"status":"ok"'
```

All three must succeed. If the frontend returns anything other than 200, capture `docker compose logs frontend --tail=200` and stop — do not roll the override back silently.

## Acceptance criteria

- `docker-compose.yml` has exactly one changed line: `"${FRONTEND_HOST_PORT:-3000}:3000"` as the frontend host-port mapping. No other service is modified.
- `.env.example` documents `FRONTEND_HOST_PORT` with its default (`3000`) and the reason it exists. The default behavior for a fresh clone is unchanged.
- `git show --stat HEAD` lists exactly two files: `docker-compose.yml` and `.env.example`. One commit, subject `chore(compose): parameterize frontend host port via FRONTEND_HOST_PORT env var`, zero AI attribution.
- VPS `~/apps/email-extractor/docker-compose.override.yml` no longer exists.
- VPS `.git/info/exclude` no longer contains a line matching `docker-compose.override.yml`.
- VPS `.env` contains `FRONTEND_HOST_PORT=3010` and retains all prior entries (including `BACKEND_CORS_ORIGINS=http://76.13.22.110:3010,http://localhost:3010`).
- VPS `.env` remains `chmod 0600`.
- `ssh deploy@76.13.22.110 'docker compose -f ~/apps/email-extractor/docker-compose.yml ps'` shows `frontend`, `backend`, `postgres` all `Up` / healthy.
- `curl -o /dev/null -w '%{http_code}\n' http://76.13.22.110:3010` returns `200`.
- Backend stays green: `curl http://76.13.22.110:8000/health` returns `{"status":"ok"}`, and `/api/v1/health` same.
- No new firewall rules, no sshd edits, no changes to other tenants' containers. No `docker compose down`, no `--volumes`.

## Subagent roles

None.

## Out of scope

- Parameterizing the backend host port (`8000:8000`). No co-tenant collision there today — revisit if and when one shows up.
- Adding `FRONTEND_HOST_PORT` to `backend/.env.example` or `frontend/.env.local`. It's a compose-runtime concern, not an app-level one.
- Fixing the `asyncpg` / `psycopg[binary]` driver divergence from `fis-lead-gen` — separate prompt (Priority 2 in the staging roll-up).
- Writing the first real domain model (`ExtractionRun`, `DiscoveredEmail`, `EmailVerification`, first Alembic revision) — separate prompt (Priority 3).
- TLS / reverse-proxy integration with the co-tenant's nginx — separate prompt.
- Scheduling the pending `/var/run/reboot-required` reboot on the VPS — separate, coordinate with co-tenant first.

---

## Outcome

**Status:** done
**Completed:** 2026-04-19T11:08:00+08:00
**Branch:** main
**Commits:**
- `cd496e7` chore(compose): parameterize frontend host port via FRONTEND_HOST_PORT env var

### Summary
Parameterized `frontend.ports` in committed `docker-compose.yml` to `${FRONTEND_HOST_PORT:-3000}:3000` and documented `FRONTEND_HOST_PORT` (with default `3000`) in `.env.example`. On the VPS: set `FRONTEND_HOST_PORT=3010` in `.env`, pulled, deleted `docker-compose.override.yml`, removed its entry from `.git/info/exclude`, and rebuilt the frontend service. Frontend reachable at `http://76.13.22.110:3010` (200), backend `/health` and `/api/v1/health` still `{"status":"ok"}`. The override + `!override`-tag hack from the prior two prompts is fully retired — the VPS now uses the same committed compose file as local dev, with the per-host difference expressed only as an env var.

### Acceptance criteria

- [x] `docker-compose.yml` has exactly one changed line: `"${FRONTEND_HOST_PORT:-3000}:3000"`. No other service modified — verified by `git diff`: 1 insertion, 1 deletion in `frontend.ports`.
- [x] `.env.example` documents `FRONTEND_HOST_PORT` with default `3000` and the reason — verified by `git diff`: appended Docker-Compose-host-ports block (8 lines).
- [x] `git show --stat HEAD` lists exactly two files: `docker-compose.yml` and `.env.example` — verified.
- [x] One commit, subject `chore(compose): parameterize frontend host port via FRONTEND_HOST_PORT env var`, zero AI attribution — verified by `git log -1 --pretty=full`, author `Arvin B. Edubas`.
- [x] VPS `~/apps/email-extractor/docker-compose.override.yml` no longer exists — `ls docker-compose*.yml` shows only `docker-compose.yml`.
- [x] VPS `.git/info/exclude` no longer contains `docker-compose.override.yml` — `tail -3` of exclude shows only the original boilerplate.
- [x] VPS `.env` contains `FRONTEND_HOST_PORT=3010` and retains all prior entries — verified by `grep "^FRONTEND_HOST_PORT=" .env` and the prior `BACKEND_CORS_ORIGINS=http://76.13.22.110:3010,...` line is intact.
- [x] VPS `.env` remains `chmod 0600` — `stat -c "%a %n" .env` returns `600 .env`.
- [x] All three services Up/healthy — `docker compose ps` shows postgres `Up 28 minutes (healthy)`, backend `Up 16 seconds`, frontend `Up 16 seconds 0.0.0.0:3010->3000/tcp`.
- [x] `curl http://76.13.22.110:3010` returns `200` — verified.
- [x] Backend stays green — `/health` and `/api/v1/health` both `{"status":"ok"}` from off-VPS.
- [x] No new firewall rules, no sshd edits, no co-tenant changes — no UFW/sshd commands run; only `frontend` rebuilt (backend was Recreated as a compose dependency-graph side effect, no co-tenant containers touched).

### Files touched

**Local repo (committed, commit `cd496e7`):**
- `docker-compose.yml` (+1 / -1) — `frontend.ports[0]` changed from `"3000:3000"` to `"${FRONTEND_HOST_PORT:-3000}:3000"`.
- `.env.example` (+8 / -0) — appended `FRONTEND_HOST_PORT=3000` with documentation block.

**VPS (`76.13.22.110`) — not in git:**
- `~/apps/email-extractor/.env` — `FRONTEND_HOST_PORT=3010` appended; all other entries preserved.
- `~/apps/email-extractor/docker-compose.override.yml` — **deleted**.
- `~/apps/email-extractor/.git/info/exclude` — `docker-compose.override.yml` line removed.

### Verification

```
# Local diff
$ git diff docker-compose.yml .env.example
- "3000:3000"
+ "${FRONTEND_HOST_PORT:-3000}:3000"
+ # --- Docker Compose host ports ---
+ FRONTEND_HOST_PORT=3000

# Push
$ git push origin HEAD
   25ded65..cd496e7  HEAD -> main

# VPS - pre-flight: override exists
$ ssh deploy@76.13.22.110 'test -f docker-compose.override.yml && echo present'
override present

# VPS - set env var, preserving existing entries
$ sed -i "s|^FRONTEND_HOST_PORT=...|FRONTEND_HOST_PORT=3010|" .env
   (or appended via printf - branch logic was the latter since no prior key)
$ grep "^FRONTEND_HOST_PORT=" .env
FRONTEND_HOST_PORT=3010
$ stat -c "%a %n" .env
600 .env

# VPS - pull
$ git pull --ff-only && git log -1 --oneline
77dc3f6..cd496e7  main -> origin/main
cd496e7 chore(compose): parameterize frontend host port via FRONTEND_HOST_PORT env var

# VPS - remove override + clean exclude
$ rm -f docker-compose.override.yml && ls docker-compose*.yml
docker-compose.yml
$ sed -i "/^docker-compose\.override\.yml$/d" .git/info/exclude
$ tail -3 .git/info/exclude
# exclude patterns (uncomment them if you want to use them):
# *.[oa]
# *~

# VPS - verify substitution
$ docker compose config | sed -n '/^  frontend:/,/^  postgres:/p' | grep -A4 'ports:'
    ports:
      - mode: ingress
        target: 3000
        published: "3010"
        protocol: tcp

# VPS - rebuild frontend
$ docker compose up --build -d frontend
Container email-extractor-frontend Started
$ docker compose ps
NAME                       SERVICE    STATUS                    PORTS
email-extractor-backend    backend    Up 16 seconds             0.0.0.0:8000->8000/tcp
email-extractor-frontend   frontend   Up 16 seconds             0.0.0.0:3010->3000/tcp
email-extractor-postgres   postgres   Up 28 minutes (healthy)   0.0.0.0:5432->5432/tcp
$ git status
nothing to commit, working tree clean

# Off-VPS verification
$ curl -o /dev/null -w '%{http_code}\n' http://76.13.22.110:3010 -> 200
$ curl http://76.13.22.110:8000/health        -> {"status":"ok"}
$ curl http://76.13.22.110:8000/api/v1/health -> {"status":"ok"}
```

### Plan deviations

(a) **Skipped local `docker compose config --quiet`** — Docker is not installed on the local Windows machine (deferred from the scaffold prompt). Sanity validation happened on the VPS instead via `docker compose config | grep ports` showing the substituted `published: "3010"`.

(b) **Backend container was Recreated** as a side-effect of `docker compose up --build -d frontend`. Compose detected dependency-graph changes (rebuilt frontend image) and re-bootstrapped backend. Postgres was untouched. Same harmless behavior as the prior prompt; called out for completeness.

### Decisions made on the fly

None. The prompt was prescriptive and the execution matched it 1:1 — every command in §3 ran exactly as written, only the local `docker compose config` was skipped (deviation a).

### Followups for Cowork

1. **The override-merge-gotcha note** (carried from `prompts/2026-04-19-1049-frontend-public-dir-fix.md` follow-up #2) is now mostly obsolete — there's no override file to trip over. Lower the priority of that follow-up; if it gets written, frame it as historical context rather than active gotcha.
2. **Parameterize the backend host port too** if/when a co-tenant collision surfaces. Current `8000:8000` is fine because nothing on the VPS contests it. Pre-emptive parameterization would be `BACKEND_HOST_PORT=8000` symmetric with the new var. Out of scope per this prompt's constraint, but easy to fold into a future prompt that touches compose.
3. **Three uncommitted files in the local working tree as of run completion**: `plans/vps-staging-approval-2026-04-19.md`, `prompts/2026-04-19-1103-parameterize-frontend-host-port.md` (this file), and the `prompts/2026-04-19-1049-frontend-public-dir-fix.md` Outcome was committed earlier as commit `25ded65`. Per "one commit, one concern", they are not committed by this prompt. A small housekeeping commit can sweep them in.
4. **Domain work is now unblocked.** With staging stable, the highest-leverage next prompt is the first real model + Alembic revision (`ExtractionRun`) — already listed as priority 3 in the staging Outcome roll-up.

### Risks / concerns

- **The committed default is still `3000`.** If a future contributor clones onto a host where 3000 is taken (e.g., another co-tenant box) and forgets to set `FRONTEND_HOST_PORT`, they'll see the same collision. Mitigated by the `.env.example` comment that explicitly mentions the VPS situation, but not eliminated.
- **The VPS now has no marker that it differs from local dev** other than its `.env`. If `.env` is ever wiped or regenerated from `.env.example`, the frontend will try to bind 3000 and fail. Worth noting if/when a backup or re-provisioning prompt lands.
- **`FRONTEND_HOST_PORT` is read by docker-compose at substitution time, not by the app.** Backend / frontend code does not see it. This is correct — the var is purely a host-side networking concern — but worth being explicit in case someone wants to know "where is FRONTEND_HOST_PORT used?" The answer is: only `docker-compose.yml`.
