# 実装計画：vibe_memory 直接検索ツールの追加

## 1. 背景と目的
現在、Gnosis MCP サーバーは構造化された知見（`entities`）を検索するツールを備えていますが、その元データである非構造化メモリ（`vibe_memories`）を直接検索する手段がありません。
ログから知見が蒸留されるまでのタイムラグを埋め、より詳細な「生の会話文脈」をエージェントが参照できるようにするため、直接検索ツールを追加します。

## 2. 変更対象
### 2.1 サービス層 (`src/services/agentFirst.ts`)
- `searchVibeMemories(input: SearchVibeMemoryInput)` 関数の追加。
- `src/services/memory.ts` の `searchMemory` を内部的に呼び出し、MCP ツール向けのレスポンス（スニペット形式）に整形します。

### 2.2 MCP ツール層 (`src/mcp/tools/agentFirst.ts`)
- `search_vibe_memory` ツールの定義。
- **入力スキーマ**:
    - `query` (string, 必須): 検索クエリ。
    - `limit` (number, 任意): 取得件数（デフォルト 5件）。
    - `sessionId` (string, 任意): 特定のセッションに絞り込む場合に使用。指定しない場合は `sync-agent-logs` (自動同期ログ) などを対象とします。

### 2.3 ツール公開設定 (`src/mcp/tools/index.ts`)
- `PRIMARY_TOOL_NAMES` に `search_vibe_memory` を追加し、エージェントが常にこのツールを認識・利用できるようにします。

## 3. 実装のポイント
- **セマンティック検索の活用**: すでに `vibe_memories` はベクトル化されているため、既存の pgvector インデックスを利用した高速な類似度検索を行います。
- **情報の粒度**: 1件あたりの情報量（content）が大きいため、適切なサイズでスニペットとして返し、エージェントが効率的に読み取れるようにします。

## 4. 期待される効果
- 蒸留（整理）プロセスを経ていない、数分前の会話内容まで即座に参照可能になります。
- 構造化ナレッジ（entities）から漏れてしまった、細かな実装の背景や「その場のノリ（vibe）」を反映した対応が可能になる。
