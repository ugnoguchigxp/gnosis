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

## 技術スタック

* **ランタイム**: Bun
* **データベース**: PostgreSQL 16 `pgvector` (Port: 7888)
* **ORM**: Drizzle ORM
* **検証**: Zod
* **Linter/Formatter**: Biome

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
node setup_db.js
bun run db:migrate
bun run db:seed
```

まとめて実行する場合:

```bash
bun run db:init
```

`db:seed` は `__system_seed__` セッションに初期化確認用のマーカー1件だけを投入します。通常のユーザーセッションや実ナレッジには影響しません。

*(備考: embeddingを生成するために、兄弟ディレクトリにあたる `../embedding` 側に `multilingual-e5-small` のローカルモデルとCLIコマンド（`~/.local/bin/embed`）がセットアップされている必要があります。Gnosis は内部でリトライ機構を備えており、一時的な生成失敗にも対応します)*

`drizzle-kit push` を使って作った既存DBを `db:migrate` 運用へ移行する場合は、ローカル開発環境では一度DBを作り直してください（例: `docker-compose down -v && docker-compose up -d` の後に上記手順を再実行）。

## ツールの利用方法 (MCP)

Gnosis は標準入力/標準出力 (stdio) 経由で通信する MCP サーバーとして起動します。以下のコマンドをクライアントに登録してください。

```bash
bun run src/index.ts
```

### CLI ユーティリティ (llmharness 連携等)

`llmharness` などの外部ツールからメモリを直接操作するためのスクリプト群です。

*   **`bun run src/scripts/record-failure.ts --content "..."`**: (旧) 失敗事例を単純な Vibe Memory として記録。
*   **`bun run src/scripts/ingest-verified.ts --content "..."`**: (旧) 検証済みの解決策を保存し、ナレッジグラフへ統合。
*   **`bun run src/scripts/record-experience.ts --scenario-id "..." --type "failure|success" --content "..."`**: (新) 失敗または成功事例を構造化された教訓として記録。
*   **`bun run src/scripts/recall-lessons.ts --query "..."`**: (新) 類似する失敗から教訓と解決策をテキスト形式で出力。

### 利用可能なツール群

* **`store_memory`**: 新たな記憶テキストと、そこから抽出したエンティティや関係性をまとめて保存します。
* **`search_memory`**: 質問クエリからベクトルを生成し、関連する Vibe Memory コンテキストを検索します。メタデータフィルタリングも可能です。
* **`delete_memory`**: 特定の Vibe Memory をID指定で削除します（忘却機能）。
* **`query_graph`**: IDまたは**曖昧な検索クエリ**から起点となるエンティティを特定し、周辺（最大2ホップ）の知識構造を探索します。
* **`update_graph`**: 既存の誤ったナレッジ（関係性等）を削除、またはエンティティの内容を上書き更新します。

## llmharness 連携

`llmharness` 側で `adapters.memory.enabled: true` に設定することで、ネイティブに Gnosis を RAG および学習ソースとして利用できます。

1.  **RAG**: `llmharness` が生成前に `recall.ts` を呼び出し、関連コンテキストを取得。
2.  **学習**: `llmharness` で `commit-memory` コマンドを実行し、検証済みパッチを `ingest-verified.ts` で同期。

旧来の `llmharness:local-llm` ラッパーも引き続き利用可能です。

連携手順は [docs/LLMHARNESS_INTEGRATION.md](/Users/y.noguchi/Code/gnosis/docs/LLMHARNESS_INTEGRATION.md) を参照してください。

## テストの実行

プロジェクトには動作確認用のインテグレーションテストと、Bun のユニットテスト機構が含まれています。

```bash
# ユニットテスト
bun test

# 統合検証（手動テストスクリプト）
bun run src/test.ts
```
