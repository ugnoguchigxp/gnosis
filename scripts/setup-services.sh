#!/bin/bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUN_COMMAND="${GNOSIS_BUN_COMMAND:-bun}"
LOCAL_LLM_ROOT="${GNOSIS_LOCAL_LLM_PATH:-$ROOT_DIR/../local-llm}"
if [[ "$LOCAL_LLM_ROOT" != /* ]]; then
  LOCAL_LLM_ROOT="$ROOT_DIR/$LOCAL_LLM_ROOT"
fi

echo -e "${BLUE}=== Gnosis External Runtime Setup ===${NC}"
echo -e "Target local-llm root: ${GREEN}$LOCAL_LLM_ROOT${NC}"

if [ ! -x "$LOCAL_LLM_ROOT/scripts/setup.sh" ]; then
  echo -e "${RED}Error: $LOCAL_LLM_ROOT/scripts/setup.sh was not found.${NC}"
  echo -e "Set ${BLUE}GNOSIS_LOCAL_LLM_PATH${NC} or clone local-llm next to gnosis."
  exit 1
fi

echo -e "\n${BLUE}>>> Installing external local-llm runtime dependencies${NC}"
"$LOCAL_LLM_ROOT/scripts/setup.sh"

echo -e "\n${BLUE}>>> Registering embed command path${NC}"
"$ROOT_DIR/scripts/register-path.sh"

echo -e "\n${BLUE}>>> Validating external runtime wiring from gnosis${NC}"
"$BUN_COMMAND" run bootstrap:local-llm

echo -e "\n${GREEN}✔ External runtime setup complete.${NC}"
