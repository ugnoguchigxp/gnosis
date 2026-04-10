# Gnosis Phase 2: Advanced Graph RAG & Memory Operations

本ドキュメントは、Gnosis の基本的な Vibe Memory および Knowledge Graph 基盤の上に、より高度で自律的なエージェントに必要不可欠な機能を組み込むための実装計画案です。

## 1. 提案機能の概要

1. **Semantic Entity Search (曖昧なグラフ検索)**: エンティティ名や説明文をベクトル化し、完全一致のIDを知らなくても意味から知識グラフの基点を探索できるようにします。
2. **Multi-hop Graph Traversal (多段ホップ探索)**: 単一の「隣のノード」だけでなく、「Aに関連するBに関連するC」といった深い階層の文脈を一括で取得可能にします。
3. **Advanced Memory Operations (忘却とフィルタリング)**: Vibe Memory の削除機能や、メタデータを複合した高度な検索機能を提供します。
4. **Robust Embeddings**: ベクトル生成処理の堅牢化（リトライ機構やバッチ化）を行います。

---

## 2. 実装アプローチと変更点

### Feature A: Semantic Entity Search (エンティティのベクトル対応)

**【課題】** 現在の `query_graph` は、正確な `entityId` ("Tokyo"等) が必要です。しかし、エージェントが「日本の首都に関する知識の起点」を探す際、事前にIDを知っているとは限りません。

**【対応内容】**
- **Schema**: `src/db/schema.ts` の `entities` テーブルに `embedding: vector(384)` カラ​​ムを追加します。
- **Service**: エンティティ保存時 (`saveEntities`) に、`name` と `description` を結合したテキストを基にベクトルを生成して保存します。
- **MCP Tool**: `query_graph` ツールの Input Schema を更新し、`query` という自然言語を受け取るようにします。内部でベクトル検索（コサイン類似度検索）を実行して最も関連するエンティティを決定し、その周辺グラフを返答します。

### Feature B: Multi-hop Graph Traversal (多層ホップ検索)

**【課題】** 現在のグラフ検索は 1ホップ（直接繋がっている関係）のみ抽出しています。より広いコンテキストを得るためには多段階の探索が必要です。

**【対応内容】**
- **Service**: `queryGraphContext` に `depth`（深度パラメータ、デフォルト1、最大3など）を追加します。
- **アルゴリズム**: PostgreSQL の `WITH RECURSIVE` 句を活用したカスタムSQLを Drizzle ORM から実行するか、アプリケーション層から BFS (幅優先探索) スクリプトで動的に最大3階層分のエンティティを走査してツリー状に返却します。

### Feature C: Advanced Memory Operations (Vibe Memory の拡張)

**【課題】** エージェントが間違った情報を学習した場合の削除手段がないこと、また大量のメモリから特定種類の情報を抽出する手段が不足しています。

**【対応内容】**
- **Service**: `deleteMemory(memoryId)` 関数を追加。
- **Service**: `searchMemory` に `filter: Record<string, any>` オプションを追加し、`jsonb` カラム（metadata）の中身を条件に含むハイブリッド検索SQLを追加。
- **MCP Tool**: `delete_memory` ツールを追加。`search_memory` ツールの Schema を更新。

### Feature D: Robust Embeddings

**【課題】** CLI の `embed` プロセスは単発の文字列を前提としており、複数保存時の呼び出しがボトルネックになります。

**【対応内容】**
- **Service**: `Bun.spawn` 実行時のタイムアウト検知と、バックオフ・リトライロジックを実装します。将来的に `../embedding` 側がバッチ引数に対応した場合スムーズに移行できるよう、`generateEmbeddings(texts: string[])` 形式のラッパーを設計します。

---

## 3. ロードマップとタスク一覧

- [ ] **Step 1: データベーススキーマ更新とマイグレーション**
  - `entities` に `embedding` を追加し、`bunx drizzle-kit push` 実行。
- [ ] **Step 2: Backend Services 改修**
  - `graph.ts` (ベクトル生成、マルチホップ処理の実装)
  - `memory.ts` (削除機能、メタデータフィルタの実装、CLIリトライロジック)
- [ ] **Step 3: MCP ツール層の更新**
  - `mcp/server.ts` の各種スキーマ拡張と機能統合。
- [ ] **Step 4: テスト・検証**
  - `src/test.ts` にマルチホップ探索と削除のユースケースを追加して検証。

---

## 決定事項・設計制約

1. **マイグレーション方針（遅延評価の採用）:**
   `entities` テーブルに `embedding` カラムは「NULL許容 (`nullable`)」として追加します。既存の少数のエンティティのために専用の全体更新スクリプトは作成せず、新規追加や更新処理が走った際に初めてベクトルが付与される運用（無停止マイグレーション）とします。
   
2. **多段ホップ探索の安全性（厳格なリミット）:**
   コンテキストの爆発とLLMのハルシネーション（Lost in the middle現象）を防ぐため、探索は**「最大深さ2ホップ」「最大取得ノード15〜20件」**に厳格なリミットを設けます。「さらに深い情報が知りたい場合は、LLMが自律的にもう一度対象IDを指定してツールを実行する」という遅延ロード設計とします。
