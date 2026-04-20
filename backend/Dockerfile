FROM python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# theHarvester — free OSINT email/hostname discovery (CLAUDE.md §2).
# Installed via pipx so its ~50 transitive deps live in an isolated venv,
# keeping the backend venv clean. PIPX_BIN_DIR=/usr/local/bin puts the
# binary on the system PATH without relying on $HOME/.local/bin being exported.
# Pinned to a resolved commit SHA so the build is reproducible.
# Tag 4.6.0 -> SHA d36e326f7738c821900332af3f058c60e69149a3 (resolved via git ls-remote).
ARG THEHARVESTER_REF=d36e326f7738c821900332af3f058c60e69149a3
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir pipx \
    && PIPX_BIN_DIR=/usr/local/bin PIPX_HOME=/opt/pipx \
       pipx install "git+https://github.com/laramies/theHarvester.git@${THEHARVESTER_REF}" \
    && theHarvester --help > /dev/null 2>&1 || (echo "theHarvester smoke-test failed" && exit 1)

# Copy application code
COPY . .

EXPOSE 8000

# Cloud Run injects $PORT at runtime; default to 8000 for local docker-compose.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
