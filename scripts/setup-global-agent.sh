#!/bin/bash

# Gnosis Global Agent Setup Script
# ---------------------------------
# どのAIエージェントでもGnosisを正しく使いこなせるよう、
# グローバルな指示書とプロジェクト用ポインタファイルをセットアップします。

set -e

GNOSIS_HOME="$HOME/.gnosis/agent"
MASTER_GUIDE="$GNOSIS_HOME/manual.md"

# 1. グローバルディレクトリの作成
mkdir -p "$GNOSIS_HOME"

# 2. マスターガイドの作成/更新
echo ">>> グローバルマニュアルをセットアップしています: $MASTER_GUIDE"
cat << 'EOF' > "$MASTER_GUIDE"
# Gnosis Agent Quick Guide (GLOBAL)

Gnosisは、AIエージェントにプロジェクト固有の知識とレビュー文脈を提供し、汎用推論を「プロジェクト適合した判断」に変換するMCPサーバーです。

## 1. Gnosisを使う意義
- **再利用知識の即時取得**: タスク文脈に必要なルール・教訓・手順・リスクを `agentic_search` で取得。
- **raw候補の確認**: 語句・ベクトル的に近い候補やスコアを確認する場合だけ `search_knowledge` を使う。
- **知見の保存**: verify 後に再利用可能な rule / lesson / procedure / decision を `record_task_note` で保存。
- **知識注入レビュー**: `review_task` でローカル/クラウドLLMにプロジェクト知識を注入してレビュー品質を安定化。
- **状態診断**: フローや runtime が不明瞭な場合は `doctor` で確認。

---

## 2. ツール種別 (いつ・何を使うか)

| 種別 | いつ使うか |
| :--- | :--- |
| `initial_instructions` | Gnosis の現行ツール方針が不明な時だけ最初に使う。毎タスクの前置きにはしない。 |
| `agentic_search` | 非自明な実装・レビュー・調査で、過去知識や成功/失敗例が判断を変え得る時に使う。`userRequest` に goal、files、changeTypes、intent を含める。 |
| `search_knowledge` | raw候補、スコア、近い語句を直接確認したい時だけ使う。通常回答や方針判断は `agentic_search` を優先する。 |
| `review_task` | コード差分、ドキュメント、計画、仕様、設計をレビューする時に使う。根拠必須なら `knowledgePolicy: "required"` を検討する。 |
| `record_task_note` | verify 後、次回も使える rule / lesson / procedure / decision が得られた時だけ保存する。作業ログ丸ごとは保存しない。 |
| `doctor` | tool visibility、DB、MCP host、metadata、timeout/Transport closed など runtime が怪しい時、または復旧後の確認に使う。 |
| `memory_search` / `memory_fetch` | context 圧縮後に raw memory の具体的根拠が必要な時だけ使う。まず search で候補を見て、必要分だけ fetch する。 |

---

## 3. エージェントへのコア指令
- **最小文脈**: `initial_instructions` は方針が不明な場合だけ呼び、常時の長文注入にしない。
- **主導線優先**: 通常の知識取得は `agentic_search`、raw 候補確認だけ `search_knowledge`。
- **公開面固定**: Gnosis primary MCP surface は `initial_instructions`, `agentic_search`, `search_knowledge`, `record_task_note`, `review_task`, `doctor`, `memory_search`, `memory_fetch`。
- **証跡重視**: 実行可否は実際の tool response、`doctor`、`logs/mcp-host.log`、`logs/mcp-adapter.log` で確認する。
EOF

# 3. カレントディレクトリ（プロジェクト）へのポインタファイル生成
create_pointer() {
    local file=$1
    local content=$2
    local hook_block=""
    if [ -f "$file" ]; then
        echo "Updating $file..."
        if grep -q '<!-- gnosis-hooks:start -->' "$file"; then
            hook_block="$(sed -n '/<!-- gnosis-hooks:start -->/,$p' "$file")"
        fi
    else
        echo "Creating $file..."
    fi
    printf "%b\n" "$content" > "$file"
    if [ -n "$hook_block" ]; then
        printf "\n%s\n" "$hook_block" >> "$file"
    fi
}

echo ">>> プロジェクト用ポインタファイルを生成しています..."

# Cursor 用
create_pointer ".cursorrules" "リポジトリ内の正本ルールは \`AGENTS.md\` です。Gnosis MCP の現行ツール方針が不明な場合だけ $MASTER_GUIDE を参照してください。"

# Claude 用
create_pointer ".clauderules" "Canonical repo-local rules: \`AGENTS.md\` (read and follow first). Refer to $MASTER_GUIDE only when the current Gnosis MCP tool policy is unclear."

# 一般的な指示書
create_pointer ".ai-rules.md" "# AI Rules for this project\n\nCanonical repo-local rules: \`AGENTS.md\` (read and follow first).\nRefer to the global Gnosis manual only when MCP tool policy is unclear: $MASTER_GUIDE"

# 4. 手動設定が必要な箇所の案内
echo ""
echo "=========================================================="
echo "🎉 セットアップ完了！"
echo "=========================================================="
echo ""
echo "⚠️  [手動設定が必要] Cursor Global Settings"
echo "Cursorの 'Rules for AI'（グローバル設定）には、以下のテキストを貼り付けてください："
echo "----------------------------------------------------------"
cat << EOF
You are an expert developer equipped with Gnosis (Autonomous Memory Stack).
Follow the repo-local instructions first. Only when the current Gnosis MCP tool policy is unclear, read:
$MASTER_GUIDE
EOF
echo "----------------------------------------------------------"
echo ""
echo "Gnosisと共に、より快適なエージェントライフを！"
