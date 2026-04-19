---
slug: <short-kebab-case-identifier>
created: YYYY-MM-DD HH:MM
ecc_command: /plan            # explicit — e.g. /plan, /implement, /review, /debug
subagents: []                 # optional — e.g. [code-review, testing-strategy]
supersedes:                   # optional — path to a prior prompt this replaces
related_prompts: []           # optional — paths to adjacent/follow-up prompts
related_adrs: []              # optional — paths to ADRs that frame this work
---

# <Short imperative title>

## Goal
<One sentence. What will be true after this runs that isn't true now.>

## Context
<What the executing agent needs to know that isn't obvious from reading the repo.
Link to ADRs, related prompts, relevant services, upstream bugs, prior incidents.
Keep this tight — detail belongs in the referenced documents.>

## Constraints
<What the agent must respect. Use a bulleted list. Examples:
- Don't change the public API shape of `/api/v1/email-extractor/scans`.
- Match existing style (see `services/email_extractor/hunter.py` as reference).
- No schema changes outside a new Alembic revision.
- Preserve review-queue semantics: low-confidence results are stored, not dropped.
- Zero AI attribution in commits (see CLAUDE.md §6).>

## Commands to run
<Literal shell commands, in order. Include the directory each runs from.
Example:
```bash
cd backend
pip install -r requirements.txt
alembic revision --autogenerate -m "add hunter provider"
alembic upgrade head
pytest app/tests/services/email_extractor/test_hunter.py -v
```
>

## Acceptance criteria
<End-to-end-verifiable checks. A fresh agent must be able to run these and agree.
Examples:
- `git log --oneline` shows one or more commits for this task authored by Arvin with no AI trailer.
- `pytest app/tests/` passes with at least the new tests named in the Commands section.
- `curl -s localhost:8000/api/v1/email-extractor/scans -X POST -d '{"domain":"example.com"}'` returns a run_id within 500ms.
- `CLAUDE.md` sections 1–9 are byte-identical to their state before this prompt.
>

## Subagent roles
<If the `subagents` frontmatter lists any, describe what each is responsible for.
Example:
- `code-review` — reviews the final diff before commit; flags any N+1 queries, missing error handling, or spec deviations.
- `testing-strategy` — proposes additional test cases if the initial test suite leaves branches uncovered.
>

## Out of scope
<Anything the agent might be tempted to do but must not, this prompt.
Examples:
- Refactoring `aggregator.py` — separate prompt.
- Adding an Apollo.io provider — separate prompt.
>

---

## Outcome
<!-- Filled in by CC CLI after execution. Do not pre-fill. -->

**Status:** _(succeeded | partial | blocked)_

**Summary:** _(what was done in 2–4 sentences)_

**Commits:** _(SHAs and one-line messages)_

**Deviations from plan:** _(anything done differently from the Commands / Constraints above, and why)_

**Follow-ups:** _(anything discovered during execution that warrants its own prompt — or a pending ADR)_

**Evidence:** _(test output, curl response, screenshot path, etc. — paste or reference)_
