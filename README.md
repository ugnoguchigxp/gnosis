# Gnosis: Vibe Memory & Knowledge Graph MCP Server

Gnosis (グノーシス) は、AIエージェントに長期間の非構造化記憶（Vibe Memory）と、エンティティベースの構造化知識（Knowledge Graph）の両方を備えた「記憶機能」を提供するためのプロジェクトです。
ローカルの Model Context Protocol (MCP) サーバーとして動作し、`llmharness` などのエージェントツールチェーンや、Cline 等のローカルIDE拡張機能から呼び出せるように設計されています。

## 特徴

1. **Vibe Memory (長期的・意味的記憶)**
   - Bun.spawn を経由してローカルの `multilingual-e5-small` (`../embedding` プロジェクト) を利用し、テキストから384次元のベクトルを生成。
   - `pgvector` エクステンションが有効な PostgreSQL 上で、コサイン類似度に基づくベクトル検索を実現します。
   - **高度な検索**: メタデータ (JSONB) による強力なフィルタリング（ハイブリッド検索）をサポート。
   - **セッション分離**: セッションIDを用いた名前空間分離により、複数プロジェクトやエージェントが記憶を混同することを防ぎます。

2. **Knowledge Graph (構造化知識 & Graph RAG)**
   - **Semantic Entity Search**: エンティティ名や内容もベクトル化。正確なIDが不明でも曖昧なクエリから関連ノードを特定できます。
   - **Multi-hop Traversal**: 指定ノードから最大2ホップ先（隣の隣）までの関係性を一括抽出。深い文脈を LLM に提供します。
   - **自律的メンテナンス**: 間違った関係性の削除やエンティティの上書き更新、不要になったメモリの削除（忘却）をサポートします。

3. **Failure Learning Loop (失敗学習ループ)**
   - **構造化された失敗記録**: 「何が失敗し、何回目か、どんなリスクが検出されたか」を scenarioId 単位で追跡。
   - **教訓の再利用**: 失敗エントリと成功パッチを紐付け、将来の同様の失敗時に「過去の解決策」を優先的に RAG コンテキストとして提供します。
   - **類似失敗検索**: セマンティック検索により、微妙に異なるエラーメッセージからも過去の教訓を引き出せます。

4. **KnowFlow (自律的知識獲得エンジン)**
   - **ブラウジング & 解析**: 特定のトピックについて、ウェブ検索と LLM (Gemma 4 等) を組み合わせて根拠（Evidence）を収集。
   - **ナレッジの検証**: 収集されたクレームを、既存の知識グラフと照合して統合。重複や矛盾を自動的に処理します。
   - **非同期タスクキュー**: 大規模な調査を非同期に行うためのタスクキュー（PostgreSQL JSONB）を搭載。

## 技術スタック

* **ランタイム**: Bun / Node.js
* **データベース**: PostgreSQL 16 `pgvector` (Port: 7888)
* **ORM**: Drizzle ORM
* **依存プロジェクト**: `localLlm` (Python MCP Server, 検索・スクレイピング用)

## インストールとセットアップ

### 1. 依存関係のインストール

```bash
bun install
```

### 2. ローカルデータベースの構築

docker-compose を用いてローカルの pgvector 対応 PostgreSQL を立ち上げます。

```bash
docker-compose up -d
```

### 3. 初期設定とマイグレーション

DBコンテナが起動したら、`vector` 拡張機能を有効化し、マイグレーションを適用します。

```bash
bun run db:init
```

*(備考: embeddingを生成するために `../embedding`、ウェブ検索のために `../localLlm` がセットアップされている必要があります)*

## ツールの利用方法 (MCP)

Gnosis は標準入力/標準出力 (stdio) 経由で通信する MCP サーバーとして起動します。

```bash
bun run src/index.ts
```

### 利用可能な主なツール群

#### 記憶・グラフ操作
* **`store_memory`**: 新たな記憶テキストと、抽出したエンティティや関係性をまとめて保存します。
* **`search_memory`**: 質問クエリに関連する Vibe Memory コンテキストをセマンティック検索します。
* **`query_graph`**: エンティティを起点に、周辺の知識構造を探索します（Graph RAG）。
* **`update_graph`**: 既存のナレッジを修正、または関係性を削除します。

#### 知見・失敗学習
* **`record_experience`**: 失敗または成功事例を構造化された教訓として記録します。
* **`recall_lessons`**: 類似する失敗から教訓と解決策を検索します。

#### KnowFlow (自律調査)
* **`enqueue_knowledge_task`**: 特定トピックの調査タスクをキューに投入します。
* **`run_knowledge_worker`**: キューからタスクを取り出して実行し、知識を獲得します。
* **`search_knowledge`**: knowFlow が蓄積した検証済みクレームをテキスト検索します。
* **`get_knowledge`**: トピックに関する詳細な全エビデンスを取得します。

### CLI ユーティリティ

ナレッジエンジンや同期機能を直接操作するためのコマンドです。

*   **`bun run src/knowflow/cli.ts enqueue --topic "..."`**: 調査タスクの投入。
*   **`bun run src/knowflow/cli.ts run-once --handler knowflow`**: ワーカーの単発実行。
*   **`bun run src/scripts/sync.ts`**: 各種エージェントログの同期。

## テストの実行

```bash
# ユニットテスト
bun test

# 型チェック
bun x tsc --noEmit
```
