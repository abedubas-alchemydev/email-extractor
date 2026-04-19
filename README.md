# Email Extractor

Given a domain (e.g., `alchemydev.io`), discover all publicly-associated email addresses, attribute each to its source (Hunter.io / Apollo.io / Snov.io / in-house site crawler / theHarvester OSINT), and optionally verify deliverability via SMTP. Multiple discovery providers run concurrently; results are merged, deduplicated, and scored for confidence.

This standalone web app is the iteration sandbox for what will later become a module inside [`fis-lead-gen`](../fis-lead-gen/) — a broker-dealer clearing intelligence platform. Architecture, conventions, and the eventual merge path are documented in [`CLAUDE.md`](./CLAUDE.md) and [`docs/decisions/0001-initial-stack.md`](./docs/decisions/0001-initial-stack.md).

## Quickstart

```bash
docker-compose up --build                                       # full stack: postgres + backend :8000 + frontend :3000
cd backend && pytest                                            # backend unit tests
cd frontend && npm run dev                                      # frontend dev server :3000
python -m scripts.run_email_extraction --domain example.com     # CLI scan (added in a later prompt)
```

## Project layout

```
backend/    FastAPI + SQLAlchemy 2.0 async + Alembic
frontend/   Next.js 14 App Router + Tailwind + Lucide
scripts/    CLI entry points and helper shell scripts
docs/       Architecture decisions and design notes
plans/      Plan files written before each /plan-driven task
prompts/    Prompt files executed by Claude Code CLI
reports/    Audit, analysis, and verification reports
```

## Working protocol

This repo uses a **prompt-file-driven workflow**: every change is described in `prompts/<timestamp>-<slug>.md`, executed by the Claude Code CLI, and its outcome recorded in the prompt file's `## Outcome` section. Direct edits from chat are not allowed. See [`CLAUDE.md`](./CLAUDE.md) §5 for the full protocol and §6 for commit conventions (zero AI attribution).

## Status

Scaffold-only. Provider implementations, the discovery aggregator, the `/email-extractor` UI route, and the first Alembic revision are deliberately deferred to follow-up prompts.
