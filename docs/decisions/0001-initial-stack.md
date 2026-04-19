# ADR 0001 — Initial stack for Email Extractor

- **Status:** Accepted
- **Date:** 2026-04-19
- **Author:** Arvin
- **Related:** `CLAUDE.md` §2 (Stack), §7 (Integration path)

## Context

Email Extractor is a new project with two known facts that dominate its architectural decisions:

1. **Domain purpose.** Given a domain (e.g., `alchemydev.io`), discover all publicly-associated email addresses, attribute each to its source (Hunter API / Apollo API / site crawl / OSINT), optionally verify deliverability via SMTP. Multiple providers run concurrently.
2. **Eventual home.** The project will merge into the sibling project `fis-lead-gen` (broker-dealer clearing intelligence platform, Python 3.11 + FastAPI + Next.js 14 + Postgres + BetterAuth, deployed to GCP Cloud Run with Neon Postgres). The merge is a medium-term certainty, not a hypothetical. Any stack choice that diverges from `fis-lead-gen` will cost an integration tax proportional to how different it is.

Phase-1 discovery with the user additionally established:

- Shape: Web app with UI.
- Lifespan: standalone now; module later (not a throwaway demo).
- Discovery: paid-API-first (Hunter.io primary, Apollo/Snov secondary) with a free in-house site crawler and theHarvester OSINT as fallback. User explicitly asked for research on providers; research is captured in the project notes and informed the rest of this ADR.
- Verification: syntax + MX on every result; SMTP RCPT TO on demand only.
- Persistence: cache results in a local DB.
- Deployment target: self-hosted VPS for standalone; Cloud Run when merged.
- Budget: paid API keys are acceptable from day one.

## Decision

Build the standalone as an architecturally-isomorphic mini-copy of `fis-lead-gen`. The merge path is literal file-copies across four layers — services, models, schemas, one endpoints file — plus a single Alembic revision in the parent DB. Zero refactoring expected on merge day.

Concrete choices:

| Layer | Choice |
|-------|--------|
| Language | Python 3.11 |
| Backend web | FastAPI ≥ 0.135 + Uvicorn |
| DB | Postgres (Docker local, Neon-ready for prod) |
| ORM / migrations | SQLAlchemy 2.0 async (`Mapped[]`) + Alembic |
| Validation | Pydantic v2 + pydantic-settings |
| HTTP client | httpx (per-request `AsyncClient`) |
| Package manager | pip + `requirements.txt` / `requirements-dev.txt` |
| Lint/format | Ruff |
| Typecheck | basedpyright |
| Tests | pytest + pytest-asyncio + respx, `asyncio_mode = auto` |
| Frontend | Next.js 14 App Router + Tailwind + Lucide + TypeScript |
| Job pattern | `ExtractionRun` DB-row pattern (mirrors parent's `PipelineRun`) |
| Auth (standalone) | Single `EMAIL_EXTRACTOR_API_KEY` Bearer dependency |
| Auth (after merge) | BetterAuth session dependency (swap one `Depends(...)` call site) |
| Deployment | Docker Compose (local) → Cloud Run-ready Dockerfile |
| CI | GitHub Actions: ruff + basedpyright + pytest + `next lint` + `next build` |

### Discovery engine architecture

Provider-pattern under `backend/app/services/email_extractor/`. Each provider implements an `EmailSource` Protocol with a single async method that yields `DiscoveredEmail` results. `aggregator.run(db, domain, ...)` fans out to all enabled providers via `asyncio.gather`, merges and deduplicates, scores confidence, and writes results progressively to the DB so the UI can stream progress.

Providers in scope for v1:

1. **Hunter.io** — primary, paid. Domain-search endpoint.
2. **Apollo.io** — secondary, paid (generous free tier).
3. **Snov.io** — optional tertiary.
4. **In-house site crawler** — `httpx` + `selectolax` + regex with deobfuscation, respects `robots.txt`, rate-limited.
5. **theHarvester** — subprocess wrapper; pulls from crt.sh, PGP keyservers, search engines, GitHub code search.

### Verification

Two-layer: `email-validator` (syntax + MX) runs inline on every discovered email; `py3-validate-email` (SMTP RCPT TO) runs on explicit user action. Verification results are persisted as `EmailVerification` rows.

## Consequences

### Positive

- **Merge is near-trivial.** File-copy + one Alembic revision + swap an auth Depends. No translation layer.
- **No hidden coupling.** The core discovery engine (`services/email_extractor/`) is a pure service module — no HTTP, no auth, no UI dependencies. It can be imported and driven by a script, an HTTP endpoint, or a test.
- **Provider pattern is open.** Adding a fourth provider is one file + one test file; aggregator and endpoints unchanged.
- **Single task-execution model** (`ExtractionRun` DB row + FastAPI background task) matches parent's existing ops muscle memory. No new infra to learn or run.

### Negative / trade-offs

- **Postgres everywhere, including dev** — requires Docker running locally. We pay the Docker-Desktop-on-Windows cost rather than the Alembic-diverges-on-Postgres-at-merge-time cost. The trade-off favors correctness.
- **Pip + requirements.txt is slower than uv.** Local install times will be noticeably slower; acceptable for a standalone that is regenerated rarely. uv can still be used for local installs against the same pin file.
- **BackgroundTasks aren't a durable queue.** If the FastAPI process dies mid-scan, in-flight work is lost. Acceptable for v1 because `ExtractionRun` rows record state up to the last DB flush and can be resumed manually. Revisit if scans become multi-hour or if operations requires automated retry.
- **SMTP verification is unreliable by design.** Gmail/O365 and similar will block or lie on RCPT TO. The "inconclusive" verification status and rate-limiting mitigate this; users must understand verification is advisory, not definitive. Documenting this in the UI copy is a requirement, not an option.
- **API keys are a hard dependency for the primary discovery layer.** Without a Hunter or Apollo key, coverage drops to site-crawl + OSINT only. Document this clearly in `README.md` and `.env.example`.

### Reversibility

- Swapping Ruff/basedpyright is a 30-minute job (config + CI).
- Swapping `BackgroundTasks` for `arq` or Celery is a 1–2 day job if it becomes necessary; the `aggregator.run(...)` signature is queue-agnostic.
- Swapping the frontend framework would be a rewrite. **This is the least reversible decision** and is deliberately aligned with the parent to avoid that pain.

## Rejected alternatives

### Python 3.12 — rejected
More recent, marginally faster in some workloads. But `fis-lead-gen` is on 3.11. Version drift would require either a parent bump (out of scope for an email-extractor project) or a downgrade at merge time (carrying forward any 3.12-only syntax).

### `uv` as the canonical package manager — rejected
Dramatically faster installs, excellent lockfile story. But parent uses pip + `requirements.txt`. We can still use `uv pip install -r requirements.txt` locally for the speedup — that preserves the format without diverging.

### HTMX + Jinja2 server-rendered UI — rejected
Would ship faster for a solo dev. But parent frontend is Next.js, and the standalone-to-module conversion would require a full frontend rewrite. The Next.js frontend in this repo becomes, at merge time, a set of routes under `app/(app)/email-extractor/` in the parent — no framework change.

### `arq` / Celery task queue — rejected
Durable jobs survive process restarts. But parent project handles long-running pipelines with a DB-row pattern (`PipelineRun` + `async def run(...)` + `scripts/run_*.py` as manual/cron entry points), not a queue. Matching that pattern is more valuable than durability gains for v1 scan volumes.

### SQLite for dev, Postgres for prod — rejected
Zero-setup dev experience. But Alembic revisions generated against SQLite can fail to replay cleanly against Postgres (column-type mismatches, constraint semantics). Parent avoids this by running Postgres in Docker locally. We match.

### Django or Flask backend — rejected
Django's admin and ORM are mature; Flask is minimal. But parent is FastAPI, and FastAPI's async fan-out is a direct fit for a discovery engine that concurrently hits 4+ external providers.

### Put the module directly into `fis-lead-gen` on day one — considered, rejected for now
Would skip the merge step entirely. But standalone development is faster to iterate — parent stack requires SEC / FINRA data-loader environment, full BetterAuth flow, GCP identity tokens, etc. Standalone phase buys a clean, lightweight dev loop. Reopen this decision if the standalone timeline extends past two sprints.

## References

- `CLAUDE.md` sections 1, 2, 4, 7
- Parent project reference: `C:\Users\DSWDSRV-CARAGA\Desktop\Projects\fis-lead-gen` (`backend/app/services/pipeline.py`, `backend/app/models/pipeline_run.py`, `backend/requirements.txt`, `backend/app/main.py` for patterns to mirror)
- Provider research (in Phase 2 discovery): Hunter.io, Apollo.io, Snov.io, theHarvester, email-validator, py3-validate-email
