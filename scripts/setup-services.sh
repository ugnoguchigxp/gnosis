#!/bin/bash
set -e

# Gnosis Services Setup Script (Refreshed)
# Handles Python environment setup and tool installation for monorepo services.

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICES_DIR="$ROOT_DIR/services"

echo -e "${BLUE}=== Gnosis AI Local Stack Setup (Monorepo) ===${NC}"

setup_embedding() {
    local service_path="$SERVICES_DIR/embedding"
    echo -e "\n${BLUE}>>> Setting up ${GREEN}embedding${NC}..."
    
    if [ ! -d "$service_path" ]; then
        echo -e "${RED}Error: embedding service not found.${NC}"
        return 1
    fi

    cd "$service_path"
    [ ! -d ".venv" ] && python3 -m venv .venv
    
    echo "Installing embedding dependencies and CLI tools..."
    ./.venv/bin/pip install --upgrade pip setuptools wheel
    if [ -f requirements.lock ]; then
        ./.venv/bin/pip install -r requirements.lock
    else
        ./.venv/bin/pip install -r requirements.txt
    fi
    ./.venv/bin/pip install -e . # This creates the 'embed' and 'e5embed' commands
    
    if [ -f "./.venv/bin/embed" ]; then
        echo -e "${GREEN}✔ embed command created at .venv/bin/embed${NC}"
    else
        echo -e "${RED}Warning: embed command not found after installation.${NC}"
    fi
}

setup_local_llm() {
    local service_path="$SERVICES_DIR/local-llm"
    echo -e "\n${BLUE}>>> Setting up ${GREEN}local-llm${NC}..."

    if [ ! -d "$service_path" ]; then
        echo -e "${RED}Error: local-llm service not found.${NC}"
        return 1
    fi

    cd "$service_path"
    [ ! -d ".venv" ] && python3 -m venv .venv

    echo "Installing local-llm dependencies..."
    ./.venv/bin/pip install --upgrade pip setuptools wheel
    if [ -f requirements.lock ]; then
        ./.venv/bin/pip install -r requirements.lock
    else
        ./.venv/bin/pip install -r requirements.txt
    fi
    
    # Ensure scripts are executable
    chmod +x scripts/*
    
    echo -e "${GREEN}✔ local-llm setup complete.${NC}"
}

# Dependency checks
if ! command -v python3 &> /dev/null; then
    echo -e "${RED}Error: python3 is not installed.${NC}"
    exit 1
fi

# Run setups
setup_embedding
setup_local_llm

echo -e "\n${GREEN}✨ All services have been successfully refreshed!${NC}"
echo -e "You can now run:"
echo -e "  - ${BLUE}bun run verify${NC} to check the integration."
echo -e "  - ${BLUE}scripts/gemma4${NC}, ${BLUE}scripts/bonsai${NC}, or ${BLUE}scripts/bedrock${NC} to start the LLM."
