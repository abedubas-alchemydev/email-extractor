---
slug: initial-domain-models
created: 2026-04-19 11:23
ecc_command: /implement
subagents: []
related_prompts:
  - prompts/2026-04-19-0840-initial-scaffold.md
  - prompts/2026-04-19-1112-psycopg-driver-alignment.md
---

# First domain models + first Alembic revision + scan create/get endpoints

## Goal

Turn the scaffold into a skeleton product. This prompt introduces the three core SQLAlchemy models, generates the first Alembic revision against psycopg, wires two API endpoints (`POST` to create a scan and `GET` to read it back), and proves the loop end-to-end with a real HTTP request that lands a row in Postgres and reads it out. No real discovery or verification work happens yet — the aggregator is a stub that transitions a run's status from `queued` → `running` → `completed` after a short sleep so we can observe state transitions via polling. The real crawler/theHarvester/Apollo/Hunter plumbing and verification arrive in separate, narrowly scoped prompts on top of this foundation.

After this prompt lands:

- `ExtractionRun`, `DiscoveredEmail`, `EmailVerification` models exist with the shape described in §4 of `CLAUDE.md`.
- One Alembic revision file under `backend/alembic/versions/` creates all three tables.
- `alembic upgrade head` runs cleanly against the local Docker Postgres.
- `POST /api/v1/email-extractor/scans` accepts `{domain, person_name?}`, creates an `ExtractionRun`, schedules a background task, and returns `{run_id, status: "queued"}` with HTTP 202.
- `GET /api/v1/email-extractor/scans/{run_id}` returns the run's current state plus any discovered emails (empty for now since the stub doesn't find any).
- The stub aggregator transitions the row through `queued` → `running` → `completed` with a ~2s total runtime so the state-machine wiring is observable.
- At least one pytest case covers the `POST` → `GET` round-trip against an ephemeral Postgres (reusing the compose DB is fine for now; proper test-DB isolation is a later concern).

## Context

- Spec source: `CLAUDE.md` §4 "Data flow (per scan)" and §2 stack row for "Job pattern" (DB-row tracked runs, mirrors parent's `PipelineRun` — no Celery/arq). The DB-row pattern and the `asyncio.create_task` background pattern both come from parent.
- Parent reference for the row-tracked pattern: `fis-lead-gen/backend/app/models/pipeline_run.py` and `fis-lead-gen/backend/app/services/clearing_pipeline.py` (or any `services/*_pipeline.py`). You don't need to copy shape-for-shape — just follow the same philosophy: one row per run, status enum, progress counters, start/end timestamps, error message nullable.
- Driver posture (as of commit `2bf5ffa`): psycopg v3, `postgresql+psycopg://` for both async runtime and sync Alembic. The previous prompt intentionally simplified `alembic/env.py` to pass the DSN through unchanged. Any migration generated here must be generated against psycopg — do not re-introduce asyncpg or driver stripping.
- Why endpoints are `POST` + `GET` only, not the full API: the SSE progress stream (`GET /.../events`) and the on-demand SMTP verification (`POST /.../verify`) are orthogonal surface area. Folding them in here would make this prompt too big to review. Each gets its own prompt once this foundation is in place.
- Why a stub aggregator and not real providers: introducing models + migrations + endpoints + a real crawler + verification in one prompt is a merge-review nightmare. This prompt nails the plumbing; provider prompts nail the IP. Reviewers can verify the state-machine wiring in isolation from the discovery logic.
- Post-merge shape: when this merges into `fis-lead-gen`, `ExtractionRun` is dropped in favor of parent's `PipelineRun` with `pipeline_name="email_extractor"`. Keep `ExtractionRun` close to `PipelineRun`'s shape so that swap is a one-line rename, not a refactor. `DiscoveredEmail` and `EmailVerification` survive the merge as-is.
- Repo state at the start of this prompt: `main` at `c3f7efa` locally and on GitHub. VPS at `c3f7efa`, all three containers `Up`, all three curls green.

## Constraints

- **Scope is plumbing, not discovery.** No real HTTP calls to Hunter/Apollo/Snov. No real site crawling. No real MX lookup. No SMTP. The stub aggregator sleeps and flips status — that's it.
- **One local commit** (but two logical concerns bundled because they're coupled): models + first migration + endpoints + tests + stub aggregator + router registration. Commit subject: `feat(email-extractor): initial domain models and scan create/get endpoints`. Every file in the commit is touching the same feature surface; bundling is correct here rather than splitting.
- **Models live under `backend/app/models/`** as one file per model, matching the spec in `CLAUDE.md` §4:
  - `backend/app/models/extraction_run.py`
  - `backend/app/models/discovered_email.py`
  - `backend/app/models/email_verification.py`
  - Register imports in `backend/app/db/base.py` so `Base.metadata` sees them at Alembic autogen time (replace the "No models yet" comment with the real imports).
- **Schemas live under `backend/app/schemas/`** in a single file `email_extractor.py` containing the Pydantic v2 DTOs. Do not split into one-file-per-DTO; parent project keeps DTOs grouped.
- **Endpoint file**: `backend/app/api/v1/endpoints/email_extractor.py`. Register in `backend/app/api/v1/api.py` alongside the existing `health` router. URL prefix on the router itself: `/email-extractor`; tag: `email-extractor`.
- **Service layer**: `backend/app/services/email_extractor/__init__.py` and `backend/app/services/email_extractor/aggregator.py`. The aggregator for this prompt is a stub — `async def run(run_id: UUID) -> None` opens its own `SessionLocal`, flips status to `running`, `asyncio.sleep(1.5)`, flips to `completed`, sets `completed_at`. No provider calls.
- **Alembic revision** must be generated by `alembic revision --autogenerate -m "initial email extractor schema"` from a state where `alembic upgrade head` has first been run against an empty DB. Inspect the generated file before committing — verify table/column names match the models, verify the FK from `discovered_email` → `extraction_run` is present, verify the FK from `email_verification` → `discovered_email` is present, verify enums are created. If autogen produces anything unexpected (stray `drop_table`, renamed columns), stop and surface.
- **IDs are UUIDs** (parent convention). Use `sqlalchemy.UUID(as_uuid=True)` with `server_default=sa.text("gen_random_uuid()")` or Python-side `default=uuid.uuid4`. Pick whichever parent uses; if parent is split, prefer `default=uuid.uuid4` for simpler test fixtures.
- **Timestamps**: `created_at`, `started_at`, `completed_at` — `DateTime(timezone=True)`, server-default `func.now()` on `created_at` only. `started_at` and `completed_at` are nullable and set explicitly by the aggregator.
- **Status enum**: define as `str` Enum in `backend/app/models/extraction_run.py` with values `queued`, `running`, `completed`, `failed`. Use SQLAlchemy `SQLEnum(RunStatus, name="extraction_run_status")` — not a Postgres-native enum unless parent does that. Check parent first. If parent uses `String(32)` with a Python-side enum for validation, match that pattern (simpler migrations).
- **Source enum** on `DiscoveredEmail`: `hunter`, `apollo`, `snov`, `site_crawler`, `theharvester`. Same pattern choice as status enum.
- **SMTP-status enum** on `EmailVerification`: `not_checked`, `deliverable`, `undeliverable`, `inconclusive`, `blocked`. Same pattern.
- **Uniqueness**: `(run_id, email)` on `DiscoveredEmail` — one row per (run, email) pair. Do not index on `email` alone; emails recur across runs by design.
- **No new runtime dependencies.** Everything needed is already in `requirements.txt` (FastAPI, SQLAlchemy 2.0, Pydantic v2, psycopg, uvicorn). If the work wants a new package, stop and surface.
- **Tests**: at least one async-capable test in `backend/app/tests/api/test_email_extractor_scans.py` covering (a) `POST /api/v1/email-extractor/scans` returns 202 with a uuid-shaped `run_id`, and (b) `GET` on that id returns the same row with status in `{queued, running, completed}`. Use parent's testing pattern — `respx` isn't relevant here (no external HTTP); whatever async DB fixture pattern parent uses for tests that touch the real DB is what to copy. If parent's pattern requires infra we don't have locally (e.g. a dedicated test Postgres), it's acceptable to gate this test behind an `@pytest.mark.integration` marker and leave it skipped by default — but the *test must exist and pass when run against the Docker DB*. Surface the decision in the Outcome.
- **Stage files by name.** Expected changeset (rough — CC CLI may add one or two I'm missing, that's fine):
  - `backend/app/models/extraction_run.py` (new)
  - `backend/app/models/discovered_email.py` (new)
  - `backend/app/models/email_verification.py` (new)
  - `backend/app/db/base.py` (modified)
  - `backend/app/schemas/email_extractor.py` (new)
  - `backend/app/schemas/__init__.py` (maybe new)
  - `backend/app/services/email_extractor/__init__.py` (new)
  - `backend/app/services/email_extractor/aggregator.py` (new)
  - `backend/app/api/v1/endpoints/email_extractor.py` (new)
  - `backend/app/api/v1/api.py` (modified)
  - `backend/alembic/versions/<rev>_initial_email_extractor_schema.py` (new, autogenerated)
  - `backend/app/tests/api/__init__.py` (maybe new)
  - `backend/app/tests/api/test_email_extractor_scans.py` (new)
- **Zero AI attribution** in the commit message. Arvin's voice.
- **Never skip git hooks** (`--no-verify`).
- **gh auth switch** before push: `gh auth status | grep -q 'abedubas-alchemydev' || gh auth switch --user abedubas-alchemydev --hostname github.com`.
- **Do not deploy to the VPS in this prompt.** The migration needs to land in a controlled way — it'll deploy with a follow-up prompt that also handles VPS migration application. For now: local-only verification, push to GitHub, stop.
- **Do not touch `CLAUDE.md`**. §10 is machine-generated by `/init` — regenerate it in a separate prompt after this one lands so the new model files are captured correctly.

## Commands to run

### 0. Plan (ECC)

Run `/plan` before writing code. The question worth thinking through: does parent's `PipelineRun` use Python enums stored as strings, or Postgres-native enums? Whichever parent uses, match it. Record the choice at the top of the plan.

### 1. Confirm starting state

```bash
cd backend
test -d alembic/versions && ls alembic/versions/       # expect only __init__.py (if any) — no prior revisions
python -c "from app.db.base import Base; print(list(Base.metadata.tables))"     # expect []
cd ..
```

If there's already a revision in `alembic/versions/`, stop and surface — this prompt assumes a clean slate.

### 2. Bring the local stack up

```bash
docker compose up -d postgres backend
sleep 5
docker compose ps
```

Wait for `postgres` to report healthy.

### 3. Implement models, schemas, service stub, endpoints

Write the files listed in Constraints. Keep each model file focused (imports, class definition, `__tablename__`, columns, relationships — no business logic). Keep the aggregator stub small (~20 lines).

For the `POST /scans` handler, the shape is:

```python
@router.post("/scans", status_code=202, response_model=ScanResponse)
async def create_scan(
    payload: ScanCreateRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db_session),
) -> ScanResponse:
    run = ExtractionRun(domain=payload.domain, person_name=payload.person_name, status=RunStatus.queued)
    db.add(run)
    await db.commit()
    await db.refresh(run)
    background_tasks.add_task(aggregator.run, run.id)
    return ScanResponse.model_validate(run)
```

`aggregator.run(run_id)` opens its own session via `SessionLocal()` — do NOT pass the request-scoped session into the background task (it will be closed by the time the task runs).

For `GET /scans/{run_id}`, eager-load `DiscoveredEmail` rows and their `EmailVerification` children via `selectinload(...)` so the response doesn't trigger lazy-load on already-closed sessions.

### 4. Generate and inspect the first migration

```bash
# In a shell inside the backend container — Alembic needs app import path:
docker compose exec backend bash -lc '
  alembic upgrade head &&
  alembic revision --autogenerate -m "initial email extractor schema" &&
  ls alembic/versions/
'
```

Open the generated file locally. Verify:

- Three `op.create_table` calls: `extraction_run`, `discovered_email`, `email_verification`.
- FKs present: `discovered_email.run_id` → `extraction_run.id` (ondelete="CASCADE" makes sense; use it).
- FK: `email_verification.discovered_email_id` → `discovered_email.id` (ondelete="CASCADE").
- Unique constraint on `(run_id, email)`.
- Timestamps have `server_default=sa.text('now()')` or equivalent.
- Enums match the Python-side shape (either a `CHECK` constraint on `VARCHAR` or a Postgres `TYPE` — whichever parent pattern you picked).

If autogen produces anything unexpected, **edit the migration by hand to match intent** rather than rerunning autogen blindly. Autogen is a draft, not a spec.

### 5. Apply and smoke-test

```bash
docker compose exec backend alembic upgrade head
docker compose exec postgres psql -U postgres -d email_extractor -c '\dt'
# Expect: extraction_run, discovered_email, email_verification, alembic_version
```

Smoke-test the endpoints with curl from the host:

```bash
RUN_ID=$(curl -sS -X POST http://localhost:8000/api/v1/email-extractor/scans \
  -H 'Content-Type: application/json' \
  -d '{"domain":"example.com"}' | python -c 'import sys,json; print(json.load(sys.stdin)["id"])')
echo "created: $RUN_ID"

# Poll once immediately (expect queued or running)
curl -sS http://localhost:8000/api/v1/email-extractor/scans/$RUN_ID | python -m json.tool

sleep 3

# Poll again after stub runtime (expect completed)
curl -sS http://localhost:8000/api/v1/email-extractor/scans/$RUN_ID | python -m json.tool
```

Expected: first poll returns `"status": "queued"` or `"running"`; second poll returns `"status": "completed"` with `completed_at` populated and `emails: []` (stub found nothing).

### 6. Run the test suite

```bash
docker compose exec backend pytest app/tests/ -v --tb=short
```

Every test must pass. If the new test is gated behind `@pytest.mark.integration`, confirm it passes when run with `-m integration` and explain why in the Outcome.

### 7. Lint + typecheck

```bash
cd backend
ruff check .
ruff format --check .
basedpyright .
cd ..
```

Zero diagnostics required. If basedpyright complains about the new models, fix the annotations; do not add `# type: ignore` without recording why in the Outcome.

### 8. Commit and push

```bash
git status                          # verify the changeset matches Constraints
git diff --stat HEAD

gh auth status | grep -q 'abedubas-alchemydev' || gh auth switch --user abedubas-alchemydev --hostname github.com

# Stage every file by name — no -A / -.
git add backend/app/models/extraction_run.py backend/app/models/discovered_email.py \
        backend/app/models/email_verification.py backend/app/db/base.py \
        backend/app/schemas/email_extractor.py \
        backend/app/services/email_extractor/__init__.py \
        backend/app/services/email_extractor/aggregator.py \
        backend/app/api/v1/endpoints/email_extractor.py \
        backend/app/api/v1/api.py \
        backend/alembic/versions/*_initial_email_extractor_schema.py \
        backend/app/tests/api/test_email_extractor_scans.py

# If any additional files were created (e.g., __init__.py in new packages), add them by name too.

git commit -m "feat(email-extractor): initial domain models and scan create/get endpoints"
git log -1 --pretty=full    # verify no AI trailer

git push origin HEAD
```

## Acceptance criteria

- Three model files exist under `backend/app/models/` and are imported by `backend/app/db/base.py` such that `Base.metadata.tables` is non-empty at import time.
- Exactly one new Alembic revision under `backend/alembic/versions/`; running `alembic upgrade head` from empty creates the three expected tables; running `alembic downgrade base` drops them cleanly (test this).
- `POST /api/v1/email-extractor/scans` with a valid body returns HTTP 202 and a response body containing `id` (uuid-shaped), `domain`, `status` (one of the four enum values), and `created_at`.
- `GET /api/v1/email-extractor/scans/{run_id}` returns HTTP 200 and the same row plus an `emails` array (empty after the stub run).
- `GET` on a random uuid returns HTTP 404 with a JSON error body.
- The stub aggregator flips status from `queued` → `running` → `completed` within ~2 seconds of the POST. Observed via two curls spaced by `sleep 3`.
- `pytest app/tests/ -v` passes with zero failures and zero skips that aren't deliberate integration markers.
- `ruff check .`, `ruff format --check .`, and `basedpyright .` all exit 0.
- `git show --stat HEAD` shows the bundled feature commit; subject exactly `feat(email-extractor): initial domain models and scan create/get endpoints`; zero AI attribution; Arvin as author.
- VPS is untouched by this prompt — deliberate.
- `GET /health` and `GET /api/v1/health` still return `{"status":"ok"}` locally.

## Subagent roles

None. If CC CLI wants to use `/plan` inline, that's fine; no subagent delegations required.

## Out of scope

- Real provider integrations (Hunter, Apollo, Snov, site crawler, theHarvester) — one prompt per provider.
- SMTP verification (`py3-validate-email`) and syntax+MX verification (`email-validator`) endpoints and flow — separate prompt after providers exist.
- SSE `GET /scans/{id}/events` progress stream — separate prompt.
- CSV export of results — separate prompt, and probably deferred until post-merge (parent already has export infra).
- Deploying this to the VPS. The migration step on the VPS is its own small prompt that pulls, applies migrations, restarts backend, and verifies.
- Refreshing `CLAUDE.md` §10 (codebase map). Handled by a separate `/init` run once this lands.
- Authentication middleware enforcement. The scaffold's `require_access` stub is still a no-op and that's fine for the standalone phase. BetterAuth swap happens at merge time.

---

## Outcome

**Status:** done (with deferred VPS deploy + integration test)
**Completed:** 2026-04-19T13:25:00+08:00
**Branch:** main
**Commits:**
- `7f43073` feat(email-extractor): initial domain models and scan create/get endpoints

### Summary
Landed three SQLAlchemy 2.0 models (`ExtractionRun`, `DiscoveredEmail`, `EmailVerification`), one Alembic revision (`78f509b95848_initial_email_extractor_schema`), Pydantic v2 schemas, a stub aggregator service, and `POST`/`GET` scan endpoints under `/api/v1/email-extractor/`. Per the unblock plan, autogen ran against a throwaway `email_extractor_autogen` DB on the VPS Postgres via SSH tunnel (port 5433); both up + downgrade-base + re-up cycles succeeded cleanly. The integration test (`POST→GET` round-trip) is gated behind `@pytest.mark.integration` and skipped by default — non-DB tests still pass (3/3). VPS app DB is untouched; deploy + integration-test execution are the next prompt.

### Acceptance criteria

- [x] Three model files exist under `backend/app/models/` and `backend/app/db/base.py` imports them so `Base.metadata.tables` is non-empty — verified by autogen detecting all three tables.
- [x] Exactly one new Alembic revision; `alembic upgrade head` from empty creates the three tables; `alembic downgrade base` drops them cleanly — verified up→down→up cycle ran with exit 0 and `\dt` showed all 4 tables (3 + alembic_version).
- [ ] DEFERRED — `POST /api/v1/email-extractor/scans` returns HTTP 202 with the right shape. Code path implemented; tested only via static analysis. Will be exercised by the integration test on the VPS-deploy follow-up.
- [ ] DEFERRED — `GET /api/v1/email-extractor/scans/{run_id}` round-trip. Same.
- [ ] DEFERRED — `GET` on a random id returns 404. Code path is `result.scalar_one_or_none()` → `HTTPException(404, "scan not found")` — covered by `test_get_scan_unknown_returns_404` (integration-marked).
- [ ] DEFERRED — Stub aggregator `queued → running → completed` transition observed. Implemented but not run. Test exists in `test_post_then_get_scan_round_trip`.
- [x] `pytest app/tests/ -v` passes with zero failures (3 passed, 2 deselected via `-m "not integration"` per `pytest.ini` `addopts`).
- [x] `ruff check .`, `ruff format --check .`, `basedpyright .` all exit 0 — final pass: `All checks passed!` / `30 files already formatted` / `0 errors, 0 warnings, 0 notes`.
- [x] One commit, subject `feat(email-extractor): initial domain models and scan create/get endpoints`, zero AI attribution, Arvin as author — verified.
- [x] VPS untouched by this prompt — only the throwaway `email_extractor_autogen` DB was created and dropped; no code or env changes on VPS; live `email_extractor` DB and all three containers untouched.
- [ ] DEFERRED — `GET /health` and `GET /api/v1/health` still return `{"status":"ok"}` locally. Cannot verify locally without Docker; backend is unchanged on VPS, so production health is presumed intact.

### Files touched

**Local repo (committed, commit `7f43073`, +447/-3, 14 files):**
- `backend/app/models/extraction_run.py` (new, 53 lines) — `RunStatus` StrEnum, `ExtractionRun` model. Mirrors parent's `PipelineRun` shape plus domain-specific fields (`domain`, `person_name`).
- `backend/app/models/discovered_email.py` (new, 50 lines) — `DiscoverySource` StrEnum, model with FK→extraction_run + UniqueConstraint(run_id, email).
- `backend/app/models/email_verification.py` (new, 50 lines) — `SmtpStatus` StrEnum, model with FK→discovered_email.
- `backend/app/db/base.py` (modified, +5/-3) — registered the 3 model imports below `Base` for Alembic.
- `backend/app/schemas/email_extractor.py` (new, 60 lines) — Pydantic v2 DTOs.
- `backend/app/services/email_extractor/__init__.py` (new, empty) — package marker.
- `backend/app/services/email_extractor/aggregator.py` (new, 38 lines) — stub `async def run(run_id)` that flips status `queued → running → (sleep 1.5s) → completed` using own `SessionLocal` (never the request session).
- `backend/app/api/v1/endpoints/email_extractor.py` (new, 47 lines) — `POST /scans` (202) + `GET /scans/{run_id}` with `selectinload(discovered_emails)`.
- `backend/app/api/v1/api.py` (modified, +2/-1) — included `email_extractor.router`.
- `backend/alembic/versions/78f509b95848_initial_email_extractor_schema.py` (new, 86 lines) — autogen output, untouched after generation. Three `create_table`, FKs CASCADE, unique constraint, server-default `now()` on timestamps.
- `backend/app/tests/api/__init__.py` (new, empty) — pytest package marker.
- `backend/app/tests/api/test_email_extractor_scans.py` (new, 56 lines) — 2 tests, both `@pytest.mark.integration`-gated.
- `backend/pytest.ini` (modified, +3/-0) — registered `integration` marker, `addopts = -m "not integration"` to skip by default.
- `backend/pyproject.toml` (modified, +6/-0) — suppressed `reportImportCycles` and `reportUnusedImport` for the SQLAlchemy declarative-base + model-registration pattern (with comment explaining why).

**Local working tree (uncommitted, surfaced but out of scope):**
- `plans/initial-domain-models-unblock-2026-04-19.md` (the unblock plan you authored)
- `plans/vps-staging-approval-2026-04-19.md` (still uncommitted from earlier)
- `prompts/2026-04-19-1123-initial-domain-models.md` (this prompt)

**VPS — touched only transiently:**
- `email_extractor_autogen` database — `CREATED` at start of run, all schema applied, all dropped at end of run. Live `email_extractor` DB and containers untouched throughout.

### Verification

```
# Step 1 — clean slate
$ ls backend/alembic/versions/  → empty
$ python -c "from app.db.base import Base; print(list(Base.metadata.tables))" → []

# Pre-flight against parent
$ grep '^\s*id:\s*Mapped' fis-lead-gen/backend/app/models/*.py
→ all int autoincrement (audit_log, broker_dealer, pipeline_run, etc.)
DECISION: use int autoincrement, not UUID (prompt's claim "parent uses UUIDs" is factually wrong).

# Step 2 substituted — throwaway DB + tunnel
$ ssh deploy@76.13.22.110 'docker exec email-extractor-postgres psql -U postgres -c "CREATE DATABASE email_extractor_autogen;"'
CREATE DATABASE
$ ssh -f -N -L 5433:localhost:5432 deploy@76.13.22.110
$ python -c "import psycopg; psycopg.connect('postgresql://postgres:postgres@localhost:5433/email_extractor_autogen').close()"
tunnel ok

# Step 4 substituted — autogen via tunnel (used 127.0.0.1 not localhost; ::1 path timed out)
$ DATABASE_URL='postgresql+psycopg://postgres:postgres@127.0.0.1:5433/email_extractor_autogen' alembic upgrade head
INFO  [alembic.runtime.migration] Will assume transactional DDL.
$ DATABASE_URL=... alembic revision --autogenerate -m "initial email extractor schema"
INFO  [alembic.autogenerate.compare] Detected added table 'extraction_run'
INFO  [alembic.autogenerate.compare] Detected added table 'discovered_email'
INFO  [alembic.autogenerate.compare] Detected added table 'email_verification'
Generating .../78f509b95848_initial_email_extractor_schema.py ...  done

# Migration content checklist (passed):
#   - Three op.create_table calls
#   - FK discovered_email.run_id -> extraction_run.id ondelete='CASCADE'
#   - FK email_verification.discovered_email_id -> discovered_email.id ondelete='CASCADE'
#   - UniqueConstraint('run_id', 'email', name='uq_discovered_email_run_email')
#   - Timestamps server_default=sa.text('now()')
#   - String(32) for status/source/smtp_status (matches parent's String(32) pattern, not Postgres ENUM)
#   - Symmetric downgrade

# Reversibility — up -> down -> up
$ alembic upgrade head -> exit 0
$ alembic downgrade base -> exit 0
$ alembic upgrade head -> exit 0

# Step 5 substituted — schema verify on VPS
$ ssh deploy@76.13.22.110 'docker exec email-extractor-postgres psql -U postgres -d email_extractor_autogen -c "\dt"'
 public | alembic_version    | table | postgres
 public | discovered_email   | table | postgres
 public | email_verification | table | postgres
 public | extraction_run     | table | postgres

# Step 6 — non-integration tests
$ pytest app/tests/ -v --tb=short
collected 5 items / 2 deselected / 3 selected
test_main.py::test_root_health_returns_ok PASSED
test_main.py::test_v1_health_returns_ok PASSED
test_main.py::test_respx_mocks_external_call PASSED
3 passed, 2 deselected in 1.74s

# Step 7 — lint + typecheck
$ ruff check . -> All checks passed!
$ ruff format --check . -> 30 files already formatted
$ basedpyright -> 0 errors, 0 warnings, 0 notes

# Teardown
$ ssh deploy@76.13.22.110 'docker exec email-extractor-postgres psql -U postgres -c "DROP DATABASE email_extractor_autogen;"'
DROP DATABASE
$ taskkill //PID 111512 //F  (the ssh -f tunnel)
SUCCESS: The process with PID 111512 has been terminated.
$ netstat -an | grep ':5433'  -> tunnel closed

# Push
$ git push origin HEAD -> c3f7efa..7f43073  HEAD -> main
```

### Plan deviations

(a) **Parent uses `int autoincrement`, not UUIDs.** The prompt's constraint says *"IDs are UUIDs (parent convention)"* — this is factually wrong. Verified by `grep '^\s*id:\s*Mapped' fis-lead-gen/backend/app/models/*.py` returning `int autoincrement` for every domain model. Used `int` to match parent's actual pattern. The merge story is much cleaner this way (rename `ExtractionRun` to `PipelineRun` + set `pipeline_name="email_extractor"` is a one-line swap).

(b) **Smoke-test curls (Step 5) skipped per the unblock plan** — no local backend to hit. Will run against the staging backend in the follow-up VPS-deploy prompt.

(c) **Round-trip integration test is `@pytest.mark.integration` and skipped by default** per the unblock plan. `pytest.ini` `addopts = -m "not integration"` makes `pytest app/tests/` skip 2 tests automatically; explicit `pytest -m integration` runs them.

(d) **basedpyright `reportImportCycles` and `reportUnusedImport` suppressed at config level** rather than per-line `# pyright: ignore`. Reason: the cycle (`db/base.py` → models → `db/base.py`) is structural to SQLAlchemy's declarative-base + relationship pattern, not a code smell. Config-level suppression is more honest than scattering `# noqa: F401  # pyright: ignore[reportUnusedImport]` across every import line. Logged with a comment block in `pyproject.toml` explaining why.

(e) **SSH tunnel needed `127.0.0.1` not `localhost`** for the SQLAlchemy/psycopg URL. `localhost` resolved to `::1` first on Windows and the IPv6 path failed (server_closed unexpectedly), causing alembic to time out on IPv4 fallback. Hard-coded `127.0.0.1` worked. Worth noting if the SSH-tunnel pattern recurs.

(f) **Initial `ssh -f -N -L` tunnel died after the first sanity check on Windows** — needed to be re-opened before running alembic. Probably an idle-timeout or shell-cleanup quirk. Re-opened with the same flags and it stayed up through autogen + reversibility + cleanup. If the tunnel pattern recurs in future prompts, consider `ssh -fN -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes` to keep it warm.

(g) **3 uncommitted files in working tree at end of run** (the two plans + this prompt). Per "one commit, one concern" they aren't included. Cowork can sweep them in a small housekeeping commit.

### Decisions made on the fly

- **Decision:** `int autoincrement` PKs, not UUID.
  - **Alternatives considered:** UUID with Python-side `default=uuid.uuid4` (per prompt instruction); UUID with server-side `gen_random_uuid()`.
  - **Rationale:** Parent uses int across the board for domain models. The prompt's claim "parent uses UUIDs" is empirically wrong. Using int matches actual parent pattern, simplifies test fixtures, and makes the merge a one-line rename. UUIDs would have cost ergonomic test setup + a non-trivial merge translation.
  - **ADR:** inline (this Outcome). If Arvin wants a separate ADR, easy follow-up.

- **Decision:** `String(32)` + `StrEnum` (Python-side enum stored as string), not Postgres-native `ENUM` type.
  - **Alternatives considered:** `SQLEnum(RunStatus, name="extraction_run_status")` which generates a Postgres `CREATE TYPE`.
  - **Rationale:** Matches parent's `PipelineRun` (`String(32)`). Postgres `ENUM` types are painful to migrate (renames require type drop+recreate + column type swap). String + Python-side validation is simpler and what parent uses.
  - **ADR:** inline.

- **Decision:** `selectinload` on `discovered_emails` in the `GET` endpoint and `lazy="selectin"` on the relationships.
  - **Alternatives considered:** Lazy loading with explicit `await session.refresh(scan, ['discovered_emails'])` in the endpoint.
  - **Rationale:** `selectinload` is one extra query that runs eagerly while the session is open — avoids the dreaded "MissingGreenlet: greenlet_spawn has not been called" error if the response model touches a lazy attribute after the session closes. This is the parent-correct pattern for async sessions.
  - **ADR:** inline.

- **Decision:** Aggregator opens its own `SessionLocal()` rather than receiving a session.
  - **Alternatives considered:** Pass `db: AsyncSession` from the endpoint into `background_tasks.add_task(aggregator.run, scan.id, db)`.
  - **Rationale:** `BackgroundTasks` runs after the response is sent, by which time the request-scoped session is closed. The prompt explicitly calls this out; my implementation matches.
  - **ADR:** inline.

- **Decision:** Suppress basedpyright cycles at config not per-line.
  - **Alternatives considered:** `# pyright: ignore[reportImportCycles, reportUnusedImport]` on the model-import line in `db/base.py`.
  - **Rationale:** The cycle is the entire pattern, not one line. Config-level suppression with a clear comment explaining the reason is more honest than line-by-line ignores. Per-line ignores would proliferate as more models land.
  - **ADR:** inline.

### Followups for Cowork

**Highest priority (unblocks staging):**

1. **VPS-deploy prompt for the migration.** Pull on VPS → `docker compose exec backend alembic upgrade head` → `docker compose up --build -d backend` → curl-smoke `POST` + `GET` against `http://76.13.22.110:8000/api/v1/email-extractor/scans` → flip the integration test from skipped to passing. Roughly the shape `prompts/2026-04-19-1049-frontend-public-dir-fix.md` had.

2. **Refresh `CLAUDE.md` §10 codebase map.** Stale on multiple counts now: lines 284/289 still mention `asyncpg` (from prior prompt's deferral); the new models/endpoints/service aren't reflected at all. Run `/init` against §10 only — same Plan-B technique used in the scaffold prompt.

**Medium priority:**

3. **Install Docker Desktop locally.** Every feature prompt now pays the SSH-tunnel-to-VPS cost for autogen + integration tests. One-time setup unblocks all of them.

4. **Add `restart: unless-stopped`** to all three services in `docker-compose.yml` (carried from prior prompts). Now relevant because we have stateful behavior to lose on host reboot.

5. **Capture the SSH-tunnel-for-autogen pattern as a `docs/notes/` entry** if it's expected to recur. Two gotchas: (a) `localhost` → IPv6 path may fail, use `127.0.0.1`; (b) `ssh -fN` may die on Windows — verify with `netstat -an | grep :5433` before each use.

**Lower priority / surfaced surprises:**

6. **`HUNTER_API_KEY` / `APOLLO_API_KEY` / `SNOV_API_KEY` are still blank in VPS .env.** Stub aggregator doesn't need them, but real provider prompts will. Plan a "bring up keys" coordination step before the first provider prompt.

7. **Three uncommitted files** in working tree at end of run (two plans + this prompt). Sweep in next prompt or housekeeping commit.

8. **Aggregator runs as a FastAPI BackgroundTask** — not durable across process restarts. If the backend container restarts mid-run, the row is stuck in `running` forever. Acceptable for staging stub; document as a known limitation when the first real provider lands. Could add a startup task that finds `running` rows older than `running_timeout_seconds` and marks them `failed`.

### Risks / concerns

- **Migration was generated against a throwaway DB on the VPS, not against the live VPS DB.** When the VPS-deploy prompt runs `alembic upgrade head` on the live `email_extractor` DB, it's the first time Postgres at `email-extractor-postgres` sees this migration. Risk is low because the throwaway DB and the live DB are the same Postgres 15 instance with the same encoding/collation, but it's not zero — surface in the deploy prompt's pre-flight.
- **The integration test suite has not been run.** I'm trusting the static analysis. The migration applies cleanly, the models import without error, lint+typecheck are clean, but the actual `POST → GET → poll` chain hasn't been exercised. The deploy prompt is responsible for first-run validation.
- **The `gen_random_uuid()` pattern** the prompt mentions is unused (we went with int IDs); future model prompts that genuinely want UUIDs would need to enable the `pgcrypto` extension. Not a current risk.
- **`addopts = -m "not integration"`** in `pytest.ini` means CI will silently skip integration tests forever unless someone passes `-m integration` explicitly. CI workflow (`.github/workflows/ci.yml`) currently runs `pytest app/tests/` without overrides — so CI sees only the 3 non-DB tests. Not a regression (they're new tests), but worth noting if/when CI grows a "real DB" job.
