# prompts/

This directory holds **execution prompts** — files that Claude Code CLI reads and executes against this repository. It is the single unit of work for any change: code, config, migrations, docs, or a refactor.

## Workflow at a glance

```
Chat agent           → writes prompts/<file>.md   (this folder)
                       ↓
You open a terminal  → claude "Read prompts/<file>.md and execute it exactly per its instructions."
                       ↓
CC CLI               → plans (/plan), executes, runs tests, commits
                       ↓
CC CLI               → fills in the "Outcome" section at the bottom of the prompt file
                       ↓
Chat agent           → reads the Outcome, plans the next prompt
```

## File naming

```
prompts/YYYY-MM-DD-HHMM-<slug>.md
```

- Date/time stamp uses the moment the prompt is written, not executed.
- Slug is kebab-case and descriptive: `initial-scaffold`, `add-hunter-provider`, `wire-sse-progress`, `fix-mx-record-caching`.
- Prompt files are never renamed once written. If a prompt needs a material change, create a new file that references the old one.
- Prompt files are checked into git. They are the project's audit trail.

## Anatomy of a prompt

Every prompt file starts from [`TEMPLATE.md`](TEMPLATE.md). Required sections:

1. **Goal** — one sentence. What will be true after this runs that isn't true now.
2. **Context** — what the agent needs to know that isn't obvious from reading the repo. Link to ADRs, related prompts, or relevant files.
3. **Constraints** — what the agent must respect. Things that are easy to violate: don't break the public API, don't change schemas outside migrations, match existing style, etc.
4. **Commands to run** — concrete shell commands. Be literal.
5. **Acceptance criteria** — end-to-end-verifiable checks that must pass. "Tests pass" is not enough on its own; name the specific test or behavior.
6. **ECC command** — which ECC entry point drives execution (`/plan`, `/implement`, `/review`, etc.). Named explicitly, not implied.
7. **Subagents** — any named subagents the prompt uses (`code-review`, `debug`, etc.), with their role.
8. **Outcome** (left empty by the author; filled by CC CLI after execution) — what was done, any deviations from plan, commit SHAs, follow-ups for the next prompt.

## Rules

- **One task per prompt.** If you're tempted to list several unrelated changes, write several prompts.
- **No direct source edits from chat.** The chat agent writes the prompt; CC CLI does the work.
- **Every prompt has acceptance criteria.** Not "looks good" — specific checks that a fresh agent can verify.
- **Outcomes are mandatory.** If CC CLI can't complete the task, its Outcome documents *why* and what's needed to unblock it.
- **Decisions that matter get promoted to ADRs** (`docs/decisions/NNNN-<slug>.md`), referenced back from the prompt.

## Directory neighbours

- `plans/` — pre-execution plans when a prompt is complex enough to want the plan on paper before committing to it. Reference the plan from the prompt.
- `reports/` — audits, analyses, debugging narratives, and other long-form findings. Chat agent writes these; prompts link to them.
- `docs/decisions/` — ADRs recording architectural decisions and their rejected alternatives.

## Pruning

Old prompt files stay in git for history. No deletion. If a prompt is fully superseded, note that at the top of the new prompt: `Supersedes: prompts/2026-04-10-1200-original.md`.
