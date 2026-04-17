#!/bin/bash

# Gnosis PATH Registration Script
# Updates shell profiles to point to monorepo service commands.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_SCRIPTS="$ROOT_DIR/scripts"
EMBEDDING_BIN="$ROOT_DIR/services/embedding/.venv/bin"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

update_profile() {
    local profile_file=$1
    if [ ! -f "$profile_file" ]; then
        return
    fi

    echo -e "Updating ${BLUE}$profile_file${NC}..."

    # 1. Backup
    cp "$profile_file" "${profile_file}.bak"

    # 2. Remove old localLlm paths (if any)
    # We look for lines containing 'Code/localLlm/scripts' and remove them.
    sed -i '' '/Code\/localLlm\/scripts/d' "$profile_file"
    
    # 3. Check if new paths already exist
    local has_root_scripts=$(grep -F "$ROOT_SCRIPTS" "$profile_file" || true)
    local has_embed=$(grep -F "$EMBEDDING_BIN" "$profile_file" || true)

    if [ -z "$has_root_scripts" ]; then
        echo -e "\n# Gnosis Monorepo: root CLI wrappers" >> "$profile_file"
        echo "export PATH=\"$ROOT_SCRIPTS:\$PATH\"" >> "$profile_file"
        echo "Added root CLI wrappers to PATH."
    fi

    if [ -z "$has_embed" ]; then
        echo -e "\n# Gnosis Monorepo: embedding tools" >> "$profile_file"
        echo "export PATH=\"$EMBEDDING_BIN:\$PATH\"" >> "$profile_file"
        echo "Added embedding tools to PATH."
    fi

    echo -e "${GREEN}✔ Updated $profile_file${NC}"
}

# Supported profiles
PROFILES=( "$HOME/.zshrc" "$HOME/.bash_profile" "$HOME/.bashrc" )

for p in "${PROFILES[@]}"; do
    update_profile "$p"
done

echo -e "\n${GREEN}✨ PATH registration complete.${NC}"
echo -e "IMPORTANT: Please run the following command to refresh your current session:"
echo -e "  ${BLUE}source ~/.zshrc${NC}  (or your respective profile)"
echo -e "\nThen verify with:"
echo -e "  ${BLUE}which gemma4${NC}"
echo -e "  ${BLUE}which bonsai${NC}"
echo -e "  ${BLUE}which bedrock${NC}"
echo -e "  ${BLUE}which openai${NC}"
echo -e "  ${BLUE}which embed${NC}"
