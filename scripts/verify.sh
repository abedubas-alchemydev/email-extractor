#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
(cd backend && ruff check . && ruff format --check . && basedpyright && pytest app/tests/ -v)
(cd frontend && npm run lint && npm run build)
