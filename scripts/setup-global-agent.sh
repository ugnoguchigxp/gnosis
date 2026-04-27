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
- **再利用知識の即時取得**: ルール・教訓・手順・リスクを `search_knowledge` で取得。
- **タスク痕跡の一貫管理**: `start_task` / `record_task_note` / `finish_task` で作業ログを構造化保存。
- **知識注入レビュー**: `review_task` でローカル/クラウドLLMにプロジェクト知識を注入してレビュー品質を安定化。

---

## 2. ツール活用フロー (いつ・何を・どう使うか)

| フェーズ | 推奨ツール | タイミング | アクション / 効果 |
| :--- | :--- | :--- | :--- |
| **1. 初期化** | `initial_instructions` → `activate_project` | **着手直後 (必須)** | プロジェクト状態と推奨次アクションを取得する。 |
| **2. 計画/実装** | `search_knowledge` → `start_task` | 実装前 | 関連知識取得と task trace 開始。 |
| **3. 作業中** | `record_task_note` | 重要判断時 | 再利用可能な知見を最小入力で保存。 |
| **4. レビュー** | `review_task` | レビュー時 | 知識注入レビューを実行し、指摘と要約を得る。 |
| **5. 完了** | `finish_task` | **作業終了時 (必須)** | outcome と learned items を保存する。 |
| **6. 診断** | `doctor` | 不調時 | tool visibility / stale metadata / runtime 健全性を確認。 |

---

## 3. エージェントへのコア指令
- **first-callを守る**: 新規セッションでは `activate_project` を最初の3 call以内に実行する。
- **primary優先**: まずは Agent-First ツール群を使う。
- **互換が必要なときだけ全公開**: legacy クライアント利用時のみ `GNOSIS_MCP_TOOL_EXPOSURE=all` を設定する。
- **跡を残す**: 完了時は必ず `finish_task` を実行する。
EOF

# 3. カレントディレクトリ（プロジェクト）へのポインタファイル生成
create_pointer() {
    local file=$1
    local content=$2
    if [ -f "$file" ]; then
        echo "Updating $file..."
    else
        echo "Creating $file..."
    fi
    echo "$content" > "$file"
}

echo ">>> プロジェクト用ポインタファイルを生成しています..."

# Cursor 用
create_pointer ".cursorrules" "Gnosisを最大限活用するために、作業前に必ず $MASTER_GUIDE を読み、書かれている指針を最優先してください。"

# Claude 用
create_pointer ".clauderules" "Always follow the instructions in $MASTER_GUIDE to utilize the Gnosis memory stack correctly. This is the master rule for this machine environment."

# 一般的な指示書
create_pointer ".ai-rules.md" "# AI Rules for this project\nPlease refer to the global Gnosis manual: $MASTER_GUIDE"

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
Before starting any task, ALWAYS read the global manual at:
$MASTER_GUIDE
Then, use Gnosis tools to ensure a success-driven workflow.
EOF
echo "----------------------------------------------------------"
echo ""
echo "Gnosisと共に、より快適なエージェントライフを！"
