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

Gnosisは、AIエージェントにプロジェクト固有の「成功体験」と「制約」を提供し、汎用的な推論を**「プロジェクトに特化した熟練の判断」**へと昇華させるための外部脳です。

## 1. Gnosisを使う意義
- **成功の再現**: 過去に高い信頼度（Confidence）で達成された「王道（Golden Path）」を特定し、無駄な試行錯誤を排除する。
- **失敗の回避**: 過去の地雷（Failure）を事前に把握し、同じエラーの再発を物理的に防ぐ。
- **自律的成長**: 作業結果をフィードバックすることで、エージェント自身のスキルをプロジェクト資産として蓄積する。

---

## 2. ツール活用フロー (いつ・何を・どう使うか)

| フェーズ | 推奨ツール | タイミング | アクション / 効果 |
| :--- | :--- | :--- | :--- |
| **1. 計画** | `query_procedure` | **着手前 (必須)** | 目標に対する「王道手順」と「地雷（制約）」を全取得し、計画に反映する。 |
| **2. 実装** | `recall_lessons` | エラー/難所 | 過去の類似失敗から解決策を検索し、無駄な調査を省く。 |
| | `store_memory` | 重要決定時 | 「なぜこの設計にしたか」を記録し、後の学習データ（ADR）とする。 |
| **3. レビュー**| `review` (Stage E) | 実装完了時 | 過去の成功実装をベンチマークとして、今回の修正のリスクを評価する。 |
| **4. 完了** | `record_outcome` | **作業終了時 (必須)** | 手順の成否を記録し、Confidenceを更新。次回の計画精度を向上させる。 |

---

## 3. エージェントへのコア指令
- **迷ったら聞く**: `search_unified` で過去の決定事項を、`search_memory` で過去の議論を検索せよ。
- **守破離**: まずは `query_procedure` の王道に従い、例外的な変更が必要な時のみ独断せよ。
- **跡を残す**: `record_outcome` は未来の自分（および他のエージェント）への最大の貢献である。
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
