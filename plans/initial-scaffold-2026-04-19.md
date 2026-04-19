# Plan — Initial scaffold execution

**Prompt:** `prompts/2026-04-19-0840-initial-scaffold.md` (with 2026-04-19 amendments)
**Author:** CC CLI (Claude Code)
**Date:** 2026-04-19

## Pre-flight assumptions verified

| Tool | Required | Found | OK? |
|------|----------|-------|-----|
| Python (system) | any | 3.13.1 | n/a — use uv to provision 3.11 |
| `uv` | for venv | 0.9.30 | yes |
| Node | for Next.js | 22.21.1 | yes (>= 20 required for Next 14) |
| npm | for Next.js | 11.7.0 | yes |
| Docker | for Step 6 | not installed | Step 6 SKIPPED per amendment |
| Parent project | reference | `C:\Users\…\fis-lead-gen` exists with `app/main.py`, `app/core/config.py`, `app/db/session.py`, `alembic/env.py`, `Dockerfile`, etc. | yes |

Conventions already snapshotted from parent (will mirror exactly):
- `main.py` — `WindowsSelectorEventLoopPolicy` shim, async `lifespan` disposing engine, FastAPI app with title/docs/openapi from settings, CORS middleware, root `/health`, mount `api_router` under `settings.api_v1_prefix`.
- `config.py` — `BACKEND_ROOT/PROJECT_ROOT/ROOT_ENV_PATH/BACKEND_ENV_PATH` paths, `load_dotenv(ROOT, override=False)` then `load_dotenv(BACKEND, override=True)`, `Settings(BaseSettings)` with `model_config = SettingsConfigDict(extra="ignore")`, `@computed_field` `cors_origins`, `@lru_cache` `get_settings()`, module-level `settings`.
- `db/session.py` — `engine = create_async_engine(settings.database_url, future=True, pool_pre_ping=True)`, `SessionLocal = async_sessionmaker(...)`, `async def get_db_session()`.
- `db/base.py` — bare `class Base(DeclarativeBase): pass` + model imports below for metadata registration (none yet for us).
- `api/router.py` — single APIRouter that includes `api_v1_router`.
- `alembic/env.py` — strips `+asyncpg` from `database_url` for sync migrations, sets `target_metadata = Base.metadata`, online uses `engine_from_config` with `pool.NullPool`.

## Step-by-step execution

### Step 0 — This plan
Once approved by the user.

### Step 1 — Root-level bootstrap
**Files to create:**
- `README.md` — name, one-paragraph purpose, link to `CLAUDE.md` and ADR 0001, four-command quickstart.
- `.env.example` — `DATABASE_URL`, `BACKEND_CORS_ORIGINS`, `EMAIL_EXTRACTOR_API_KEY`, `HUNTER_API_KEY`, `APOLLO_API_KEY`, `SNOV_API_KEY`. Document that API keys are optional during scaffold.
- `docker-compose.yml` — services: `postgres` (15-alpine, env-driven creds, named volume), `backend` (build context `./backend`, port 8000, depends_on postgres healthcheck, `DATABASE_URL` wired to compose hostname), `frontend` (build context `./frontend`, port 3000, depends_on backend, `NEXT_PUBLIC_API_BASE_URL` set).
- `scripts/__init__.py` — empty.
- `scripts/verify.sh` — exact body from prompt §1.

**Notable decision:** `docker-compose.yml` will use `postgres:15-alpine`, named volume `pg_data`, and a healthcheck on the postgres service so backend `depends_on: postgres: condition: service_healthy`. Cloud Run-compat (single-port, $PORT-aware) is preserved on backend.

### Step 2 — Backend scaffold

Create directory tree:

```
backend/
  Dockerfile
  pyproject.toml          # Ruff + basedpyright config only
  pytest.ini
  requirements.txt
  requirements-dev.txt
  .env.example
  app/
    __init__.py
    main.py
    core/
      __init__.py
      config.py
      security.py
    db/
      __init__.py
      base.py
      session.py
    api/
      __init__.py
      router.py
      v1/
        __init__.py
        api.py
        endpoints/
          __init__.py
          health.py
    schemas/__init__.py
    models/__init__.py
    services/__init__.py
    tests/
      __init__.py
      test_main.py
```

**File-by-file content (mirroring parent where called for):**
- `requirements.txt` — exact pin list from prompt §2.
- `requirements-dev.txt` — exact pin list from prompt §2.
- `pyproject.toml`:

  ```toml
  [tool.ruff]
  line-length = 120
  target-version = "py311"

  [tool.ruff.lint]
  select = ["E", "F", "I", "UP", "B", "SIM", "ASYNC"]

  [tool.basedpyright]
  pythonVersion = "3.11"
  include = ["app"]
  reportMissingImports = "error"
  reportMissingTypeStubs = "none"
  reportUnknownMemberType = "none"
  reportUnknownVariableType = "none"
  reportUnknownArgumentType = "none"
  reportUnknownParameterType = "none"
  reportAny = "none"
  reportImplicitOverride = "none"
  reportCallInDefaultInitializer = "none"
  ```

  Reason for the `reportUnknown*` and `reportAny` muting: basedpyright's strict default flags pydantic's `BaseSettings`/`AsyncSession`/FastAPI return-type inference as unknowns, generating noise that's not load-bearing on a scaffold. Same posture as `fis-lead-gen` keeps in practice.
- `pytest.ini` — exact body from prompt §2 (matches parent verbatim).
- `.env.example` — commented template per prompt.
- `Dockerfile` — `python:3.11-slim`, copy/install/copy app, `CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]`. **Differs from parent**: parent runs `alembic upgrade head &&` first and uses `--workers 2`; we drop both because (a) no migrations exist yet and (b) `--workers 2` doesn't honor `$PORT` cleanly with `sh -c`. Reason logged in Decisions section of Outcome.
- `app/main.py` — copy parent skeleton verbatim, change `app_name` source via settings, no other behavioral changes.
- `app/core/config.py` — copy parent's `BACKEND_ROOT/PROJECT_ROOT/...` env-loading skeleton, then a slimmed `Settings` class with **only** the fields specified in the prompt: `app_name`, `api_v1_prefix`, `database_url`, `backend_cors_origins`, `email_extractor_api_key`, `hunter_api_key`, `apollo_api_key`, `snov_api_key`, plus `cors_origins` computed_field.
- `app/core/security.py` — `require_access` Depends as specified.
- `app/db/base.py` — bare `class Base(DeclarativeBase): pass`. No model imports yet.
- `app/db/session.py` — async engine + `SessionLocal` + `get_db_session()`. Same shape as parent.
- `app/api/router.py` — same shape as parent (1 line change: nothing).
- `app/api/v1/api.py` — only includes `health.router`.
- `app/api/v1/endpoints/health.py` — `@router.get("/health")` returns `{"status": "ok"}`.
- `app/tests/test_main.py` — three tests:
  1. `test_root_health_returns_ok` — `httpx.AsyncClient` (via `httpx.ASGITransport(app=app)`) hits `/health`.
  2. `test_v1_health_returns_ok` — same for `/api/v1/health`.
  3. `test_respx_mocks_external_call` — minimal `respx.mock` test that mocks an arbitrary URL and asserts the `httpx.AsyncClient` returns the mocked body. Purpose: satisfy the acceptance criterion `grep -r respx backend/app/tests/` AND establish the pattern for future provider tests. Otherwise respx is in `requirements-dev.txt` but never exercised, which would rot.

### Step 3 — Alembic init

```bash
cd backend
uv run alembic init -t async alembic
```

Then:
- `backend/alembic.ini` — change `script_location = alembic`, leave `sqlalchemy.url` empty.
- `backend/alembic/env.py` — replace generated body with the parent's pattern (strip `+asyncpg`, import `Base` from `app.db.base`, `target_metadata = Base.metadata`, sync online migrations via `engine_from_config` + `pool.NullPool`).
- No initial revision (no models yet).

### Step 4 — uv venv + install + tests (Amended)

```bash
cd backend
uv venv --python 3.11 .venv
uv pip install -r requirements-dev.txt
.venv/Scripts/python.exe -m pytest app/tests/ -v
```

Verify `.venv/Scripts/python.exe --version` reports 3.11.x before installing.

**Tests must pass before commit 3.**

### Step 5 — Frontend scaffold

```bash
cd "<repo root>"
npx --yes create-next-app@14 frontend \
  --typescript --tailwind --eslint --app \
  --no-src-dir --import-alias "@/*" --use-npm
```

**Deviation from prompt:** the prompt has `--src-dir=false` and `--no-turbopack`. In `create-next-app@14`:
- `--src-dir=false` is invalid syntax → use `--no-src-dir`.
- `--no-turbopack` does not exist (turbopack is opt-in via `--turbo` in v14, off by default) → omit.

After creation:
- Edit `frontend/app/page.tsx` → minimal placeholder.
- Create `frontend/lib/api.ts` and `frontend/lib/types.ts`.
- `cd frontend && npm install lucide-react`.
- Create `frontend/Dockerfile` (multi-stage, mirrors parent's pattern but simplified — drop `RESEND_API_KEY`).
- Create `frontend/.env.example`.
- Set `output: "standalone"` in `frontend/next.config.mjs` (or whichever config file create-next-app generates).
- `npm run lint && npm run build` must pass.

### Step 6 — SKIPPED per amendment
Files written (Dockerfiles, compose) but no `docker-compose up`. Will write follow-up prompt `prompts/2026-04-19-0845-docker-stack-setup.md` after main work lands.

### Step 7 — CI workflow
`.github/workflows/ci.yml` with two jobs:
- `backend`: `setup-python@v5` 3.11, `pip install -r backend/requirements-dev.txt`, then `cd backend && ruff check . && ruff format --check . && basedpyright && pytest app/tests/`.
- `frontend`: `setup-node@v4` 20, `cd frontend && npm ci && npm run lint && npm run build`.

### Step 8 — `/init` for Section 10 only

**Risk:** the built-in `/init` skill rewrites the *entire* `CLAUDE.md`. Sections 1–9 contain hand-authored intent and the acceptance criterion mandates byte-identical preservation.

**Mitigation strategy:** snapshot SHA-256 of CLAUDE.md sections 1–9 first. Then attempt the `/init`-equivalent task. Plan A: invoke `/init` with the constraint quoted from prompt §8. If the resulting file's sections 1–9 are not byte-identical, fall back to Plan B: I manually generate Section 10 (a real codebase map of the new files) and `Edit`-replace only the `## 10. Codebase map` block in CLAUDE.md. Verify byte-identity of sections 1–9 either way before committing.

I will lean toward **Plan B from the start** (manual section-10 update) because it cannot violate the constraint by construction. The prompt's literal language is "Run `/init`" but the binding constraint is "sections 1–9 must be byte-identical" — and the prompt itself acknowledges `/init` may need to be cancelled. Manual Section 10 generation satisfies the binding constraint with zero risk; will document as Decision in Outcome.

### Step 9 — `./scripts/verify.sh`
Run from repo root. Must exit 0. Note: the script requires bash; on Windows it runs under git-bash/WSL — already available in this shell.

## Commit plan

The commit plan in the prompt has 7 commits, but the repo currently has **zero commits** and several untracked tracked-worthy files (`.gitignore`, `CLAUDE.md`, `docs/decisions/0001-initial-stack.md`, plus existing `prompts/`, `plans/`, `reports/` content). I will add a **commit 0** to baseline these — the prompt's acceptance criterion says "approximately 7 commits", so 1 baseline + 7 planned = 8 is within the "approximately" envelope. Will document.

| # | Subject (zero AI attribution) | Files |
|---|-------------------------------|-------|
| 0 | `chore: baseline workspace docs and gitignore` | `.gitignore`, `CLAUDE.md`, `docs/decisions/0001-initial-stack.md`, `prompts/2026-04-19-0840-initial-scaffold.md`, `plans/initial-scaffold-2026-04-19.md`, `prompts/.gitkeep` etc. |
| 1 | `chore: add docker-compose, root .env.example, verify script` | `docker-compose.yml`, `.env.example`, `scripts/__init__.py`, `scripts/verify.sh` |
| 2 | `feat(backend): scaffold FastAPI app, health endpoint, async SQLAlchemy base, config` | `backend/app/__init__.py`, `backend/app/main.py`, `backend/app/core/`, `backend/app/db/`, `backend/app/api/`, `backend/app/schemas/__init__.py`, `backend/app/models/__init__.py`, `backend/app/services/__init__.py`, `backend/Dockerfile`, `backend/.env.example`, `backend/requirements.txt` |
| 3 | `chore(backend): add ruff + basedpyright config, pytest setup, initial hello-world tests` | `backend/pyproject.toml`, `backend/pytest.ini`, `backend/requirements-dev.txt`, `backend/app/tests/__init__.py`, `backend/app/tests/test_main.py` |
| 4 | `chore(backend): initialize Alembic with async template` | `backend/alembic.ini`, `backend/alembic/env.py`, `backend/alembic/script.py.mako`, `backend/alembic/versions/.gitkeep` |
| 5 | `feat(frontend): scaffold Next.js 14 App Router with Tailwind + Lucide` | `frontend/**` (entire generated tree minus `node_modules`, `.next`; lockfile is included) plus `frontend/lib/api.ts`, `frontend/lib/types.ts`, `frontend/Dockerfile`, `frontend/.env.example` |
| 6 | `chore: add CI workflow for ruff/basedpyright/pytest + next lint/build` | `.github/workflows/ci.yml` |
| 7 | `docs: populate CLAUDE.md section 10 codebase map` | `CLAUDE.md` (only section 10 changes) |

All commits via explicit `git add <path1> <path2>` — no `git add -A`. Author: existing git config (Arvin B. Edubas). No `--no-verify`. No AI attribution trailers. Commit messages are imperative, ≤72 chars subject, no body unless needed.

## Risks called out

1. **`/init` clobber risk** — addressed via Plan B (manual Section 10) above.
2. **basedpyright noise** — pydantic + SQLAlchemy 2.0 type inference is gnarly under strict mode. Config above mutes the worst categories. If basedpyright still fails on the scaffold, I'll add narrower `# pyright: ignore[...]` comments rather than relax the rule set globally.
3. **Ruff `ASYNC` rule false-positives on FastAPI handlers** — `ASYNC110/210` may flag the `httpx.AsyncClient` test patterns. If so, I'll add per-line ignores; not relax the global selection.
4. **`create-next-app@14` flag drift** — covered with `--no-src-dir` substitution and `--no-turbopack` removal.
5. **`docker-compose.yml` cannot be lint-validated** without Docker installed. Will hand-author with a YAML-valid structure and rely on the follow-up prompt to actually `docker compose config` / `up`.
6. **Test `httpx.ASGITransport`** — confirmed available in httpx 0.28; if any version/pin issue surfaces, fall back to `fastapi.testclient.TestClient` (sync) like the parent does in its `test_main.py`.
7. **Network** — `npx create-next-app@14`, `npm install`, and `uv pip install` all require outbound network. If offline, the entire run blocks at Step 4 / Step 5.

## Out of scope
Same as prompt: no business logic, no providers, no `DiscoveredEmail`, no GCP deploy, no `/email-extractor` route, no first migration.

## Approval gate
Awaiting user confirmation before executing Step 1.
