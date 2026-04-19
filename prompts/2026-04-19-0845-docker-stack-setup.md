---
slug: docker-stack-setup
created: 2026-04-19 08:45
ecc_command: /plan
subagents: []
related_prompts:
  - prompts/2026-04-19-0840-initial-scaffold.md
related_adrs:
  - docs/decisions/0001-initial-stack.md
---

# Docker stack setup and integration test

## Goal

Verify that the Dockerfiles (`backend/Dockerfile`, `frontend/Dockerfile`) and `docker-compose.yml` authored during the initial scaffold actually build and run a healthy local stack. The `docker-compose up --build -d` acceptance criterion that was deferred from the scaffold prompt is satisfied here. No application code changes — this is an infrastructure verification pass only.

## Context

- This prompt depends on `prompts/2026-04-19-0840-initial-scaffold.md` having completed successfully. Read its Outcome section before planning.
- The scaffold prompt deliberately skipped Docker because Docker was not installed on the target machine at the time. Dockerfiles and compose were still authored as files.
- A container runtime is required to execute this prompt. Any of the following are acceptable:
  - Docker Desktop (Windows) — default choice if already licensed/available.
  - Rancher Desktop — free alternative if Docker Desktop licensing is a concern.
  - Podman Desktop — free; compose support via `podman compose`.
- Architectural constraint from ADR 0001: the Docker backend image must honour `$PORT` (Cloud Run compatibility), and the Next.js image must use `output: 'standalone'` for minimal layer size. Both were authored that way in the scaffold; this prompt verifies them.

## Constraints

- **No application code changes.** If a bug in a Dockerfile or compose file is discovered, fix it within this prompt's scope; anything beyond infrastructure files requires a separate prompt.
- **No new dependencies** in `requirements.txt` / `package.json`.
- **Do not modify `CLAUDE.md` sections 1–9 or §10.** §10 was populated by `/init` in the scaffold prompt and is authoritative until the next `/init` run.
- **Preserve the scaffold's commit hygiene:** stage files by name, no AI attribution, no `--no-verify`, no `git add .`.
- **Pre-flight check first**: run `docker info` (or equivalent for Podman/Rancher). If it fails, **abort the prompt** and record in Outcome that Docker needs to be installed/started before re-running. Do not attempt workarounds.

## Commands to run

### 0. Plan first (ECC)

Use `/plan` to confirm the execution order before running anything. Then proceed.

### 1. Pre-flight

```bash
docker --version
docker info          # fails if daemon isn't running — stop here if so
docker compose version   # Compose V2 is bundled with modern Docker; V1 (`docker-compose`) is deprecated
```

If the machine only has Compose V1 (`docker-compose` binary, not `docker compose` subcommand), note that in Outcome and use `docker-compose` throughout; both should work with the `docker-compose.yml` format we wrote.

### 2. Lint the compose file

```bash
docker compose config > /dev/null      # fails if YAML/schema invalid
```

If this errors, fix the compose file and retry. Record any fix in Outcome → Deviations.

### 3. Build + bring up the stack

```bash
docker compose up --build -d
docker compose ps                       # all services should be "Up" or "Healthy"
docker compose logs --tail=50 backend   # confirm backend started cleanly
docker compose logs --tail=50 frontend  # confirm next build / next start succeeded
```

### 4. Integration smoke test

Allow ~15s after `up -d` for the backend to finish warming and for Postgres to accept connections (there's no application DB call yet so this is mostly Next.js start + Uvicorn start).

```bash
curl -fsS http://localhost:8000/health | grep -q '"status":"ok"'
curl -fsS http://localhost:8000/api/v1/health | grep -q '"status":"ok"'
curl -fsS -o /dev/null -w '%{http_code}\n' http://localhost:3000   # expect 200
```

Capture the three outputs into Outcome → Evidence.

### 5. Tear down + volume cleanup

```bash
docker compose down --volumes
```

### 6. Optional: rebuild-from-cold verification

To ensure there's no caching hiding a broken build, do one clean rebuild:

```bash
docker compose build --no-cache backend
docker compose build --no-cache frontend
```

Both builds must succeed. No need to `up` again.

### 7. Commit

One commit:

- `chore(docker): verify compose stack builds and serves /health on 8000/3000`

Commit body (only if non-trivial fixes were made): list the fixes. Otherwise no body.

Zero AI attribution. Voice: Arvin. Stage files by name.

## Acceptance criteria

- `docker compose up --build -d` brings all services to Up.
- `curl http://localhost:8000/health` returns `{"status":"ok"}` with HTTP 200.
- `curl http://localhost:8000/api/v1/health` returns `{"status":"ok"}` with HTTP 200.
- `curl http://localhost:3000` returns HTTP 200.
- `docker compose down --volumes` exits cleanly and leaves no dangling containers for this project (`docker compose ps -a` empty).
- `docker compose build --no-cache` succeeds for both images.
- `git log --oneline` shows one new commit by Arvin with no AI trailer.
- `CLAUDE.md` is untouched.
- No new dependencies landed in `backend/requirements.txt` or `frontend/package.json`.

## Subagent roles

None.

## Out of scope

- Any business logic — the first real model, any provider, the aggregator. Those are separate prompts after this.
- Production compose (`docker-compose.prod.yml`) — that's a separate prompt tied to the VPS/Cloud Run deploy path.
- TLS / reverse proxy setup — belongs in the deployment prompt.
- Multi-container health checks in `docker-compose.yml` — optional polish, deferrable.

---

## Outcome
<!-- Filled in by CC CLI after execution. Do not pre-fill. -->

**Status:** _(succeeded | partial | blocked)_

**Summary:** _(2–4 sentences)_

**Commits:** _(SHA and message)_

**Deviations from plan:** _(anything done differently from Commands / Constraints, and why)_

**Follow-ups:** _(next prompt suggestions — e.g. "wire first model + Alembic revision", "VPS remote provisioning")_

**Evidence:**

```
# docker compose ps
<paste output>

# curl http://localhost:8000/health
<paste output>

# curl http://localhost:8000/api/v1/health
<paste output>

# curl -o /dev/null -w '%{http_code}\n' http://localhost:3000
<paste output>
```
