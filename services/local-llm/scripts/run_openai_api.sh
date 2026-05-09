#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_ROOT="$(cd "${ROOT_DIR}/../.." && pwd)"
HOST="${GEMMA4_API_HOST:-0.0.0.0}"
PORT="${GEMMA4_API_PORT:-44448}"

if [[ -d "${ROOT_DIR}/.venv" ]]; then
  source "${ROOT_DIR}/.venv/bin/activate"
fi

# Load .env to check if the daemon should be enabled
if [[ -f "${PROJECT_ROOT}/.env" ]]; then
  # Simple grep/sed to extract the value without sourcing the whole file (safer)
  ENABLED=$(grep "^GNOSIS_LOCAL_LLM_ENABLED=" "${PROJECT_ROOT}/.env" | cut -d'=' -f2 | tr -d ' \r\n' || echo "true")
  if [[ "${ENABLED}" == "false" ]]; then
    echo "Gnosis Local LLM is disabled via GNOSIS_LOCAL_LLM_ENABLED in .env. Exiting."
    exit 0
  fi
fi

export PYTHONPATH="${PROJECT_ROOT}:${ROOT_DIR}:${PYTHONPATH:-}"
cd "${ROOT_DIR}"

exec uvicorn api.main:app --host "${HOST}" --port "${PORT}"
