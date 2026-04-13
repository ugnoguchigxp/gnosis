#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${GEMMA4_API_HOST:-0.0.0.0}"
PORT="${GEMMA4_API_PORT:-44448}"

if [[ -d "${ROOT_DIR}/.venv" ]]; then
  source "${ROOT_DIR}/.venv/bin/activate"
fi

exec uvicorn api.main:app --host "${HOST}" --port "${PORT}"
