#!/usr/bin/env bash
set -euo pipefail

# プロジェクトのルートディレクトリとスクリプトディレクトリの絶対パスを取得
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "--- Local LLM Agent PATH Setting Helper ---"

# スクリプトに実行権限を付与
chmod +x "${SCRIPT_DIR}/gemma4"
chmod +x "${SCRIPT_DIR}/ollama-v4"
chmod +x "${SCRIPT_DIR}/bonsai"
chmod +x "${SCRIPT_DIR}/run_openai_api.sh"

# 使用中のシェルを特定
CURRENT_SHELL=$(basename "$SHELL")
PROFILE_FILE=""

case "${CURRENT_SHELL}" in
  zsh)
    PROFILE_FILE="${HOME}/.zshrc"
    ;;
  bash)
    if [[ "$OSTYPE" == "darwin"* ]]; then
      PROFILE_FILE="${HOME}/.bash_profile"
    else
      PROFILE_FILE="${HOME}/.bashrc"
    fi
    ;;
  *)
    echo "Unsupported shell: ${CURRENT_SHELL}"
    echo "Please manually add the following line to your shell profile:"
    echo "export PATH=\"${SCRIPT_DIR}:\$PATH\""
    exit 1
    ;;
esac

echo "Detected shell: ${CURRENT_SHELL}"
echo "Profile file: ${PROFILE_FILE}"

# PATH追加用の行
PATH_LINE="export PATH=\"${SCRIPT_DIR}:\$PATH\""

# すでに登録されているかチェック
if grep -q "${SCRIPT_DIR}" "${PROFILE_FILE}" 2>/dev/null; then
  echo "Success: ${SCRIPT_DIR} is already in ${PROFILE_FILE}."
else
  echo ""
  echo "To use 'gemma4', 'ollama-v4', and 'bonsai' commands from anywhere,"
  echo "add the following line to your ${PROFILE_FILE}:"
  echo ""
  echo "  ${PATH_LINE}"
  echo ""
  
  read -p "Do you want to append this line to ${PROFILE_FILE} now? (y/N): " -n 1 -r
  echo ""
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "" >> "${PROFILE_FILE}"
    echo "# Added by Local LLM Agent setup" >> "${PROFILE_FILE}"
    echo "${PATH_LINE}" >> "${PROFILE_FILE}"
    echo "Success: Added to ${PROFILE_FILE}."
    echo "Please run 'source ${PROFILE_FILE}' or restart your terminal."
  else
    echo "Skipped. Please add it manually if needed."
  fi
fi
