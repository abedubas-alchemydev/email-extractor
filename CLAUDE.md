# CLAUDE.md

This file is the source of truth for any AI agent (Claude Code CLI, Cowork, etc.) working in this repository. Human intent and project conventions live in sections 1–9; section 10 is a machine-generated codebase map maintained by `/init`.

---

## 1. Project

**Name:** Email Extractor

**Purpose:** Given a domain (e.g., `alchemydev.io`), discover all publicly-associated email addresses, attribute each to its source, and optionally verify deliverability via SMTP. Multiple discovery providers run concurrently and results are merged, deduplicated, and scored for confidence.

**Primary user action:** Submit a domain → watch live progress → review discovered emails → verify individual rows on demand → export results.

**Lifespan:** Standalone web app today. Eventual target: drop in as a module inside the sibling project `fis-lead-gen` (broker-dealer intelligence platform) to enrich `executive_contacts.email` for broker-dealers. Architectural decisions here are driven by that merge path — see §7.

**Out of scope:** Bulk email harvesting for unsolicited outreach. This tool is built for verified lead-gen and OSINT reconnaissance; rate limits, robots.txt respect, and opt-out handling are first-class requirements.

---

## 2. Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Language | Python **3.11** | Matches `fis-lead-gen` parent exactly; prevents version drift at merge time. |
| Backend | **FastAPI** (≥0.135) on Uvicorn | Parent project's web framework. Async-native — important for fanning out concurrent HTTP calls to Hunter/Apollo/Snov + the site crawler. |
| DB layer | **SQLAlchemy 2.0 async** (Mapped[] style) + **Alembic** | Parent conventions. |
| DB engine | **Postgres** (Docker local, Neon prod) | Parent uses Postgres end-to-end; avoids Alembic divergence between SQLite and Postgres. |
| Validation | **Pydantic v2** + **pydantic-settings** | Parent standard. |
| HTTP client | **httpx** (per-request `AsyncClient`) | Parent pattern; no long-lived pools. |
| Package manager | **pip + `requirements.txt` / `requirements-dev.txt`** | Parent canonical format. `uv pip install` is fine locally if you prefer the speedup. |
| Lint/format | **Ruff** | Replaces black + flake8 + isort. |
| Typecheck | **basedpyright** | Fast; TypeScript-friendly for the whole-repo feel. |
| Tests | **pytest** + **pytest-asyncio** + **respx** | Parent's exact testing stack. `asyncio_mode = auto` in `pytest.ini`. |
| Frontend | **Next.js 14 App Router** + **Tailwind** + **Lucide** | Parent frontend stack. Enables merge into parent's `app/(app)/` route group with zero rework. |
| Frontend lint | **ESLint** (via `next lint`) + **TypeScript** | Parent default. |
| Job pattern | DB-row tracked runs (`ExtractionRun` model) | Matches parent's `PipelineRun` — no Celery/arq. Background tasks via FastAPI `BackgroundTasks` or `asyncio.create_task`. |
| Auth (standalone) | Single API-key `Bearer` dependency | Swapped for parent's BetterAuth session dependency on merge. |
| Deployment | Docker Compose (local) → Cloud Run-ready | Parent prod target. |
| CI | GitHub Actions | Ruff, basedpyright, pytest, next lint, next build. |

### Email-discovery providers (core IP)
- **Hunter.io** — primary, paid API. Domain search endpoint.
- **Apollo.io** — secondary, paid API with generous free tier.
- **Snov.io** — optional tertiary.
- **In-house site crawler** — `httpx` + **selectolax** + regex with deobfuscation (atob, HTML entities, `[at]`/`(at)` forms). Respects `robots.txt`, rate-limited.
- **theHarvester** — free OSINT fallback invoked as a subprocess. Pulls from crt.sh, PGP keyservers, search engines, GitHub code search.

### Verification
- **`email-validator`** (already a parent dep) — syntax + MX record check. Runs on every discovered email automatically.
- **`py3-validate-email`** — SMTP RCPT TO handshake. Runs only on explicit user action per row or batch; rate-limited; results include "inconclusive" status for hosts that block/lie.

---

## 3. Commands

All commands assume repo root as CWD unless noted.

### Local stack (Docker)
```bash
docker-compose up --build             # postgres + backend :8000 + frontend :3000
```

### Backend
```bash
cd backend
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
alembic revision --autogenerate -m "message"
```

### Backend tests
```bash
cd backend
pip install -r requirements-dev.txt
pytest app/tests/ -v --tb=short                    # full suite
pytest app/tests/services/                         # one folder
pytest -k "hunter or verification"                 # keyword filter
```

Tests use `respx` to mock httpx and `monkeypatch` for config. They never hit real Hunter/Apollo/Snov or real SMTP.

### Frontend
```bash
cd frontend
npm install
npm run dev        # :3000
npm run build
npm run lint
```

### Scan runner (CLI, run from repo root)
```bash
python -m scripts.run_email_extraction --domain example.com
```

---

## 4. Architecture

### Backend layout (`backend/app/`)
```
main.py                              lifespan + CORS + router mount
api/router.py                        mounts api/v1/api.py under /api/v1
api/v1/api.py                        includes: health, email_extractor
api/v1/endpoints/                    thin HTTP handlers — delegate to services/
core/
  config.py                          pydantic-settings; loads .env (root) then backend/.env (wins)
  security.py                        require_access Depends — API-key now, BetterAuth after merge
db/
  base.py                            declarative Base
  session.py                         async engine + SessionLocal
models/                              SQLAlchemy models
  extraction_run.py                  run tracking (mirrors parent's PipelineRun)
  discovered_email.py                emails with source attribution
  email_verification.py              per-email verification history
schemas/email_extractor.py           Pydantic DTOs
services/email_extractor/            all business logic lives here
  base.py                            EmailSource Protocol
  aggregator.py                      fan-out + merge + dedupe + score
  hunter.py                          Hunter.io provider
  apollo.py                          Apollo.io provider
  snov.py                            Snov.io provider
  site_crawler.py                    in-house crawler
  theharvester.py                    subprocess wrapper for OSINT
  verification.py                    syntax/MX always; SMTP on demand
tests/                               pytest, respx-mocked; mirrors app/ structure
```

### Frontend layout (`frontend/`)
```
app/
  layout.tsx
  page.tsx                           landing / redirect
  email-extractor/
    page.tsx                         scan form
    [scanId]/page.tsx                live results + verify actions
  api/backend/[...path]/route.ts     BFF proxy (post-merge) — for standalone, calls backend directly
components/
  email-extractor/                   scan-form, results-table, verify-button
  ui/                                shared primitives
lib/
  api.ts                             browser client; credentials: 'include' (post-merge)
  types.ts
  format.ts
middleware.ts                        session gating (standalone: stub; post-merge: BetterAuth)
```

### Data flow (per scan)
1. `POST /api/v1/email-extractor/scans {domain, person_name?}` → creates `ExtractionRun(status="running")`, returns `run_id`.
2. Endpoint schedules `aggregator.run(db, run_id, domain)` as a background task; returns immediately.
3. Aggregator fans out to all enabled providers via `asyncio.gather`, each provider yielding `DiscoveredEmail` rows. Results are merged and deduplicated on `(email, domain)`.
4. For each result, `verification.check_syntax_and_mx(...)` runs inline and is stored as an `EmailVerification` row.
5. Run row is updated (`processed_items`, `success_count`, `failure_count`) as items land; `status="completed"` when done.
6. `GET /api/v1/email-extractor/scans/{id}` returns current state + all discovered emails with verifications.
7. `GET /api/v1/email-extractor/scans/{id}/events` streams progress via SSE for live UI updates.
8. `POST /api/v1/email-extractor/verify {email_ids: [...]}` runs `verification.check_smtp(...)` on demand per row or in batches.

### Config precedence
`core/config.py` mirrors parent: load root `.env` first, then `backend/.env` (wins). Shared values (DB URL, auth secret) live at root; backend-only values (API keys, rate limits) in `backend/.env`. Do not consolidate.

---

## 5. Working protocol

This repo is operated with a **prompt-file-driven workflow**. The loop is:

1. User (or Cowork) describes a task in chat.
2. AI agent writes a prompt file under `prompts/YYYY-MM-DD-HHMM-<slug>.md` using `prompts/TEMPLATE.md`.
3. The user opens a terminal in this folder and runs Claude Code CLI to execute that prompt file.
4. CC CLI records an **Outcome** at the bottom of the prompt file when done.
5. User returns to the chat agent, who reads the Outcome and plans the next prompt.

### Hard rules

- **Never edit source files directly from chat.** Every change goes through a prompt file executed by CC CLI. The chat agent's write access is limited to `prompts/`, `plans/`, `reports/`, `docs/decisions/`, and this `CLAUDE.md` itself (Section 9 only for chat; sections 1–8 and 10 change via prompt files).
- **Every task = one prompt file.** Use `prompts/TEMPLATE.md`. Don't skip fields.
- **Name ECC commands and subagents explicitly** in prompt files — e.g., `ecc_command: /plan`, not implicit.
- **Decisions that matter get promoted to ADRs** in `docs/decisions/NNNN-<slug>.md`. If a choice would be painful to revisit, it's an ADR.
- **Long AI output goes to a `.md` file, not chat.** Plans to `plans/<slug>-YYYY-MM-DD.md`, audits/analyses/reports to `reports/<slug>-YYYY-MM-DD.md`. Chat replies stay ≤ 5 lines: path + one-line summary + next question. (Carried from fis-lead-gen conventions.)

---

## 6. Conventions

### Python
- Every module starts with `from __future__ import annotations`.
- Type annotations on every function signature and class attribute. `Mapped[...]` for SQLAlchemy columns.
- Async by default for anything touching the DB or the network. Sync helpers only for pure functions.
- Service-layer classes expose `async def run(self, db: AsyncSession, ...)` for long-running jobs, returning the `ExtractionRun` row they created.
- API keys and secrets live in `backend/.env` only. Never in `frontend/.env.local`, never in source.

### Testing
- `respx` mocks all external HTTP; tests never touch real Hunter/Apollo/Snov/SMTP servers.
- Low-confidence, missing-provider-data, and provider-error cases must be stored as review/failure rows, not silently dropped. Preserve this in every new provider.

### Commits and PRs — zero AI attribution
Carried from `fis-lead-gen` house rules. Every commit and every PR on this repo must read as if Arvin wrote it himself.

- **Never** add `Co-Authored-By: Claude` / `Co-Authored-By: Anthropic` trailers.
- **Never** add "Generated with Claude Code" / "🤖 Generated with…" footers.
- **Never** reference "Claude", "AI", "assistant", "LLM", or Anthropic in commit messages, PR titles, or PR bodies.
- Write messages in Arvin's voice: concise, practical, focused on the *why*.
- Before pushing: `git log -1 --pretty=full` and confirm no AI trailer slipped in.
- This overrides default tooling templates.

### Git hygiene
- **Stage files by name**, never `git add -A` / `git add .` (the repo contains workspace artifacts — `.tmp/`, local `.env` files — that must not be swept in).
- **Never skip git hooks** (`--no-verify`) or bypass signing unless Arvin explicitly asks. If pre-commit fails, fix the issue and create a **new** commit — don't `--amend` the failed one.
- Use migrations for any DB change: `cd backend && alembic revision --autogenerate -m "<message>"` → inspect → `alembic upgrade head`. Never edit schemas outside of a migration.

### Running scripts
Always from repo root: `python -m scripts.<name>`. Scripts import from `backend.app.*` and rely on root as CWD.

---

## 7. Integration path (standalone → fis-lead-gen module)

The point of the standalone phase is faster iteration, not a different architecture. When the time comes, these changes get it into the parent:

1. **Copy** `backend/app/services/email_extractor/` → `fis-lead-gen/backend/app/services/email_extractor/`.
2. **Copy** new models (`extraction_run.py`, `discovered_email.py`, `email_verification.py`) → `fis-lead-gen/backend/app/models/`. Drop `ExtractionRun` in favor of parent's existing `PipelineRun` with `pipeline_name="email_extractor"`.
3. **Copy** `backend/app/schemas/email_extractor.py` → `fis-lead-gen/backend/app/schemas/`.
4. **Copy** `backend/app/api/v1/endpoints/email_extractor.py` → parent's endpoints; register it in parent's `api/v1/api.py`.
5. **Replace** `Depends(require_api_key)` with parent's `Depends(get_current_user_session)` (one-line change; same parameter name across routes).
6. **Foreign key** `DiscoveredEmail.bd_id` → `broker_dealers.id`. Add a post-processing step that promotes high-confidence matches into `executive_contacts.email`.
7. **Copy** `frontend/app/email-extractor/` → parent's `frontend/app/(app)/email-extractor/` and `frontend/components/email-extractor/` → parent's `components/email-extractor/`. Browser client now calls `/api/backend/email-extractor/...` through parent's BFF proxy.
8. **Generate** a single Alembic revision in the parent DB to add the new tables.

No refactoring expected. If something needs refactoring at merge time, treat it as a design bug and fix it here first.

---

## 8. Rejected alternatives

Kept brief here; full reasoning in `docs/decisions/0001-initial-stack.md`.

- **Python 3.12** — parent is 3.11.
- **`uv` as the canonical package manager** — parent uses pip + `requirements.txt`; matching the pinning format avoids divergence.
- **HTMX + Jinja2 UI** — parent frontend is Next.js; single-framework merge path is cleaner.
- **`arq` / Celery task queue** — parent uses a `PipelineRun` DB-row pattern instead of a broker-backed queue. Match it.
- **SQLite for dev** — Alembic revisions generated against SQLite can diverge on Postgres replay.
- **Django or Flask backend** — parent is FastAPI.

---

## 9. Persistent context

This section is the durable scratchpad for facts and decisions that outlive a single prompt file — learnings, unexpected constraints, provider quirks, rate-limit bruises, anything that would make a future agent smarter. The chat agent may append here directly (no prompt file required). Keep entries short and dated.

<!-- entries go here -->

---

## 10. Codebase map

> Snapshot generated 2026-04-20 after PR #7 (theharvester-error-spec-tightening).
> Refresh via `/init` (Section 10 only — sections 1–9 are hand-authored intent).
> All entries below reference real files; nothing is templated.

### Repository root

```
.env.example                 documented env vars for both backend and frontend
.github/workflows/ci.yml     three-job CI: backend (ruff + ruff-format + basedpyright + pytest unit + alembic + pytest integration on a postgres:15-alpine service container), frontend (next lint + next build), compose-lint (asserts postgres 5432 binding stays loopback)
.gitignore                   excludes .venv/, node_modules/, .next/, .env, *.log, workspace artifacts; carves out prompts/{TEMPLATE,README}.md and reports/{README}.md as the only tracked items in those dirs
CLAUDE.md                    THIS file — sections 1–9 are hand-authored intent; section 10 is auto-generated
README.md                    project pitch, quickstart, working-protocol pointer
docker-compose.yml           postgres:15-alpine bound to 127.0.0.1:5432 (loopback only) + backend (port 8000) + frontend (host port via FRONTEND_HOST_PORT, default 3000); healthcheck-gated startup
docs/decisions/0001-initial-stack.md
                             ADR for the initial stack (FastAPI + Next.js 14 + Postgres + Alembic)
docs/decisions/0002-provider-error-prefix-convention.md
                             ADR codifying the provider error-message prefix convention: providers emit bare error strings; aggregator wraps each with `<provider.name>: ` exactly once
plans/                       /plan output files written before each task (gitignored except .gitkeep)
prompts/                     prompt files executed by Claude Code CLI (gitignored except TEMPLATE.md, README.md, .gitkeep)
reports/                     audit / analysis / verification reports (gitignored — local scratchpad)
scripts/__init__.py          package marker — enables `python -m scripts.<name>`
scripts/verify.sh            green-check pipeline: backend lint+typecheck+tests, frontend lint+build
```

### Backend (`backend/`)

```
Dockerfile                   python:3.11-slim base; pip-installs requirements.txt; pipx-installs theHarvester from upstream git tag (ARG THEHARVESTER_REF=<SHA> → /usr/local/bin/theHarvester); $PORT-aware uvicorn entry
alembic.ini                  sqlalchemy.url left blank — env.py sets it from settings.database_url
alembic/env.py               sync online migrations via engine_from_config + pool.NullPool; +asyncpg stripped from URL (project uses psycopg, but env.py is defensive)
alembic/script.py.mako       generated revision template
alembic/versions/78f509b95848_initial_email_extractor_schema.py
                             initial schema: extraction_runs, discovered_emails, email_verifications (3 tables; FKs CASCADE; unique on (run_id, email))
pyproject.toml               Ruff (E, F, I, UP, B, SIM, ASYNC; B008 ignored) + basedpyright (3.11, includes app/, noisy categories muted)
pytest.ini                   testpaths=app/tests, pythonpath=., asyncio_mode=auto, addopts=-m "not integration", `integration` marker registered
requirements.txt             alembic, fastapi, SQLAlchemy 2.0 async, pydantic-settings, httpx, psycopg[binary], selectolax (theHarvester intentionally NOT pinned here — installed via Dockerfile pipx; PyPI's `theHarvester` is a placeholder squatter)
requirements-dev.txt         pytest, pytest-asyncio, respx, ruff, basedpyright (extends requirements.txt)
.env.example                 backend-only env vars (loaded second, override=True): EMAIL_EXTRACTOR_API_KEY, HUNTER_API_KEY, APOLLO_API_KEY, SNOV_API_KEY, HUNTER_LIMIT, THEHARVESTER_SOURCES, THEHARVESTER_TIMEOUT_SECONDS

app/main.py                  FastAPI app with async lifespan disposing the SQLAlchemy engine; Windows event-loop shim; root /health
app/core/config.py           Settings(BaseSettings) with cors_origins computed_field; loads root .env then backend/.env (backend wins); HUNTER_LIMIT (1..100, default 10) and THEHARVESTER_TIMEOUT_SECONDS (10..300, default 90) validated at app startup
app/core/security.py         require_access Depends — Bearer-token auth dev-mode-permissive; swaps to BetterAuth on merge
app/db/base.py               DeclarativeBase; model imports register Base.metadata for Alembic
app/db/session.py            async engine + SessionLocal + get_db_session() FastAPI dependency
app/api/router.py            mounts api_v1_router (single layer of indirection mirrors fis-lead-gen)
app/api/v1/api.py            includes endpoints/health.router and endpoints/email_extractor.router
app/api/v1/endpoints/health.py
                             GET /health → {"status": "ok"}
app/api/v1/endpoints/email_extractor.py
                             POST /scans (creates ExtractionRun, schedules aggregator), GET /scans/{id} (state + discovered_emails with verifications), GET /scans/{id}/events (SSE for live progress), POST /verify (per-row SMTP verification — endpoint registered, check_smtp impl deferred)
app/schemas/email_extractor.py
                             Pydantic v2 DTOs: ScanCreateRequest, ScanResponse, DiscoveredEmailResponse, EmailVerificationResponse — mirror the SQLAlchemy models for the JSON wire format
app/models/extraction_run.py
                             SQLAlchemy 2.0 Mapped[] model; Int autoincrement PK; status (queued/running/completed/failed); pipeline_name="email_extractor" (mirrors fis-lead-gen PipelineRun for merge symmetry); started_at/completed_at timestamps; counters; error_message text
app/models/discovered_email.py
                             SQLAlchemy model — FK extraction_runs CASCADE; unique (run_id, email); source/confidence/attribution columns
app/models/email_verification.py
                             SQLAlchemy model — FK discovered_emails CASCADE; syntax_valid, mx_record_present, smtp_status enum (not_checked/deliverable/undeliverable/inconclusive), smtp_message
app/services/email_extractor/base.py
                             EmailSource Protocol + DiscoveredEmailDraft + DiscoveryResult dataclasses (the ADR 0002 contract surface)
app/services/email_extractor/aggregator.py
                             Real fan-out via anyio.create_task_group; per-provider exception isolation; cross-provider dedupe on lowercased email; inline syntax+MX verification per draft; persists DiscoveredEmail + EmailVerification rows; wraps each provider error with f"{provider.name}: {err}" exactly once (ADR 0002)
app/services/email_extractor/hunter.py
                             Hunter.io domain-search provider; HUNTER_LIMIT sourced from settings; bare-error contract; plan-limit 400 detection (free tier returns 400 if limit > plan max)
app/services/email_extractor/site_crawler.py
                             httpx + selectolax + regex with deobfuscation (atob/HTML entities/[at]/(at) forms); robots.txt-aware; bare-error contract
app/services/email_extractor/theharvester.py
                             Subprocess wrapper around theHarvester CLI (pipx-installed via Dockerfile); free OSINT sources only (default crtsh,rapiddns,otx,duckduckgo); module-level _run_subprocess seam for tests; bare-error contract; missing emails-key in JSON = empty success (matches upstream behavior)
app/services/email_extractor/verification.py
                             check_syntax_and_mx via email-validator (syntax + MX lookup); runs inline on every persisted draft; SMTP verification (RCPT TO handshake) deferred to a future per-row endpoint
app/tests/__init__.py
app/tests/test_main.py       3 unit tests: root /health, /api/v1/health, respx pattern-seed
app/tests/api/test_email_extractor_scans.py
                             2 integration tests (pytest.mark.integration): scan POST/GET round trip, 404 for unknown id
app/tests/services/email_extractor/test_aggregator.py
                             5 integration tests: persistence happy path, exception isolation, all-providers-fail → status=failed, ADR 0002 single-provider prefix, ADR 0002 multi-provider independent prefixes
app/tests/services/email_extractor/test_hunter.py
                             11 respx tests: happy path, all 4xx/5xx error branches, plan-limit 400, configurable HUNTER_LIMIT flows through to URL query param
app/tests/services/email_extractor/test_site_crawler.py
                             6 respx tests: mailto+text+obfuscated extraction, robots disallow, 500 error, non-HTML content-type skip, off-domain filter, dedupe across pages
app/tests/services/email_extractor/test_theharvester.py
                             25 tests with mocked _run_subprocess: happy paths, every error branch, ADR 0002 bare-error contract parametrized over 10 fixtures
app/tests/services/email_extractor/test_verification.py
                             3 tests: valid syntax+MX, invalid syntax, MX lookup failure
```

### Frontend (`frontend/`)

```
Dockerfile                   multi-stage Node 20 alpine; output: standalone; non-root user; honors NEXT_PUBLIC_API_BASE_URL build arg (single-dash default = empty string for same-origin /api/* paths)
.env.example                 NEXT_PUBLIC_API_BASE_URL only (default empty → uses Next.js rewrites locally; nginx terminates /api/* in production)
.eslintrc.json               next/core-web-vitals defaults
.gitignore                   node_modules/, .next/, .env*.local, *.tsbuildinfo, next-env.d.ts
README.md                    inherited Next.js scaffold
next.config.mjs              output: "standalone" + async rewrites() forwarding /api/* to BACKEND_INTERNAL_URL when set (Docker dev)
package.json                 next 14.2.x, react 18, lucide-react, tailwindcss, eslint-config-next
package-lock.json            npm lockfile
postcss.config.mjs           tailwindcss + autoprefixer
public/.gitkeep              Next.js's expected static-asset dir (placeholder)
tailwind.config.ts           content: app/, components/ (components/ not yet created)
tsconfig.json                @/* import alias mapped to repo root

app/layout.tsx               root layout with Geist fonts
app/page.tsx                 domain-search UI: form, polling (1.5s interval, 180s timeout), results table with verification cells; centers on empty state, top-aligns once a scan returns
app/globals.css              Tailwind base/components/utilities + dark-mode CSS vars
app/favicon.ico              default Next.js favicon
app/fonts/                   Geist + GeistMono woff binaries

lib/api.ts                   fetch wrapper with credentials:"include"; ApiError class; reads NEXT_PUBLIC_API_BASE_URL (empty → relative URLs)
lib/types.ts                 placeholder — populated as feature work lands
```

### Conventions snapshot

- Backend modules start with `from __future__ import annotations`.
- Async by default for anything touching DB or network; sync only for pure functions.
- HTTP client: per-request `httpx.AsyncClient` (no long-lived pools).
- Tests mock outbound HTTP via `respx` — never hit real Hunter/Apollo/Snov/SMTP.
- Subprocess-based providers (theHarvester) seam through a module-level `_run_subprocess` helper so tests monkeypatch without spawning real processes.
- Provider error contract (ADR 0002): providers emit BARE error strings; the aggregator wraps each with `f"{provider.name}: {err}"` exactly once when persisting to `extraction_run.error_message`. Never self-prefix in a provider.
- Integration tests are gated by `@pytest.mark.integration` and skipped by default (`pytest.ini` `addopts = -m "not integration"`); CI runs them in a separate step against a `postgres:15-alpine` service container.
- Postgres in `docker-compose.yml` is bound to `127.0.0.1:5432` only — never expose 5432 publicly. The `compose-lint` CI job greps for non-loopback bindings.
- Env loading precedence: root `.env` first, then `backend/.env` (wins). Don't consolidate.
- Commits: zero AI attribution; stage by name; never `--no-verify`.
- Migrations: alembic only — never edit schemas outside of a migration.
- Active `gh auth` account must be `abedubas-alchemydev` for any `git push` / `gh pr` operation against this repo (see `~/.claude/projects/.../memory/reference_github_identity.md`); other accounts get HTTP 403.

### What is NOT here yet

Genuinely-not-started items as of 2026-04-20:

- Apollo provider (`services/email_extractor/apollo.py` + tests) — deferred (free-tier API key returns zero emails per `reports/apollo-endpoint-probe-2026-04-19.md`).
- Snov provider — blocked on signup approval.
- SMTP verification implementation (`verification.check_smtp` — endpoint `POST /verify` is wired but the impl is a stub; py3-validate-email integration deferred).
- GCP Cloud Run deploy workflow.
- Frontend route `app/email-extractor/[scanId]/page.tsx` (dedicated live-updates view) — current `app/page.tsx` is the all-in-one search UI.
- Frontend `components/` directory (referenced in `tailwind.config.ts` content glob but not yet populated).
- Live-subprocess theHarvester integration test (kept binary-free in CI; only Docker image has it).
- `prompts/README.md` and `reports/README.md` (gitignore carve-outs reserve the slots; files themselves are optional and not yet authored).
