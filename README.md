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

DBコンテナが起動したら、`vector` 拡張機能を有効化し、テーブルスキーマを最新の状態にプッシュします。

```bash
node setup_db.js
bunx drizzle-kit push --force
```

*(備考: embeddingを生成するために、兄弟ディレクトリにあたる `../embedding` 側に `multilingual-e5-small` のローカルモデルとCLIコマンド（`~/.local/bin/embed`）がセットアップされている必要があります。Gnosis は内部でリトライ機構を備えており、一時的な生成失敗にも対応します)*

## ツールの利用方法 (MCP)

Gnosis は標準入力/標準出力 (stdio) 経由で通信する MCP サーバーとして起動します。以下のコマンドをクライアントに登録してください。

```bash
bun run src/index.ts
```

### 利用可能なツール群

* **`store_memory`**: 新たな記憶テキストと、そこから抽出したエンティティや関係性をまとめて保存します。
* **`search_memory`**: 質問クエリからベクトルを生成し、関連する Vibe Memory コンテキストを検索します。メタデータフィルタリングも可能です。
* **`delete_memory`**: 特定の Vibe Memory をID指定で削除します（忘却機能）。
* **`query_graph`**: IDまたは**曖昧な検索クエリ**から起点となるエンティティを特定し、周辺（最大2ホップ）の知識構造を探索します。
* **`update_graph`**: 既存の誤ったナレッジ（関係性等）を削除、またはエンティティの内容を上書き更新します。

## llmharness 連携

`llmharness` の `localLlm` adapter から Gnosis を呼び出すための CLI ラッパーを追加しています。

```bash
bun run llmharness:local-llm -- --prompt "..."
```

連携手順は [docs/LLMHARNESS_INTEGRATION.md](/Users/y.noguchi/Code/gnosis/docs/LLMHARNESS_INTEGRATION.md) を参照してください。

## テストの実行

プロジェクトには動作確認用のインテグレーションテストと、Bun のユニットテスト機構が含まれています。

```bash
# ユニットテスト
bun test

# 統合検証（手動テストスクリプト）
bun run src/test.ts
```
