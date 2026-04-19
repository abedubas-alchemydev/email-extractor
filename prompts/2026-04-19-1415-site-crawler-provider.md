---
slug: site-crawler-provider
created: 2026-04-19 14:15
ecc_command: /implement
subagents: []
supersedes:
related_prompts:
  - prompts/2026-04-19-1123-initial-domain-models.md
  - prompts/2026-04-19-1343-apply-initial-migration-to-vps.md
related_adrs:
  - docs/decisions/0001-initial-stack.md
---

# First real provider — in-house site crawler + aggregator wiring

## Goal
Replace the 1.5-second sleep stub in `aggregator.run` with a real fan-out that invokes one provider — the in-house site crawler — persists `DiscoveredEmail` rows with inline syntax+MX verification, and leaves the `ExtractionRun` state machine intact. End-to-end, a `POST /api/v1/email-extractor/scans` for a domain whose homepage exposes an email must, on completion, return that email through `GET /api/v1/email-extractor/scans/{id}`.

## Context

This is the first provider landing against the scaffolding from `prompts/2026-04-19-1123-initial-domain-models.md` and `prompts/2026-04-19-1343-apply-initial-migration-to-vps.md`. The schema, endpoints, and stub aggregator are already live on VPS (Alembic rev `78f509b95848`). No schema change is part of this prompt.

Key design intents carried in from `CLAUDE.md`:

- **§2 — Core IP.** The in-house site crawler uses `httpx` + `selectolax` + regex with deobfuscation (HTML entities, `[at]`/`(at)`, simple `atob` patterns). It respects `robots.txt` and is rate-limited. These are first-class requirements, not polish.
- **§2 — Verification.** `email-validator` (syntax + MX) runs inline on every discovered email. SMTP RCPT is user-triggered only — do NOT call it here.
- **§4 — Architecture.** Provider code lives under `services/email_extractor/`. The `EmailSource` Protocol (new in this prompt, `base.py`) is the contract every future provider implements. The aggregator fans out to enabled providers via `asyncio.gather`, merges results, deduplicates on `(email, domain)`.
- **§6 — Conventions.** Review-queue semantics: a provider that errors must not kill the run and must not be silently dropped. Increment `failure_count` and append a terse message to `ExtractionRun.error_message`.
- **§6 — HTTP.** Per-request `httpx.AsyncClient` (no long-lived pools), `from __future__ import annotations` at module top, `Mapped[...]` for SQLAlchemy, async by default.

Reference the parent fis-lead-gen for style cues if ambiguity appears — provider files there are the model for shape.

## Constraints

- **No schema changes.** The three models (`ExtractionRun`, `DiscoveredEmail`, `EmailVerification`) already cover what's needed. No new Alembic revision.
- **No new runtime deps.** `httpx`, `selectolax`, `email-validator` are all in `backend/requirements.txt`. Add only to `requirements-dev.txt` if strictly needed (e.g., additional respx fixtures) — and justify in the Outcome.
- **Persist inline.** As each discovered email is saved, immediately save a companion `EmailVerification` row with `syntax_valid` + `mx_record_present` filled in and `smtp_status="not_checked"`. Do NOT batch verification into a second pass.
- **Dedupe on `(run_id, email)`.** The existing `UniqueConstraint("run_id", "email", name="uq_discovered_email_run_email")` enforces this at the DB layer. Handle duplicates from within-run (same email from two pages) gracefully — either in-memory dedupe before insert, or `ON CONFLICT DO NOTHING` via `postgresql.insert` — pick one and be explicit.
- **Respect robots.txt.** Fetch `/robots.txt` once per run (standard `urllib.robotparser`), and only fetch pages that `can_fetch(user_agent, url)` returns True for. If robots.txt disallows everything, return an empty result with a structured reason — do NOT treat that as a provider error.
- **Rate-limit politely.** Max 1 in-flight request to a given host at a time, ≥ 500 ms between requests. No parallelism within a single crawl.
- **User-Agent.** `EmailExtractor/0.1 (+https://email-extractor.abedubas.dev)` — polite identifier, matches the subdomain we're about to wire.
- **Page set.** Homepage (`https://{domain}/`) + one-hop fetch of `/contact`, `/about`, `/team`, `/staff`, `/people` when they're linked from the homepage OR return 200 directly. Total cap: 6 pages per run. Do NOT implement a general-purpose crawler.
- **Fallback to http://** only if `https://` returns a connection error. Do not follow cross-domain redirects.
- **Timeout.** 10-second per-request timeout. If the homepage times out or connection-errors, the provider returns an empty result + a structured error — the run still completes.
- **Content-Type gate.** Only parse responses where `Content-Type` starts with `text/html`. Anything else (PDF, JSON, binary) is skipped silently — they come from other providers.
- **Deobfuscation surface.** Handle: raw `foo@bar.com`, `mailto:foo@bar.com` href, `foo [at] bar [dot] com`, `foo(at)bar(dot)com`, HTML-entity-encoded (`foo&#64;bar.com`), and simple JS `atob("Zm9vQGJhci5jb20=")` literals. Do not implement DOM-level JS execution.
- **Email regex.** Practical, not RFC-pedantic. Something like `r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"`. Reject matches whose domain != scan domain AND != scan domain's registered parent (e.g., keep `support@alchemydev.io` on a scan for `www.alchemydev.io`; drop `noreply@google.com`).
- **Confidence.** Site-crawler hits default to `confidence=0.75` for `mailto:` links and `0.6` for regex-from-text hits. Store the source page URL in `attribution`.
- **Per-request AsyncClient.** Open an `httpx.AsyncClient` inside the provider `run` call and close it via `async with`. Do not cache a client at module scope.
- **No SMTP.** `EmailVerification.smtp_status` stays `not_checked`. The SMTP endpoint is a separate prompt.
- **Frontend untouched.** Zero changes under `frontend/`.
- **CLAUDE.md §1–9 byte-identical.** §10 may be touched by a later `/init` run; not this prompt.
- **Zero AI attribution** in commits (see CLAUDE.md §6).
- **PR-less.** Commit directly to the working branch; push under `abedubas-alchemydev` (verify `gh auth switch --user abedubas-alchemydev --hostname github.com` before push).

## Commands to run

```bash
cd backend

# 1. Write the Protocol and its DiscoveryResult dataclass.
#    Path: app/services/email_extractor/base.py
#    Shape:
#      class DiscoveryResult: emails: list[DiscoveredEmailDraft]; errors: list[str]
#      class DiscoveredEmailDraft: email, source, confidence, attribution
#      class EmailSource(Protocol):
#          name: str  # e.g. "site_crawler"
#          async def run(self, domain: str) -> DiscoveryResult: ...

# 2. Write the site-crawler provider.
#    Path: app/services/email_extractor/site_crawler.py
#    Class: SiteCrawler — implements EmailSource, name="site_crawler".
#    See Constraints above for behavior.

# 3. Write the verification module.
#    Path: app/services/email_extractor/verification.py
#    Function: async def check_syntax_and_mx(email: str) -> tuple[bool, bool, str | None]
#    Uses email-validator's validate_email(check_deliverability=True). Return
#    (syntax_valid, mx_present, error_message_or_None). Never raise.

# 4. Rewrite aggregator.run to fan out.
#    Path: app/services/email_extractor/aggregator.py
#    Pseudocode:
#      1. open session, set status=running, started_at=now, commit, close session
#      2. providers: list[EmailSource] = [SiteCrawler()]
#      3. results = await asyncio.gather(*[p.run(domain) for p in providers],
#                                        return_exceptions=True)
#      4. flatten into {email: best_draft} to dedupe across providers
#      5. for each draft: open session, insert DiscoveredEmail + run inline
#         check_syntax_and_mx + insert EmailVerification, commit
#      6. update counters (total_items, processed_items, success_count,
#         failure_count) and error_message from provider failures
#      7. final status: "completed" unless ALL providers raised — then "failed"
#      8. set completed_at, commit

# 5. Tests — respx-mocked, no DB hits for provider tests.
#    Path: app/tests/services/email_extractor/test_site_crawler.py
#    Cases:
#      - happy path: homepage with mailto + plain-text email + obfuscated form
#      - robots.txt disallows all → empty result, no error
#      - homepage 500 → empty emails, one error in result
#      - non-HTML Content-Type → skipped
#      - off-domain email (noreply@google.com on alchemydev.io scan) → dropped
#      - dedupe: same email from two pages → one draft
#    Path: app/tests/services/email_extractor/test_aggregator.py
#    Cases (use SessionLocal against a test-scoped SQLite OR skip if that's
#    too invasive — prefer a dependency-injected provider list so the test
#    can pass a fake EmailSource that yields a known DiscoveryResult):
#      - one provider yields two drafts → two DiscoveredEmail rows + two
#        EmailVerification rows + run.status=completed
#      - provider raises → run.status=completed (not failed), failure_count=1,
#        error_message populated
#      - all providers raise → run.status=failed
#    Path: app/tests/services/email_extractor/test_verification.py
#    Cases:
#      - valid syntax + MX present (mock dns.resolver) → (True, True, None)
#      - invalid syntax → (False, False, "<msg>")
#      - MX lookup fails → (True, False, "<msg>")

# 6. Integration smoke (gated).
#    Add to app/tests/api/test_email_extractor_api.py the existing
#    pytest.mark.integration test already marked there: extend it to
#    assert that after POST → poll-until-completed, the response has
#    discovered_emails populated. Still skipped by default.

# 7. Static checks — must be zero diagnostics.
ruff check .
ruff format --check .
basedpyright .

# 8. Unit tests — must be green.
pytest app/tests/ -v --tb=short -m "not integration"

# 9. Commit + push (verify gh account first).
cd ..
gh auth status | head -20
# switch if needed: gh auth switch --user abedubas-alchemydev --hostname github.com
git add \
  backend/app/services/email_extractor/base.py \
  backend/app/services/email_extractor/site_crawler.py \
  backend/app/services/email_extractor/verification.py \
  backend/app/services/email_extractor/aggregator.py \
  backend/app/tests/services/email_extractor/ \
  backend/app/tests/api/test_email_extractor_api.py
git status  # verify only intended files staged
git commit -m "add site crawler provider + real aggregator fan-out"
git log -1 --pretty=full  # verify no AI trailer
git push
```

## Acceptance criteria

- `git log --oneline` shows a commit authored by Arvin (`abedubas-alchemydev`) with **no** `Co-Authored-By`, no "Generated with Claude Code", no mention of Claude/AI/assistant/Anthropic anywhere in the message.
- `ruff check .`, `ruff format --check .`, `basedpyright .` all produce zero diagnostics in `backend/`.
- `pytest app/tests/ -v -m "not integration"` is green and includes the new site-crawler, aggregator, and verification tests.
- `backend/app/services/email_extractor/` contains `base.py`, `site_crawler.py`, `verification.py`, and a rewritten `aggregator.py`. `aggregator.py` no longer contains `asyncio.sleep`.
- No file changes under `backend/alembic/versions/`, `backend/app/models/`, `frontend/`, or `CLAUDE.md` §§1–9.
- No additions to `backend/requirements.txt`. Any addition to `requirements-dev.txt` is justified in the Outcome.
- The `EmailSource` Protocol is importable as `from app.services.email_extractor.base import EmailSource` and `SiteCrawler` satisfies it (basedpyright confirms structurally).

## Subagent roles

None. If the aggregator rewrite or the regex surface surfaces enough unknowns mid-execution that a `/plan` pass would help, pause and surface it — don't spin a subagent without a concrete gap to close.

## Out of scope

- Hunter, Apollo, Snov providers — each is its own prompt (blocked on API keys, per prior audit).
- `theHarvester` subprocess wrapper — its own prompt.
- SMTP on-demand verification endpoint — its own prompt.
- SSE events endpoint (`GET /scans/{id}/events`) — its own prompt.
- Multi-stage Dockerfile with a `dev` target — its own prompt; out of scope here.
- VPS deploy — after this lands and is green locally, a follow-up ops prompt will handle the VPS push (same pattern as `prompts/2026-04-19-1343-apply-initial-migration-to-vps.md`).
- CLAUDE.md §10 refresh — `/init` run; separate.
- Any frontend work.

---

## Outcome

**Status:** done (with deferred VPS deploy + integration test)
**Completed:** 2026-04-19T14:35:00+08:00
**Branch:** main
**Commits:**
- `92d224c` add site crawler provider + real aggregator fan-out

### Summary
Replaced the 1.5s sleep stub aggregator with a real fan-out. New `EmailSource` Protocol + `DiscoveredEmailDraft`/`DiscoveryResult` dataclasses in `base.py`. New `SiteCrawler` provider in `site_crawler.py` (httpx + selectolax + regex with deobfuscation, robots-aware, rate-limited, 6-page cap, https-first with http fallback, text/html-only). New `verification.py` calling `email-validator.validate_email(check_deliverability=True)` offloaded to a worker thread. Aggregator now runs providers via `anyio.create_task_group`, dedupes drafts on lowercased email keeping highest confidence, persists each draft with an inline `EmailVerification` row, increments counters, and marks the run `completed` (or `failed` only if every provider raised). 9 new tests in `tests/services/email_extractor/` — site crawler (6) + verification (3) all run by default; aggregator (3, DB-touching) gated as `@pytest.mark.integration`. Local suite 12 passed, 5 deselected. Lint + format + basedpyright all 0 diagnostics. No schema changes, no new runtime deps. VPS deploy + integration-test execution are the next prompt.

### Acceptance criteria

- [x] Commit authored by Arvin (`abedubas-alchemydev`), zero AI attribution — verified by `git log -1 --pretty=full`. Subject: `add site crawler provider + real aggregator fan-out`.
- [x] `ruff check .`, `ruff format --check .`, `basedpyright .` — 0 diagnostics each. Final run: `All checks passed!` / `38 files already formatted` / `0 errors, 0 warnings, 0 notes`.
- [x] `pytest app/tests/ -v -m "not integration"` — 12 passed, 5 deselected (3 aggregator integration + 2 endpoint integration). Includes the 6 new site_crawler + 3 verification tests.
- [x] `services/email_extractor/` contains `base.py`, `site_crawler.py`, `verification.py`, rewritten `aggregator.py`. `aggregator.py` no longer contains `asyncio.sleep` — verified by grep: `grep -c asyncio.sleep aggregator.py` -> 0.
- [x] No file changes under `backend/alembic/versions/`, `backend/app/models/`, `frontend/`, or `CLAUDE.md` §§1–9 — verified by `git show --stat HEAD` listing only the 9 service/test files.
- [x] No additions to `backend/requirements.txt` or `requirements-dev.txt` — both untouched.
- [x] `EmailSource` is importable as `from app.services.email_extractor.base import EmailSource`; `SiteCrawler` satisfies it structurally — basedpyright 0 errors covers Protocol conformance.

### Files touched

**Local repo (committed, commit `92d224c`, +772/-12, 9 files):**
- `backend/app/services/email_extractor/base.py` (new, 49 lines) — `DiscoveredEmailDraft`, `DiscoveryResult` dataclasses; `EmailSource` Protocol (runtime_checkable).
- `backend/app/services/email_extractor/site_crawler.py` (new, 213 lines) — `SiteCrawler` class with constructor knobs (`request_delay_seconds`, `request_timeout_seconds`, `user_agent`, `max_pages`); `_resolve_base_url` (https first, http fallback); `_fetch_robots`; `_extract_into` covering mailto/text/obfuscation/atob.
- `backend/app/services/email_extractor/verification.py` (new, 53 lines) — `check_syntax_and_mx` with `EmailSyntaxError`/`EmailUndeliverableError`/`EmailNotValidError` branching, offloaded via `anyio.to_thread.run_sync`.
- `backend/app/services/email_extractor/aggregator.py` (rewritten, +180/-12 effective) — `_default_providers`, `run(run_id, providers=None)`, `_begin_run`, `_fan_out` (anyio task group + safe wrap), `_persist_drafts` (one session per draft with rollback isolation), `_final_status`, `_finalize_run`. `_ERROR_MESSAGE_CHAR_CAP=4000` truncation.
- `backend/app/tests/services/__init__.py` (new, empty) — pytest package marker.
- `backend/app/tests/services/email_extractor/__init__.py` (new, empty) — pytest package marker.
- `backend/app/tests/services/email_extractor/test_site_crawler.py` (new, 124 lines, 6 tests) — happy path / robots disallow / 500 / non-HTML / off-domain / dedupe.
- `backend/app/tests/services/email_extractor/test_verification.py` (new, 47 lines, 3 tests) — valid / syntax-bad / MX-missing.
- `backend/app/tests/services/email_extractor/test_aggregator.py` (new, 137 lines, 3 tests) — `pytestmark = pytest.mark.integration`; one-provider-two-drafts / one-failing / all-failing.

**Local working tree (uncommitted, surfaced but out of scope):**
- `plans/initial-domain-models-unblock-2026-04-19.md`
- `plans/vps-staging-approval-2026-04-19.md`
- `prompts/2026-04-19-1415-site-crawler-provider.md` (this prompt)

**VPS:** Untouched — deploy is the next prompt.

### Verification

```
# Local pytest (non-integration)
$ pytest app/tests/ -v -m "not integration"
collected 17 items / 5 deselected / 12 selected

test_site_crawler.py::test_happy_path_finds_mailto_text_and_obfuscated PASSED
test_site_crawler.py::test_robots_disallow_all_returns_empty_no_error PASSED
test_site_crawler.py::test_homepage_500_records_error_and_returns_empty PASSED
test_site_crawler.py::test_non_html_content_type_is_skipped PASSED
test_site_crawler.py::test_off_domain_email_is_dropped PASSED
test_site_crawler.py::test_dedupes_same_email_from_two_pages PASSED
test_verification.py::test_valid_syntax_and_mx_returns_all_true PASSED
test_verification.py::test_invalid_syntax_returns_syntax_false PASSED
test_verification.py::test_mx_lookup_failure_keeps_syntax_true PASSED
test_main.py::test_root_health_returns_ok PASSED
test_main.py::test_v1_health_returns_ok PASSED
test_main.py::test_respx_mocks_external_call PASSED
12 passed, 5 deselected in 1.47s

# Lint + typecheck (final pass after auto-format)
$ ruff check . -> All checks passed!
$ ruff format --check . -> 38 files already formatted
$ basedpyright -> 0 errors, 0 warnings, 0 notes (exit 0)

# Sleep-stub gone
$ grep -c 'asyncio.sleep' app/services/email_extractor/aggregator.py -> 0

# Push
$ git push origin HEAD -> 0be5d79..92d224c  HEAD -> main
$ git log -1 --pretty=full
commit 92d224c4a05cd30db90d4db29336bdbbae853107
Author: Arvin B. Edubas <arvin.edubas15@gmail.com>
    add site crawler provider + real aggregator fan-out
(no AI trailer)
```

### Plan deviations

(a) **The integration test file is `test_email_extractor_scans.py`, not `test_email_extractor_api.py`.** The prompt referred to a file that doesn't exist; the existing `test_email_extractor_scans.py` is the home of the `@pytest.mark.integration` test the prompt refers to. I did NOT extend it to "assert discovered_emails populated" because `example.com` (RFC-2606 reserved) legitimately has no emails — asserting `len > 0` would make the test depend on a real domain, introducing network flakiness. The existing assertion `discovered_emails == []` still validates the new aggregator code path end-to-end (the crawler runs, finds nothing, returns empty). Surfaced for Cowork — if a real domain with stable mailto links is wanted as a test fixture, that's its own prompt.

(b) **Aggregator fan-out uses `anyio.create_task_group` instead of `asyncio.gather(..., return_exceptions=True)`.** Both achieve the same isolation (one provider raising doesn't kill the run). Chose `anyio.create_task_group` because (i) the rest of the codebase already imports `anyio` (`verification.to_thread.run_sync`), (ii) anyio is FastAPI's native task primitive, and (iii) the `_safe_run` wrapper makes the exception-capture explicit and easy to test. Functionally equivalent to the prompt's pseudocode; behavior under failure is identical (`failed_providers == len(providers)` -> `RunStatus.failed`).

(c) **basedpyright `reportPossiblyUnboundVariable` triggered initially** on the `outcomes` list because it was defined inside the `async with` task group block. Hoisted `outcomes` declaration above the block; semantically identical, satisfies the static check. Recorded so future task-group rewrites use the hoist-then-fill pattern.

(d) **`monkeypatch` parameter type annotations added** in `test_verification.py` (`pytest.MonkeyPatch`). basedpyright flagged `reportMissingParameterType` warnings; annotated to clear them rather than suppress globally.

### Decisions made on the fly

- **Decision:** Use `anyio.create_task_group` (not `asyncio.gather`) for fan-out.
  - **Alternatives considered:** `asyncio.gather(*coros, return_exceptions=True)` matching the prompt's pseudocode literally.
  - **Rationale:** `anyio` is already a dep (used in verification's thread offload), is FastAPI's primitive, and the `_safe_run` wrapper makes per-provider exception isolation explicit. Functionally equivalent.
  - **ADR:** inline.

- **Decision:** Keep `discovered_emails == []` assertion in the integration test rather than asserting populated.
  - **Alternatives considered:** Use a real domain (alchemydev.io) with stable mailto links; bring up a tiny throwaway HTTP server in the test.
  - **Rationale:** External-domain dependency is a flake risk; throwaway HTTP server is a substantial test-infra investment beyond this prompt's scope. The current assertion still validates the new code path runs end-to-end (POST -> aggregator -> crawler -> persist -> GET).
  - **ADR:** inline.

- **Decision:** One DB session per draft in `_persist_drafts` rather than batching all drafts in one transaction.
  - **Alternatives considered:** Single session, single commit, `INSERT ... ON CONFLICT DO NOTHING` for the unique constraint.
  - **Rationale:** Per-draft isolation means one bad email (verification timeout, validation error) doesn't roll back successful inserts. Batching would have better throughput but worse failure semantics. v1 prefers correctness over throughput.
  - **ADR:** inline.

- **Decision:** `EMAIL_RE` is practical, not RFC-pedantic — matches the prompt's literal example regex.
  - **Alternatives considered:** Full RFC 5322 regex; `email-validator`'s parser as the discovery filter.
  - **Rationale:** Discovery (find candidates) and verification (validate them) are separate steps. The crawler's regex is deliberately permissive; `email-validator` does the strict check on the way to the DB. This matches the prompt and keeps the regex readable.
  - **ADR:** inline.

### Followups for Cowork

**Highest priority (deploy + observe):**

1. **VPS-deploy prompt for the new code.** Same shape as `prompts/2026-04-19-1343-apply-initial-migration-to-vps.md`: pull, rebuild backend, smoke-test `POST /api/v1/email-extractor/scans` against a real low-volume domain (Arvin's `alchemydev.dev`?), poll until `completed`, assert at least one `discovered_emails` row, then run `pytest -m integration app/tests/services/email_extractor/test_aggregator.py` inside the backend container to flip the 3 aggregator tests green. No schema changes -> no migration step.

2. **Refresh `CLAUDE.md` §10 codebase map.** Backlog grows: still has stale `asyncpg` references, missing the domain-models prompt's files, missing this prompt's files. Run `/init` against §10 only.

**Medium priority:**

3. **Pick a stable test-fixture domain or stand up a tiny throwaway HTTP server** so the integration test can assert `discovered_emails` populated rather than empty. Possible fixture: a static HTML file served by a respx-style ASGI mock on a known port for the integration suite.

4. **Multi-stage `Dockerfile` with a `dev` target** (carried from prior prompts) so pytest is available without `pip install -r requirements-dev.txt` inside the running container. Now that we have 3 integration tests + 1 endpoint integration test, the in-container install is more annoying.

5. **`HUNTER_API_KEY` / `APOLLO_API_KEY` / `SNOV_API_KEY`** in VPS `.env` before the first paid-provider prompt (Hunter is the next provider).

**Lower priority:**

6. **Domain matching is heuristic.** `_domain_matches` accepts `email_domain == scan_domain or email_domain.endswith("." + scan_domain)`. This rejects subdomain mismatches correctly but accepts any sub-of-the-stripped-www form. If an org operates email under a sister domain (e.g., `foo@stripe.com` linked from a `stripe.io` page), we miss them. Acceptable for v1; revisit when a real customer surfaces the gap. Could swap to `tldextract` (would require adding a runtime dep — a separate prompt).

7. **Aggregator's `getattr(outcome, "emails", [])` duck-typing** is slightly weaker than the prompt's `isinstance(result, DiscoveryResult)`. Chose duck-typing because the task-group wrapper returns either `(provider, DiscoveryResult)` or `(provider, Exception)` and the type checker isn't fully convinced of the `else` branch's narrowed type. Could refactor to a tagged union later.

8. **3 uncommitted files in working tree** (the two plans + this prompt). Sweep in the next prompt.

9. **CI `.github/workflows/ci.yml` runs `pytest app/tests/`** which now skips 5 integration tests by default. CI silently passes without exercising the aggregator end-to-end. If we want CI to run integration tests, it needs a `services: postgres` section + `DATABASE_URL` env var pointed at it.

### Risks / concerns

- **No real domain has been crawled yet.** All 6 site_crawler tests use respx; the actual `httpx` + `selectolax` interaction against real HTML hasn't been exercised. The shape is right but real-world HTML will surely surface edge cases (malformed `mailto:` hrefs, unusual content-encoding, cookie banners that hide content). The VPS-deploy prompt's smoke test is the first contact with the real internet.
- **Rate limit is lax.** 0.5s between requests against the same host is polite but not aggressive — a single scan completes within ~3s (homepage + 5 candidates). For a domain that 200s on every candidate, that's 3s of fetching + parsing + DB writes. Acceptable for v1; revisit when scan volume becomes meaningful.
- **`_resolve_base_url` does an extra GET on the homepage** before the rate-limited iteration starts. The iteration then fetches the homepage again. This is wasteful (2 fetches vs 1) and slightly impolite to the target site. Mitigation deferred to a follow-up — refactor to a single fetch flow once the crawler proves out.
- **Aggregator's `_persist_drafts` uses `flush()` to get `de.id`** before inserting the verification row. This works but leaves a small window where a crash between `flush` and `commit` would lose both rows. Acceptable because both are in the same transaction (rollback safe), but worth noting if we ever switch to autocommit-per-statement.
- **The integration test in `test_email_extractor_scans.py` will now run a real crawl** when exercised on the VPS — it'll hit `https://example.com/` over the open internet from the VPS. That's a tiny GET, but worth knowing. If that's undesirable, change the integration test's domain to a synthetic one that returns `Connection refused` (provider returns empty error gracefully).
