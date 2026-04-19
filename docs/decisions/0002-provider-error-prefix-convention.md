# ADR 0002 — Provider error-message prefix convention

- **Status:** Accepted
- **Date:** 2026-04-19
- **Author:** Arvin
- **Related:** `CLAUDE.md` §4 (Architecture), ADR 0001, `reports/provider-audit-site-crawler-apollo-2026-04-19.md`, PR #2 (`backend/hunter-free-tier-limit-fix`)

## Context

The Email Extractor discovery engine fans out over multiple providers (Hunter, Apollo, Snov, site_crawler, theHarvester) via `aggregator.run(...)`. Each provider may fail in ways that need to surface on the `extraction_run.error_message` column: network errors, plan-limit responses, auth failures, rate-limit responses, parse errors.

During the Hunter live smoke on 2026-04-19 (`prompts/2026-04-19-1945-inject-hunter-key-vps.md`), the `error_message` column on failed runs showed entries like `"hunter: hunter: free-tier plan limit exceeded..."` — a double-prefix. Investigation in PR #2 revealed the cause: both the provider module and the aggregator were prepending `"hunter: "` to error strings. PR #2 picked one ownership site (provider emits bare, aggregator wraps) and fixed Hunter alone.

The fix did not codify the contract. The `site_crawler` provider already conforms (it emits bare strings into `result.errors`), but that is by accident of history, not by rule. The next three providers in the queue — Apollo, Snov, theHarvester — will each be written by a fresh agent context, and each could silently reintroduce the bug.

## Decision

Providers emit bare error messages; the aggregator owns the `<provider>: ` prefix.

Concretely:

1. Provider modules return a `DiscoveryResult` whose `errors: list[str]` contains bare, human-readable messages with **no provider-name prefix**. Example: `"free-tier plan limit exceeded (configured limit=10)"`, not `"hunter: free-tier plan limit..."`.
2. The aggregator, when persisting a provider's errors onto `extraction_run.error_message`, prepends the provider's `name` attribute exactly once: `f"{provider.name}: {msg}"`.
3. Recoverable error categories (plan-limit, rate-limit, auth failure, transient network error) yield a single bare message, zero discovered rows, and MUST NOT raise. The aggregator continues processing other providers.
4. Unrecoverable provider bugs (parse errors, contract violations, unexpected upstream shape) MAY raise; the aggregator logs and continues but does not silently swallow the exception.
5. Subprocess-based providers (theHarvester) follow the same contract: stdout/stderr parsed into the `errors` list, same bare-string shape, no provider prefix.

Enforcement is by code review and by an aggregator-level test that asserts no run's `error_message` contains `"<provider>: <provider>:"` for any registered provider. The test is a follow-up prompt; this ADR does not add it.

## Consequences

### Positive

- Future providers (Apollo, Snov, theHarvester) have a clear, codified rule. No reverse-engineering from reading `hunter.py`.
- Single ownership of the prefix prevents the exact class of bug PR #2 fixed.
- Aggregator-level visibility: all error messages pass through one choke point, so prefix-shape changes (e.g., adding run_id or timestamp) happen in one place.
- Tests can assert the contract generically, not per-provider.

### Negative / trade-offs

- Agents writing new providers must read this ADR. It is not intuitive from the Hunter code alone why the provider does not self-identify — the aggregator's wrapping step is invisible at the provider layer.
- Subprocess providers (theHarvester) have richer error semantics (exit code + stderr + partial stdout) that compress awkwardly into a single string. Reasonable starting point; revisit if theHarvester's error cases become hard to diagnose from string alone.

### Reversibility

Reversible. Moving prefix ownership back to providers is a trivial refactor (sed + aggregator update). The load-bearing constraint is that the prefix be applied exactly once somewhere — which site owns it does not matter architecturally.

## Rejected alternatives

### Providers self-prefix — rejected

"Every provider prepends `<name>: ` to its own errors; aggregator passes through." Intuitive, self-documenting at the provider boundary. Rejected because this is precisely what we had before PR #2, and it yielded the double-prefix bug when aggregator-level formatting was added. The failure mode — invisible at write-time, visible only at DB-read-time — is hard to catch in PR review.

### No prefix at all; rely on a separate `provider_name` column — rejected

Move the provider identity out of the error string entirely and into a column on a dedicated error table. Cleaner data model. Rejected because the current model uses a single `error_message: str` column on `extraction_run`, and expanding to a child table is a schema change that is out of scope for what is fundamentally a formatting concern. Revisit if error-triage UX needs structured fields (counts, categories, retry-safe flags).

### Structured error objects end-to-end — rejected (for now)

Replace `errors: list[str]` with `errors: list[ProviderError]` where `ProviderError` is a Pydantic model with `code`, `category`, `retryable`, `message`. Most expressive. Rejected because current error surfaces (DB column, UI display, log lines) all consume strings; adopting structured objects requires changes across the stack for speculative future value. Revisit if/when we add retry logic or a dedicated error-triage UI.

## References

- `CLAUDE.md` §4 (Architecture — `services/email_extractor/`)
- ADR 0001 (Initial stack) — defines the `EmailSource` Protocol and aggregator pattern
- `reports/provider-audit-site-crawler-apollo-2026-04-19.md` — datapoints showing hunter (post-PR-#2) and site_crawler both already conform
- PR #2 — `backend/hunter-free-tier-limit-fix` (squash-merged as `b07a87d`): the bug fix that motivated this ADR
- `prompts/2026-04-19-2015-hunter-free-tier-limit-fix.md` — prompt that introduced the fix
