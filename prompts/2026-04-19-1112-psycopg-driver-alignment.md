---
slug: psycopg-driver-alignment
created: 2026-04-19 11:12
ecc_command: /implement
subagents: []
related_prompts:
  - prompts/2026-04-19-0840-initial-scaffold.md
  - prompts/2026-04-19-1103-parameterize-frontend-host-port.md
---

# Drop `asyncpg`, standardize on `psycopg[binary]` — match the `fis-lead-gen` parent driver

## Goal

Eliminate the driver divergence between this repo and `fis-lead-gen`. Parent uses `psycopg[binary]` (v3) as its single Postgres driver for both async runtime (`postgresql+psycopg://`) and sync Alembic migrations. This scaffold currently has **both** `psycopg[binary]==3.2.13` and `asyncpg>=0.30.0` in `backend/requirements.txt`, and defaults `DATABASE_URL` to `postgresql+asyncpg://...`. That's a deviation from the scaffold's own intent (ADR 0001 picks one driver, not two) and it's a merge-time landmine — any migration generated against asyncpg here would need re-verification on psycopg in the parent.

Fix it **before** Priority #3 writes the first real model and generates the first Alembic migration. The migration we commit must be generated against the driver we actually want to keep.

Concretely after this prompt:

- `backend/requirements.txt` has `psycopg[binary]==3.2.13` and **no `asyncpg`** line.
- `backend/app/core/config.py`'s default `database_url` uses `postgresql+psycopg://...`.
- `backend/alembic/env.py` no longer strips a driver suffix (psycopg serves both async and sync, so the URL doesn't need rewriting). The comment above the block is updated to explain the new reality.
- `backend/alembic.ini` comment updated (the one that mentions `+asyncpg` stripping).
- `docker-compose.yml` backend service `DATABASE_URL` env var uses `postgresql+psycopg://`.
- `.env.example` (root) and `backend/.env.example` both document `postgresql+psycopg://`.
- `backend/app/main.py`'s comment about "selector loop policy for psycopg/asyncpg" stays accurate (psycopg on Windows still wants the selector loop), but drop the `/asyncpg` — we no longer use it.
- VPS `~/apps/email-extractor/.env` has its `DATABASE_URL` flipped from `postgresql+asyncpg://...` to `postgresql+psycopg://...`. Backend container rebuilt on VPS; `/health` and `/api/v1/health` still return `{"status":"ok"}`.

## Context

- Scaffold deviation history: the initial scaffold prompt specified `psycopg[binary]==3.2.13` as the pinned driver, but the default `DATABASE_URL` in `core/config.py` and `docker-compose.yml` shipped as `postgresql+asyncpg://`. CC CLI noticed at build time that the URL scheme demanded `asyncpg` and added `asyncpg>=0.30.0` to `requirements.txt` to make the backend boot. Recorded as a flagged follow-up in the scaffold Outcome.
- Parent (`fis-lead-gen`) uses `psycopg` exclusively. It runs `postgresql+psycopg://` for the async engine and the same scheme for Alembic (psycopg v3 supports both modes natively — no driver stripping required). See `fis-lead-gen/backend/requirements.txt` and `fis-lead-gen/backend/app/core/config.py` for the reference pattern.
- Why psycopg and not asyncpg: ADR 0001 (`docs/decisions/0001-initial-stack.md`) pinned the driver to match parent. asyncpg is faster in microbenchmarks but `fis-lead-gen`'s prod path is psycopg — matching the parent avoids generator-replay surprises at merge time and keeps one mental model for the whole platform.
- psycopg v3 specifics: the `[binary]` extra ships precompiled wheels (no libpq build on `pip install`). Async support is native to psycopg 3 — no separate package. SQLAlchemy routes `postgresql+psycopg://...` to psycopg for both sync and async engines depending on which factory you call (`create_engine` vs `create_async_engine`).
- Why this must land before Priority #3: the first Alembic migration (`alembic revision --autogenerate`) connects via `DATABASE_URL`. If the URL still names asyncpg when we autogenerate, the migration file gets generated against asyncpg's reflection, and anyone re-running it on a psycopg target later may hit subtle differences (type reflection, autocommit semantics). Fix the driver first, then let #3 generate its migration against the driver we're keeping.
- Repo state at the start of this prompt: `main` is at `e48debb` locally and on GitHub. VPS is at `e48debb`, all three containers `Up`, `http://76.13.22.110:3010` and `http://76.13.22.110:8000/health` green.
- `backend/.venv/` exists locally with both drivers installed. We don't care — the venv is gitignored. The source of truth is `requirements.txt`; the venv can be refreshed at any time.

## Constraints

- **One local commit, one concern.** Commit subject: `chore(backend): standardize on psycopg[binary], drop asyncpg`. Only the files listed under Goal change.
- **No new dependency.** `psycopg[binary]==3.2.13` is already pinned; we're *removing* `asyncpg`, not swapping it. If this prompt finds it needs to add anything else to `requirements.txt`, stop and surface.
- **Do not edit any file under `plans/`, `prompts/`, `docs/decisions/`, or `reports/`.** Those are historical records. If `plans/initial-scaffold-2026-04-19.md` mentions `+asyncpg` stripping, that's fine — it's documenting what we did at the time, not prescribing future behavior.
- **Do not rewrite the initial scaffold prompt** (`prompts/2026-04-19-0840-initial-scaffold.md`) even though it contains the old default URL. It's the record of what was run, not a spec we're trying to track.
- **Do not edit `CLAUDE.md`.** The stack table in §2 names "Postgres" as the engine without specifying the driver, so no correction is needed there. ADR 0001 is where driver choice lives; if you need to amend it, do it in a separate prompt.
- **Do not run `alembic upgrade head` or `alembic revision` in this prompt.** No schema changes here. The driver flip is pure config/requirements — migrations arrive in Priority #3.
- **Stage files by name** — no `git add -A` / `git add .`. List files explicitly.
- **Zero AI attribution** in the commit message. Arvin's voice.
- **Never skip git hooks** (`--no-verify`). If pre-commit fails, fix the underlying issue and create a new commit.
- **gh account switch** before any push: `gh auth status | grep -q 'abedubas-alchemydev' || gh auth switch --user abedubas-alchemydev --hostname github.com`.
- **VPS ops respect co-tenants.** `docker compose up --build -d backend` only — don't touch `postgres` or `frontend`. No `docker compose down`, no `--volumes`.
- **Don't clobber the VPS `.env`.** Only `DATABASE_URL` flips; everything else (POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB, BACKEND_CORS_ORIGINS, FRONTEND_HOST_PORT, etc.) stays. Preserve `chmod 0600`.

## Commands to run

### 0. Plan first (ECC)

Inline reasoning is fine. Confirm the edit surface below matches what's actually in the repo before editing.

### 1. Local edits

From the repo root on Arvin's local machine. Edit these seven files:

**`backend/requirements.txt`** — delete the `asyncpg>=0.30.0` line. Leave `psycopg[binary]==3.2.13` exactly as-is. Resulting file has no asyncpg reference.

**`backend/app/core/config.py`** — change the default on line 25:

```diff
-    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/email_extractor"
+    database_url: str = "postgresql+psycopg://postgres:postgres@localhost:5432/email_extractor"
```

**`backend/alembic/env.py`** — simplify. psycopg serves sync and async from the same URL, so no stripping is needed. Replace lines 13–18:

```diff
-# DATABASE_URL is the async URL used by the app (postgresql+asyncpg://...).
-# Alembic runs sync migrations, so strip the +asyncpg driver suffix here.
-sync_url = settings.database_url
-if "+asyncpg" in sync_url:
-    sync_url = sync_url.replace("+asyncpg", "")
-config.set_main_option("sqlalchemy.url", sync_url)
+# We standardize on psycopg[binary] (v3), which supports both sync and async
+# from the same postgresql+psycopg:// URL. Alembic uses the sync engine here;
+# the app uses the async engine in app/db/session.py — same DSN, no rewriting.
+config.set_main_option("sqlalchemy.url", settings.database_url)
```

**`backend/alembic.ini`** — update the comment on line 64:

```diff
-; URL is set by alembic/env.py from DATABASE_URL (with +asyncpg stripped for sync migrations).
+; URL is set by alembic/env.py from DATABASE_URL (postgresql+psycopg:// serves sync + async from one DSN).
```

**`backend/app/main.py`** — update the selector-loop comment on line 16:

```diff
-# Windows requires the selector loop policy for psycopg/asyncpg under uvicorn.
+# Windows requires the selector loop policy for psycopg under uvicorn.
```

**`docker-compose.yml`** — flip the backend service DSN:

```diff
-      DATABASE_URL: postgresql+asyncpg://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}@postgres:5432/${POSTGRES_DB:-email_extractor}
+      DATABASE_URL: postgresql+psycopg://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}@postgres:5432/${POSTGRES_DB:-email_extractor}
```

**`.env.example`** (root) — update the comment and DSN on lines 14–15:

```diff
-# Async URL used by SQLAlchemy. Sync URL (no +asyncpg) is derived for Alembic.
-DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5432/email_extractor
+# Runtime DSN used by both SQLAlchemy's async engine AND Alembic's sync engine.
+# psycopg[binary] (v3) serves both modes from the same postgresql+psycopg:// URL.
+DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5432/email_extractor
```

**`backend/.env.example`** — update the commented example on line 13:

```diff
-# DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5432/email_extractor
+# DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5432/email_extractor
```

### 2. Confirm no asyncpg references remain in source

```bash
# Should return zero hits in source (venv/node_modules/plans/prompts excluded):
grep -rn "asyncpg\|postgresql+asyncpg" \
  --include="*.py" --include="*.yml" --include="*.ini" \
  --include="*.example" --include="*.env" \
  --exclude-dir=.venv --exclude-dir=node_modules --exclude-dir=.next \
  --exclude-dir=plans --exclude-dir=prompts . || echo "clean"
```

If this command prints any matches outside `plans/`, `prompts/`, and `backend/.venv/`, stop and fix whatever it found before continuing.

### 3. Refresh local venv (optional sanity — skip if Python not installed locally)

If `python` / `uv` is available locally:

```bash
cd backend
uv pip install --force-reinstall -r requirements.txt -r requirements-dev.txt 2>/dev/null || \
  pip install --force-reinstall -r requirements.txt -r requirements-dev.txt
python -c "import psycopg; print('psycopg', psycopg.__version__)"
python -c "import asyncpg" 2>&1 | grep -q "ModuleNotFoundError" && echo "asyncpg correctly absent" || { echo "asyncpg still importable — requirements out of sync"; exit 1; }
cd ..
```

If Python isn't installed locally (Docker-only dev), skip this step — the VPS rebuild in Step 5 validates the install.

### 4. Commit and push

```bash
git status
git diff backend/requirements.txt backend/app/core/config.py backend/alembic/env.py \
        backend/alembic.ini backend/app/main.py docker-compose.yml \
        .env.example backend/.env.example

gh auth status | grep -q 'abedubas-alchemydev' || gh auth switch --user abedubas-alchemydev --hostname github.com

git add backend/requirements.txt backend/app/core/config.py backend/alembic/env.py \
        backend/alembic.ini backend/app/main.py docker-compose.yml \
        .env.example backend/.env.example

git commit -m "chore(backend): standardize on psycopg[binary], drop asyncpg"
git log -1 --pretty=full                        # verify no AI trailer

git push origin HEAD
```

### 5. VPS — flip DSN, pull, rebuild backend only

Flip `DATABASE_URL` in the VPS's root `.env`. Sed-replace the scheme only; preserve the rest:

```bash
ssh deploy@76.13.22.110 'cd ~/apps/email-extractor && \
  grep -q "^DATABASE_URL=" .env && \
  sed -i "s|^DATABASE_URL=postgresql+asyncpg://|DATABASE_URL=postgresql+psycopg://|" .env && \
  grep "^DATABASE_URL=" .env'
```

Confirm `.env` is still `chmod 0600`:

```bash
ssh deploy@76.13.22.110 'stat -c "%a %n" ~/apps/email-extractor/.env'    # expect 600
```

Pull the new code:

```bash
ssh deploy@76.13.22.110 'cd ~/apps/email-extractor && git pull --ff-only && git log -1 --oneline'
```

Rebuild backend only:

```bash
ssh deploy@76.13.22.110 'cd ~/apps/email-extractor && docker compose up --build -d backend'
sleep 12
ssh deploy@76.13.22.110 'cd ~/apps/email-extractor && docker compose ps && docker compose logs --tail=80 backend'
```

Confirm no asyncpg in the backend image:

```bash
ssh deploy@76.13.22.110 'docker exec email-extractor-backend python -c "import asyncpg" 2>&1 | grep -q ModuleNotFoundError && echo "asyncpg absent — good" || echo "asyncpg present — investigate"'
ssh deploy@76.13.22.110 'docker exec email-extractor-backend python -c "import psycopg; print(psycopg.__version__)"'
```

### 6. Verify

From Arvin's local machine:

```bash
curl -fsS http://76.13.22.110:8000/health | grep -q '"status":"ok"'
curl -fsS http://76.13.22.110:8000/api/v1/health | grep -q '"status":"ok"'
curl -fsS -o /dev/null -w '%{http_code}\n' http://76.13.22.110:3010    # frontend unchanged — must still be 200
```

All three must pass.

## Acceptance criteria

- `backend/requirements.txt` contains `psycopg[binary]==3.2.13` and zero references to `asyncpg`.
- `backend/app/core/config.py` default `database_url` starts with `postgresql+psycopg://`.
- `backend/alembic/env.py` has no `replace("+asyncpg", "")` call and the block's comment reflects the psycopg-serves-both reality.
- `docker-compose.yml`, `.env.example`, `backend/.env.example` all reference `postgresql+psycopg://` exclusively.
- `grep -rn "asyncpg" . --exclude-dir=.venv --exclude-dir=node_modules --exclude-dir=plans --exclude-dir=prompts --exclude-dir=.next` returns zero hits.
- `git show --stat HEAD` lists exactly these eight files: `backend/requirements.txt`, `backend/app/core/config.py`, `backend/alembic/env.py`, `backend/alembic.ini`, `backend/app/main.py`, `docker-compose.yml`, `.env.example`, `backend/.env.example`. One commit, subject `chore(backend): standardize on psycopg[binary], drop asyncpg`, zero AI attribution, Arvin as author.
- VPS `docker exec email-extractor-backend python -c "import asyncpg"` raises `ModuleNotFoundError`.
- VPS `docker exec email-extractor-backend python -c "import psycopg; print(psycopg.__version__)"` prints `3.2.13` (or a newer patch if psycopg has bumped, but major.minor must be `3.2`).
- `curl http://76.13.22.110:8000/health` returns `{"status":"ok"}`.
- `curl http://76.13.22.110:8000/api/v1/health` returns `{"status":"ok"}`.
- Frontend untouched: `curl -o /dev/null -w '%{http_code}\n' http://76.13.22.110:3010` returns `200`.
- VPS `.env` still `chmod 0600`; only `DATABASE_URL` scheme changed; all other keys preserved.
- No new firewall rules, no sshd edits, no changes to other tenants' containers.

## Subagent roles

None.

## Out of scope

- Writing the first real model (`ExtractionRun`, `DiscoveredEmail`, `EmailVerification`) — Priority #3, separate prompt.
- Running `alembic revision --autogenerate` — there are no models yet; nothing to autogenerate. The first revision belongs in #3.
- Adding connection pooling tuning (`psycopg[binary,pool]`, `pool_size`, `max_overflow`) — defer until we have real load patterns.
- Amending ADR 0001. The ADR already says "one driver, matching parent" — this prompt is the implementation of that choice, not a new decision.
- TLS, reboot coordination, other tenant work — same deferrals as prior prompts.

---

## Outcome

**Status:** done
**Completed:** 2026-04-19T11:18:00+08:00
**Branch:** main
**Commits:**
- `2bf5ffa` chore(backend): standardize on psycopg[binary], drop asyncpg

### Summary
Removed `asyncpg>=0.30.0` from `backend/requirements.txt` and flipped every `postgresql+asyncpg://` reference in source/config to `postgresql+psycopg://` across 8 files. `backend/alembic/env.py` no longer rewrites the URL — psycopg v3 serves both the async runtime and Alembic's sync migrations from one DSN, matching `fis-lead-gen`'s parent pattern. On the VPS: flipped `DATABASE_URL` scheme in-place via sed, pulled, rebuilt only the `backend` service. All three containers healthy; `asyncpg` is now `ModuleNotFoundError` inside the backend container; `psycopg.__version__` is `3.2.13`. Backend `/health` + `/api/v1/health` and frontend `:3010` all green.

### Acceptance criteria

- [x] `backend/requirements.txt` contains `psycopg[binary]==3.2.13` and zero `asyncpg` references — verified by `grep -c asyncpg backend/requirements.txt` -> 0.
- [x] `backend/app/core/config.py` default `database_url` starts with `postgresql+psycopg://` — verified by `git diff`.
- [x] `backend/alembic/env.py` has no `replace("+asyncpg", "")` and the comment reflects psycopg-serves-both — verified by inspection (5 lines removed, 3 lines added in the URL-config block).
- [x] `docker-compose.yml`, `.env.example`, `backend/.env.example` reference `postgresql+psycopg://` exclusively — verified.
- [x] `grep -rn "asyncpg" .` (excluding `.venv`, `node_modules`, `plans`, `prompts`, `.next`) returns zero hits in source. CLAUDE.md §10 has 2 stale references — see Followups (prompt forbids editing CLAUDE.md).
- [x] `git show --stat HEAD` lists exactly the 8 specified files — verified: `+12/-14`, no unrelated files.
- [x] One commit, subject `chore(backend): standardize on psycopg[binary], drop asyncpg`, zero AI attribution, Arvin as author — verified by `git log -1 --pretty=full`.
- [x] VPS `docker exec email-extractor-backend python -c "import asyncpg"` raises `ModuleNotFoundError` — verified.
- [x] VPS `docker exec email-extractor-backend python -c "import psycopg; print(psycopg.__version__)"` prints `3.2.13` — verified.
- [x] `curl http://76.13.22.110:8000/health` -> `{"status":"ok"}` — verified.
- [x] `curl http://76.13.22.110:8000/api/v1/health` -> `{"status":"ok"}` — verified.
- [x] Frontend untouched — `curl http://76.13.22.110:3010` -> `200`; container `Up 10 minutes` (no recreate touched it).
- [x] VPS `.env` still `chmod 0600`; only `DATABASE_URL` scheme changed (`+asyncpg://` -> `+psycopg://`); all other keys preserved.
- [x] No new firewall rules, no sshd edits, no co-tenant changes — verified.

### Files touched

**Local repo (committed, commit `2bf5ffa`, +12/-14):**
- `backend/requirements.txt` (-1) — removed `asyncpg>=0.30.0`.
- `backend/app/core/config.py` (+1/-1) — DSN default scheme.
- `backend/alembic/env.py` (+3/-5) — removed URL preprocessing block, replaced with one-line config.set_main_option + new comment.
- `backend/alembic.ini` (+1/-1) — comment text only (line 64).
- `backend/app/main.py` (+1/-1) — selector-loop comment dropped `/asyncpg`.
- `docker-compose.yml` (+1/-1) — backend service `DATABASE_URL` env-var DSN scheme.
- `.env.example` (+3/-2) — root template DSN + comment.
- `backend/.env.example` (+1/-1) — commented-out DSN example.

**Local venv (not in git):**
- `backend/.venv/` — `asyncpg==0.31.0` uninstalled; reinstall of requirements left psycopg in place.

**VPS (`76.13.22.110`) — not in git:**
- `~/apps/email-extractor/.env` — `DATABASE_URL` scheme flipped from `+asyncpg` to `+psycopg`; all other keys unchanged.
- Backend container image rebuilt from new requirements; runtime image no longer ships asyncpg.

### Verification

```
# Local edits
$ git diff --stat (8 files): +12/-14

# Source sweep
$ grep -rn "asyncpg" --include='*.py' --include='*.yml' --include='*.ini' --include='*.example' \
    --exclude-dir=.venv --exclude-dir=plans --exclude-dir=prompts .
(zero hits in source)
# CLAUDE.md §10 has 2 stale refs (lines 284, 289) — flagged in Followups.

# Local venv check
$ uv pip install --reinstall ...
$ uv pip uninstall asyncpg
Uninstalled 1 package: asyncpg==0.31.0
$ python -c "import psycopg; print(psycopg.__version__)" -> 3.2.13
$ python -c "import asyncpg" -> ModuleNotFoundError

# Local test/lint suite
$ pytest app/tests/ -v -> 3 passed in 2.04s
$ ruff check . -> All checks passed!
$ ruff format --check . -> 20 files already formatted
$ basedpyright -> 0 errors, 0 warnings, 0 notes (exit 0)

# Push
$ git push origin HEAD -> e48debb..2bf5ffa  HEAD -> main

# VPS .env flip
$ sed -i "s|^DATABASE_URL=postgresql+asyncpg://|DATABASE_URL=postgresql+psycopg://|" .env
$ grep "^DATABASE_URL=" .env
DATABASE_URL=postgresql+psycopg://postgres:postgres@postgres:5432/email_extractor
$ stat -c "%a %n" .env -> 600 .env

# VPS pull
$ git pull --ff-only && git log -1 --oneline
cd496e7..2bf5ffa  main -> origin/main
2bf5ffa chore(backend): standardize on psycopg[binary], drop asyncpg

# VPS backend rebuild
$ docker compose up --build -d backend
Container email-extractor-backend Recreated -> Started
$ docker compose ps
NAME                       SERVICE    STATUS                    PORTS
email-extractor-backend    backend    Up 16 seconds             0.0.0.0:8000->8000/tcp
email-extractor-frontend   frontend   Up 10 minutes             0.0.0.0:3010->3000/tcp
email-extractor-postgres   postgres   Up 38 minutes (healthy)   0.0.0.0:5432->5432/tcp

$ docker exec email-extractor-backend python -c "import asyncpg"
ModuleNotFoundError: No module named 'asyncpg'   (exit 1)
$ docker exec email-extractor-backend python -c "import psycopg; print(psycopg.__version__)"
3.2.13

$ docker compose logs --tail=10 backend
INFO:     Application startup complete.
INFO:     Uvicorn running on http://0.0.0.0:8000

# Off-VPS verification
$ curl http://76.13.22.110:8000/health        -> {"status":"ok"}
$ curl http://76.13.22.110:8000/api/v1/health -> {"status":"ok"}
$ curl -o /dev/null -w '%{http_code}\n' http://76.13.22.110:3010 -> 200
```

### Plan deviations

(a) **Step 3 venv reinstall** required an explicit `uv pip uninstall asyncpg` follow-up. `--reinstall` only reinstalls packages currently listed in `requirements.txt`; it does not prune packages no longer listed. After the uninstall, `import asyncpg` raised `ModuleNotFoundError` as expected. Recorded for future requirements-trimming prompts.

(b) **Backend container was Recreated** (Postgres untouched). Same harmless side-effect as prior prompts where compose rebuilds one service.

### Decisions made on the fly

None. Every step executed verbatim from the prompt's Commands section, with the venv-uninstall added as the only side-quest (deviation a) — and that was an obvious gap in the documented workflow, not a design decision.

### Followups for Cowork

1. **CLAUDE.md §10 has 2 stale `asyncpg` references** (lines 284, 289 in the codebase map). The prompt explicitly forbade editing CLAUDE.md, so they're left in place. A small follow-up prompt should refresh §10 to reflect the new psycopg-only reality. Tiny — it's two line edits, both in the auto-generated codebase map.
2. **Highest priority: domain models + first Alembic revision (`ExtractionRun` etc.).** This prompt's whole purpose was to make that next prompt safe — driver lock-in is now correct. ADR 0001 + parent's `PipelineRun` shape provide the template.
3. **`requirements-dev.txt` did not need changes** (no asyncpg there), but the same principle applies: prune-on-remove. If we remove a pin in the future, do `uv pip uninstall <pkg>` explicitly to keep the venv in sync. Could be folded into a `make refresh-deps` target eventually.
4. **The local `backend/.venv/` is now in a clean state.** Anyone re-running `verify.sh` from a stale venv (with both drivers installed) would have noticed nothing wrong because `psycopg+psycopg://` works regardless. Worth a one-line note in `scripts/verify.sh` (or a separate `scripts/refresh-venv.sh`) telling devs to re-create the venv after dependency changes.
5. **Three uncommitted files in local working tree at end of run**: `plans/vps-staging-approval-2026-04-19.md`, `prompts/2026-04-19-1112-psycopg-driver-alignment.md` (this file). Per "one commit, one concern", they aren't committed by this prompt. Cowork can sweep them in.

### Risks / concerns

- **psycopg sync vs async behavior is not 100% identical to asyncpg under load.** psycopg v3 supports both modes natively, but its async path uses a different connection-pool implementation than asyncpg. We have no load tests to detect a regression. Acceptable for staging; revisit when/if scan throughput becomes a bottleneck.
- **Backend container was rebuilt with no migrations**, so there's no schema-drift risk yet. The first migration (Priority #3) is the real test of the env.py change — make sure that prompt verifies `alembic upgrade head` works against the psycopg URL on the VPS, not just locally.
- **CLAUDE.md §10 stale entries** could mislead a future agent into thinking we still need `+asyncpg` stripping. Mitigated only by the next-prompt sweep (follow-up #1). Until then, anyone reading §10 should ground-truth against `backend/requirements.txt`.
