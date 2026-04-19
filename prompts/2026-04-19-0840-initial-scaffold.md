---
slug: initial-scaffold
created: 2026-04-19 08:40
ecc_command: /plan
subagents: []
related_adrs:
  - docs/decisions/0001-initial-stack.md
---

# Initial scaffold — FastAPI backend + Next.js 14 frontend + Docker Compose

> **Amendments (2026-04-19, post-authoring):**
>
> Two environment blockers were identified before this prompt was executed. This prompt has been amended in-place rather than superseded, so follow the amended steps:
>
> 1. **Python 3.11 via `uv`.** The target machine has Python 3.13.1 installed at the system level; ADR 0001 pins us to 3.11 to match `fis-lead-gen`. Step 4 below now uses `uv` to provision a 3.11 virtual environment instead of `python -m venv`. If `uv` is not installed, install it first: on Windows, `powershell -c "irm https://astral.sh/uv/install.ps1 | iex"`; on macOS/Linux, `curl -LsSf https://astral.sh/uv/install.sh | sh`. Then `uv python install 3.11`. Fallback (no uv): `py -3.11 -m venv .venv` on Windows or `python3.11 -m venv .venv` on Unix — whichever resolves to a real 3.11 interpreter.
> 2. **Docker Compose integration test is deferred.** Docker is not installed on the target machine yet, and installing Docker is a concern separate from scaffolding. Step 6 is marked `[SKIPPED]` below. The Dockerfiles and `docker-compose.yml` are still authored as files during Step 1–2, but the `docker-compose up --build -d` acceptance criterion is deferred to a dedicated follow-up prompt: `prompts/2026-04-19-0845-docker-stack-setup.md`. That prompt must be run only after a container runtime is installed on the target machine; it is the one that actually satisfies the compose-up acceptance bullet.
>
> Everything else — commit plan, zero AI attribution, `/init` constraints for §10-only, the byte-identical CLAUDE.md sections 1–9 rule — remains unchanged.

## Goal

Create a working, green-from-first-commit project scaffold that mirrors `fis-lead-gen`'s backend and frontend conventions, with: installable dependencies, a passing pytest hello-world, a buildable Next.js app, a functional `docker-compose up` that serves `/health` on `:8000` and the Next.js landing on `:3000`, and a `CLAUDE.md` section 10 (Codebase Map) populated by `/init`.

After this prompt, a second prompt (to be written next) will scaffold the actual email-extractor services, models, and endpoints. **This prompt is scaffolding-only — no business logic yet.**

## Context

- Architecture, stack choices, conventions, and the eventual merge path into `fis-lead-gen` are fully documented in `CLAUDE.md` and `docs/decisions/0001-initial-stack.md`. Read both before planning.
- Sections 1–9 of `CLAUDE.md` contain human intent authored during Phase 1–3 of the kickoff. They **must not** be modified by this prompt. Section 10 is a placeholder for `/init` to populate and is the only section this prompt may write to.
- Parent project (`fis-lead-gen`) conventions to mirror:
  - Python 3.11, FastAPI ≥ 0.135, SQLAlchemy 2.0 async with `Mapped[]`, Alembic, Pydantic v2 + pydantic-settings, httpx, psycopg[binary] 3.2.
  - `from __future__ import annotations` at the top of every module.
  - Backend layout: `api/router.py` mounts `api/v1/api.py` under `/api/v1`; thin endpoints under `api/v1/endpoints/`; business logic in `services/`; SQLAlchemy models in `models/`; Pydantic DTOs in `schemas/`; settings in `core/config.py`.
  - Next.js 14 App Router + Tailwind + Lucide + TypeScript.
  - pip + `requirements.txt` / `requirements-dev.txt` for Python deps.
  - pytest + pytest-asyncio + respx, `asyncio_mode = auto` in `pytest.ini`.
- Commit style: **zero AI attribution.** No `Co-Authored-By`, no `Generated with…`, no references to AI / Claude / Anthropic / assistant / LLM in commit messages or PRs. See `CLAUDE.md` §6.

## Constraints

- **Do NOT modify `CLAUDE.md` sections 1–9.** Only section 10 may be written to, and only by `/init` as the last step. If `/init` attempts to rewrite the whole file, cancel and re-run with the constraint embedded in the command below.
- **Do NOT modify `docs/decisions/0001-initial-stack.md`** or any existing file in `prompts/`, `plans/`, `reports/`, `docs/`.
- **No business logic.** No Hunter/Apollo/Snov providers, no site crawler, no aggregator, no `DiscoveredEmail` model, no email-extractor endpoints beyond a health check. Scaffolding only.
- **Stage files by name.** Never `git add -A` / `git add .`. The repo root contains Cowork and workflow artifacts that must not be swept into commits.
- **Never skip git hooks** (`--no-verify`) or bypass signing. If pre-commit fails, fix the underlying issue and create a *new* commit.
- **Commit in small, logical chunks** — one concern per commit. See "Commit plan" below.
- **Docker files must be Cloud Run-compatible**: CMD honors `$PORT` for the backend; Next.js uses `output: 'standalone'` for minimal images.
- **Match parent's env-loading precedence**: root `.env` first, then `backend/.env` (wins). Do not consolidate into a single `.env`.

## Commands to run

Run each block in order. Do not skip. Values in angle brackets are placeholders to fill in with sensible defaults.

### 0. Plan first (ECC)

Use `/plan` to lay out the execution steps before writing any code. Confirm the plan against the Commit plan below. Then proceed.

### 1. Root-level bootstrap

Create these root-level files (they do not yet exist):

- `README.md` — brief: project name, one-paragraph purpose, link to `CLAUDE.md`, link to `docs/decisions/0001-initial-stack.md`, the four-command quickstart (`docker-compose up --build` / `cd backend && pytest` / `cd frontend && npm run dev` / `python -m scripts.run_email_extraction --domain example.com`).
- `.env.example` — documented env vars for both backend and frontend. At minimum: `DATABASE_URL`, `BACKEND_CORS_ORIGINS`, `EMAIL_EXTRACTOR_API_KEY`, `HUNTER_API_KEY`, `APOLLO_API_KEY`, `SNOV_API_KEY` (all optional for standalone; document that the API-key ones can be blank during scaffold phase).
- `docker-compose.yml` — services: `postgres` (15-alpine), `backend` (builds `./backend/Dockerfile`, port 8000, depends_on postgres), `frontend` (builds `./frontend/Dockerfile`, port 3000, depends_on backend). Postgres credentials via env vars with sensible defaults.
- `scripts/__init__.py` (empty) and `scripts/verify.sh` — one script that runs the full green-check pipeline:
  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  cd "$(dirname "$0")/.."
  (cd backend && ruff check . && ruff format --check . && basedpyright && pytest app/tests/ -v)
  (cd frontend && npm run lint && npm run build)
  ```

### 2. Backend scaffold (`backend/`)

```bash
mkdir -p backend/app/{api/v1/endpoints,core,db,models,schemas,services,tests}
cd backend
```

Write these files:

- `backend/requirements.txt` — pin versions matching fis-lead-gen:
  ```
  alembic==1.14.1
  email-validator==2.2.0
  fastapi>=0.135.0
  greenlet==3.2.4
  httpx==0.28.1
  pydantic-settings==2.7.0
  psycopg[binary]==3.2.13
  python-dotenv==1.0.1
  SQLAlchemy==2.0.45
  uvicorn[standard]>=0.32.1
  selectolax>=0.3.21
  ```
- `backend/requirements-dev.txt`:
  ```
  -r requirements.txt
  pytest>=8.3.0
  pytest-asyncio>=0.24.0
  respx>=0.21.1
  ruff>=0.7.0
  basedpyright>=1.20.0
  ```
- `backend/pyproject.toml` — Ruff + basedpyright config only (no build system; pip + requirements.txt is canonical).
  - Ruff: line-length 120, target-version `py311`, select a sensible rule set (`E`, `F`, `I`, `UP`, `B`, `SIM`, `ASYNC`).
  - basedpyright: `pythonVersion = "3.11"`, `include = ["app"]`, strict enough to catch real issues but not pedantic.
- `backend/pytest.ini`:
  ```ini
  [pytest]
  testpaths = app/tests
  pythonpath = .
  asyncio_mode = auto
  filterwarnings =
      ignore::DeprecationWarning
  ```
- `backend/.env.example` — commented template for `DATABASE_URL`, `BACKEND_CORS_ORIGINS`, `EMAIL_EXTRACTOR_API_KEY`, `HUNTER_API_KEY`, `APOLLO_API_KEY`, `SNOV_API_KEY`.
- `backend/Dockerfile` — Python 3.11-slim, install deps, copy app, `CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]`.
- `backend/app/__init__.py` (empty).
- `backend/app/main.py` — match `fis-lead-gen`'s skeleton:
  - `from __future__ import annotations`
  - Async `lifespan` context manager that disposes the SQLAlchemy engine on shutdown.
  - Windows `WindowsSelectorEventLoopPolicy` shim.
  - `app = FastAPI(title=settings.app_name, docs_url=f"{settings.api_v1_prefix}/docs", openapi_url=f"{settings.api_v1_prefix}/openapi.json", lifespan=lifespan)`.
  - CORS middleware from `settings.cors_origins`.
  - `@app.get("/health", tags=["system"])` returns `{"status": "ok"}`.
  - `app.include_router(api_router, prefix=settings.api_v1_prefix)`.
- `backend/app/core/__init__.py` (empty), `backend/app/core/config.py` — `Settings(BaseSettings)` with:
  - `app_name: str = "Email Extractor API"`
  - `api_v1_prefix: str = "/api/v1"`
  - `database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/email_extractor"`
  - `backend_cors_origins: str = "http://localhost:3000"` with a `cors_origins` computed field that splits on comma.
  - API-key fields for Hunter/Apollo/Snov (optional `str | None = None`).
  - `email_extractor_api_key: str | None = None` for the standalone Bearer dependency.
  - Load root `.env` then `backend/.env` (backend wins) using `python-dotenv`, same pattern as fis-lead-gen.
- `backend/app/core/security.py` — a single `require_access` FastAPI dependency that:
  - If `settings.email_extractor_api_key` is unset, allows the request (dev mode).
  - Otherwise requires `Authorization: Bearer <key>` matching `settings.email_extractor_api_key`; raises 401 on mismatch.
  - Comment: `# On merge into fis-lead-gen, replace this body with a call into services/auth.py and swap Depends(...) target.`
- `backend/app/db/__init__.py` (empty), `backend/app/db/base.py` — SQLAlchemy 2.0 `DeclarativeBase`:
  ```python
  from __future__ import annotations
  from sqlalchemy.orm import DeclarativeBase
  class Base(DeclarativeBase):
      pass
  ```
- `backend/app/db/session.py` — async engine + `SessionLocal` async_sessionmaker + `get_db` dependency that yields a session.
- `backend/app/api/__init__.py` (empty), `backend/app/api/router.py` — `api_router = APIRouter(); api_router.include_router(api_v1_router)`.
- `backend/app/api/v1/__init__.py` (empty), `backend/app/api/v1/api.py` — includes the health endpoint router. (Email-extractor endpoints router is NOT added yet.)
- `backend/app/api/v1/endpoints/__init__.py` (empty), `backend/app/api/v1/endpoints/health.py` — `router = APIRouter(); @router.get("/health") async def health(): return {"status": "ok"}`.
- `backend/app/schemas/__init__.py` (empty). No DTOs yet.
- `backend/app/models/__init__.py` (empty). No models yet.
- `backend/app/services/__init__.py` (empty). No services yet.
- `backend/app/tests/__init__.py` (empty), `backend/app/tests/test_main.py` — two tests:
  - `test_root_health_returns_ok` — `httpx.AsyncClient` hitting `/health` returns 200 and `{"status": "ok"}`.
  - `test_v1_health_returns_ok` — same for `/api/v1/health`.

### 3. Alembic init (from `backend/`)

```bash
cd backend
alembic init -t async alembic
```

Then edit:

- `backend/alembic.ini` — set `script_location = alembic`; leave `sqlalchemy.url` empty (will be read from env in `env.py`).
- `backend/alembic/env.py` — read `DATABASE_URL` from env, import `Base` from `app.db.base`, import all models (none yet), set `target_metadata = Base.metadata`. Async revision template.
- Do NOT generate an initial revision yet — no models exist.

### 4. Install + run backend tests

**Amended** — use `uv` to provision a Python 3.11 venv, since the system interpreter is 3.13. If `uv` is not installed, install it first (see the Amendments callout at the top). `uv pip install` is compatible with pip's `requirements.txt` format — we are not switching package managers, only using uv's resolver locally for speed and for its Python-version management.

```bash
cd backend
uv venv --python 3.11 .venv
# Activate for the rest of this session:
#   Windows (PowerShell): .venv\Scripts\Activate.ps1
#   Windows (cmd.exe):    .venv\Scripts\activate.bat
#   macOS/Linux:          source .venv/bin/activate
uv pip install -r requirements-dev.txt
pytest app/tests/ -v
```

Fallback if `uv` is unavailable:

```bash
cd backend
py -3.11 -m venv .venv          # Windows; use python3.11 -m venv .venv on Unix
.venv\Scripts\Activate.ps1       # or source .venv/bin/activate on Unix
pip install -r requirements-dev.txt
pytest app/tests/ -v
```

Verify the venv is actually 3.11 before installing: `python --version` must report `Python 3.11.x`. If it reports 3.13, abort — the wrong interpreter was picked up.

Tests must pass green before committing.

### 5. Frontend scaffold (`frontend/`)

From repo root:

```bash
npx create-next-app@14 frontend \
  --typescript \
  --tailwind \
  --eslint \
  --app \
  --src-dir=false \
  --import-alias="@/*" \
  --use-npm \
  --no-turbopack
```

Then:

- Remove the boilerplate landing content from `frontend/app/page.tsx` — replace with a minimal placeholder that renders "Email Extractor — scaffold ready" with a link to `/email-extractor` (route not yet implemented; leave as dead link).
- Create `frontend/lib/api.ts` — thin wrapper around `fetch` with `credentials: 'include'`, base URL from `NEXT_PUBLIC_API_BASE_URL` env, default `http://localhost:8000`.
- Create `frontend/lib/types.ts` (empty re-export file for now).
- Install `lucide-react`: `cd frontend && npm install lucide-react`.
- `frontend/Dockerfile` — multi-stage Next.js 14 build using `output: 'standalone'`. Set `output: 'standalone'` in `frontend/next.config.mjs`.
- `frontend/.env.example` — `NEXT_PUBLIC_API_BASE_URL=http://localhost:8000`.
- Confirm `npm run lint` and `npm run build` pass green.

### 6. Docker Compose integration test — **[SKIPPED]**

**Amended.** Docker is not installed on the target machine, and installing Docker is a separate concern from scaffolding. This step is deferred to a dedicated follow-up prompt:

> `prompts/2026-04-19-0845-docker-stack-setup.md`

That prompt handles the pre-flight (`docker info`), build + up, health-endpoint curls, teardown with `--volumes`, and a cold-rebuild verification. It is the one responsible for satisfying the "stack builds and serves /health" acceptance criterion.

During this scaffold prompt:

- The `docker-compose.yml`, `backend/Dockerfile`, and `frontend/Dockerfile` files are still authored as part of Step 1–2 (`docker compose config` is a valid static lint if Docker happens to be available, but is not required).
- Do **not** attempt `docker-compose up`. If you find yourself reaching for Docker here, stop and continue to Step 7.
- Record this deferral in **Outcome → Deviations from plan** when the prompt finishes, pointing at `prompts/2026-04-19-0845-docker-stack-setup.md` as the successor.

### 7. CI workflow (`.github/workflows/ci.yml`)

Three jobs, matches parent project's pattern:

- **backend**: Python 3.11, `pip install -r backend/requirements-dev.txt`, `cd backend && ruff check . && ruff format --check . && basedpyright && pytest app/tests/`.
- **frontend**: Node 20, `cd frontend && npm ci && npm run lint && npm run build`.
- No deploy job (GCP Cloud Run deploy will be added in a later prompt, post-scaffold).

### 8. Run `/init` — Section 10 ONLY

Run `/init` with this constraint verbatim:

> Run `/init` and have it ONLY generate section 10 (`## 10. Codebase Map`) of `CLAUDE.md`. Do NOT edit sections 1–9 — they contain human intent and the handoff protocol that `/init` cannot reconstruct. If `/init` tries to overwrite the whole file, cancel and re-run with the constraint above.

After `/init` finishes, diff `CLAUDE.md` against the pre-run state. Sections 1–9 must be byte-identical. Only section 10 may be changed.

### 9. Final verification

```bash
./scripts/verify.sh
```

Must exit 0.

## Commit plan

Commit in this order, one concern per commit. Stage files explicitly by name. No AI attribution in any commit message.

1. `chore: add docker-compose, root .env.example, verify script`
2. `feat(backend): scaffold FastAPI app, health endpoint, async SQLAlchemy base, config`
3. `chore(backend): add ruff + basedpyright config, pytest setup, initial hello-world tests`
4. `chore(backend): initialize Alembic with async template`
5. `feat(frontend): scaffold Next.js 14 App Router with Tailwind + Lucide`
6. `chore: add CI workflow for ruff/basedpyright/pytest + next lint/build`
7. `docs: populate CLAUDE.md section 10 codebase map via /init`

Commit messages: terse imperative, no body unless the diff is non-obvious. Voice: Arvin.

## Acceptance criteria

A fresh agent must be able to verify each of the following:

- `git log --oneline` shows approximately 7 commits matching the Commit plan above. No commit has an AI trailer, `Co-Authored-By: Claude`, or "Generated with…" footer. Author is Arvin.
- `./scripts/verify.sh` exits 0.
- `cd backend && pytest app/tests/ -v` shows ≥ 2 tests passing (`test_root_health_returns_ok`, `test_v1_health_returns_ok`).
- `cd frontend && npm run build` succeeds with no errors.
- Dockerfiles and `docker-compose.yml` exist at the expected paths (`backend/Dockerfile`, `frontend/Dockerfile`, `docker-compose.yml`) and are syntactically valid YAML/Dockerfile, but the `docker-compose up` verification is **deferred** to `prompts/2026-04-19-0845-docker-stack-setup.md` — not required for this prompt's acceptance.
- `CLAUDE.md` sections 1–9 are **byte-identical** to their pre-run state. `git diff HEAD~7 -- CLAUDE.md` shows changes only within `## 10. Codebase Map`.
- `CLAUDE.md` section 10 references real files under `backend/app/`, `frontend/app/`, `scripts/`, not a templated placeholder.
- `docs/decisions/0001-initial-stack.md` is untouched.
- No files in `prompts/`, `plans/`, `reports/` are modified other than this prompt's Outcome section.
- Backend tests use `respx` for HTTP mocking (verifiable by `grep -r respx backend/app/tests/`).
- `.gitignore` correctly excludes `.venv/`, `node_modules/`, `.next/`, `.env`, `*.log` — confirmed by `git status` being clean after a fresh install + build.

## Subagent roles

None — this prompt is self-contained. Subsequent prompts that add business logic will use `code-review` before commit and `testing-strategy` when writing service-layer tests.

## Out of scope

- Any email-extractor business logic: providers, aggregator, models, schemas, endpoints beyond `/health`.
- Authentication beyond the `require_access` dependency stub.
- GCP Cloud Run deployment workflow — separate later prompt.
- Frontend route `/email-extractor` implementation — separate later prompt.
- Database migrations for email-extractor tables — separate later prompt (will generate the first real Alembic revision).

---

## Outcome
<!-- Filled in by CC CLI after execution. Do not pre-fill. -->

**Status:** _(succeeded | partial | blocked)_

**Summary:** _(what was done in 2–4 sentences)_

**Commits:** _(SHAs and one-line messages)_

**Deviations from plan:** _(anything done differently from the Commands / Constraints above, and why)_

**Follow-ups:** _(next prompt suggestions — e.g. "add Hunter.io provider", "wire extraction_run model + first Alembic revision", etc.)_

**Evidence:** _(test output from ./scripts/verify.sh, curl output from docker-compose integration test, `git log --oneline` of the new commits)_
