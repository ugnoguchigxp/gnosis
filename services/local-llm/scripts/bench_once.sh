#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL_NAME="${1:-anemll-google-gemma-3-270m-it-ctx4096_0.3.5}"
PROMPT="${2:-日本語で2文だけ自己紹介してください。}"
MAX_TOKENS="${3:-80}"

"${ROOT_DIR}/scripts/run_chat.sh" "${MODEL_NAME}" \
  --prompt "${PROMPT}" \
  --max-tokens "${MAX_TOKENS}"
