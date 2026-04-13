#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_MODEL="anemll-google-gemma-3-270m-it-ctx4096_0.3.5"
MODEL_NAME="${DEFAULT_MODEL}"

if [[ $# -gt 0 && "${1}" != -* ]]; then
  MODEL_NAME="$1"
  shift
fi

MODEL_DIR="${ROOT_DIR}/models/${MODEL_NAME}"

if [[ ! -d "${ROOT_DIR}/.venv" ]]; then
  echo ".venv not found. Run ./scripts/setup.sh first." >&2
  exit 1
fi
if [[ ! -d "${MODEL_DIR}" ]]; then
  echo "Model not found: ${MODEL_DIR}" >&2
  echo "Run ./scripts/setup.sh (or pass the same model repo) first." >&2
  exit 1
fi

source "${ROOT_DIR}/.venv/bin/activate"
cd "${MODEL_DIR}"

exec python chat.py --meta ./meta.yaml "$@"
