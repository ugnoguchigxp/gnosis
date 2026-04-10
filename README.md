# Gnosis: Vibe Memory & Knowledge Graph MCP Server

Gnosis (グノーシス) は、AIエージェントに長期間の非構造化記憶（Vibe Memory）と、エンティティベースの構造化知識（Knowledge Graph）の両方を備えた「記憶機能」を提供するためのプロジェクトです。
ローカルの Model Context Protocol (MCP) サーバーとして動作し、`llmharness` などのエージェントツールチェーンや、Cline 等のローカルIDE拡張機能から呼び出せるように設計されています。

## 特徴

1. **Vibe Memory (長期的・意味的記憶)**
   - Bun.spawn を経由してローカルの `multilingual-e5-small` (`../embedding` プロジェクト) を利用し、テキストから384次元のベクトルを生成。
   - `pgvector` エクステンションが有効な PostgreSQL 上に HNSW インデックスを用いて保存し、高速な近似近傍検索（コサイン類似度検索）を実現します。
   - セッションIDを用いた名前空間分離により、複数プロジェクトやエージェントが記憶を混同することを防ぎます。

2. **Knowledge Graph (構造化知識)**
   - TypeGraph のパラダイムに基づくエンティティ (Entity) と リレーション (Relation) を Drizzle ORM で直接管理。
   - `Graph RAG` 実装として、指定ノードから関連する「出ていく関係」「入ってくる関係」の一覧をまとめて取得し、LLMにコンテキストとして提供可能。
   - 間違った関係性の訂正やエンティティの上書き更新など、自律的な知識メンテナンスをサポートします。

## 技術スタック

* **ランタイム**: Bun
* **データベース**: PostgreSQL 16 `pgvector`
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
(デフォルトではポート7888で立ち上がります)

```bash
docker-compose up -d
```

### 3. 初期設定とマイグレーション

DBコンテナが起動したら、`vector` 拡張機能を有効化し、テーブルスキーマをプッシュします。

```bash
node setup_db.js
bunx drizzle-kit push --force
```

*(備考: embeddingを生成するために、兄弟ディレクトリにあたる `../embedding` 側に `multilingual-e5-small` のローカルモデルとCLIコマンド（`~/.local/bin/embed`）がセットアップされている必要があります)*

## ツールの利用方法 (MCP)

Gnosis は標準入力/標準出力 (stdio) 経由で通信する MCP サーバーとして起動します。以下のコマンドをクライアントに登録してください。

```bash
bun run src/index.ts
```

### 利用可能なツール群

* **`store_memory`**: 新たな記憶テキストと、そこから抽出したエンティティや関係性をまとめて保存します。
* **`search_memory`**: 質問クエリからベクトルを生成し、関連する Vibe Memory コンテキストを検索します。
* **`query_graph`**: 指定したエンティティ周辺に繋がっている知識構造のグラフを探索します。
* **`update_graph`**: 既存の誤ったナレッジ（関係性等）を削除、またはエンティティの内容を上書き更新します。

## テストの実行

プロジェクトには動作確認用のインテグレーションテストと、Bun のユニットテスト機構が含まれています。

```bash
# ユニットテスト
bun test

# 統合検証（手動テストスクリプト）
bun run src/test.ts
```
