# Gnosis: Vibe Memory & Knowledge Graph MCP Server

Gnosis (グノーシス) は、AIエージェントに長期間の非構造化記憶（Vibe Memory）と、エンティティベースの構造化知識（Knowledge Graph）の両方を備えた「記憶機能」を提供するためのプロジェクトです。
ローカルの Model Context Protocol (MCP) サーバーとして動作し、`llmharness` などのエージェントツールチェーンや、Cline 等のローカルIDE拡張機能から呼び出せるように設計されています。

## 特徴

1. **Vibe Memory (長期的・意味的記憶)**
   - Bun.spawn を経由してローカルの `multilingual-e5-small` (`../embedding` プロジェクト) を利用し、テキストから384次元のベクトルを生成。
   - `pgvector` エクステンションが有効な PostgreSQL 上で、コサイン類似度に基づくベクトル検索を実現します。
   - **高度な検索**: メタデータ (JSONB) による強力なフィルタリング（Vibe Memory 側のハイブリッド検索）をサポート。
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

## ローカル運用モデル

このプロジェクトはローカル実行を前提にしています。常駐WebサーバーやUIは必須ではありません。
主な操作は MCP 経由か CLI で行います。

## KnowFlow の知識モデル（現行方針）

KnowFlow では、Knowledge Graph と全文検索を分離せず、同一の知識面として扱います。

- 登録判定は Knowledge Graph 登録判定と同一です。
- 登録が通ったデータは `knowledge_claims` に保存され、同時に全文検索対象になります。
- Raw 本文は保持せず、有意義と判定したクレーム・関係・ソースのみ保存します。
- MCP は `query_graph` / `search_knowledge` を文脈に応じて使い分け、最終判断は LLM が行います。

設計と段階導入の詳細は [docs/knowflow-kg-fts-unified-plan.md](docs/knowflow-kg-fts-unified-plan.md) を参照してください。

## セットアップ

### 1. 依存関係

```bash
bun install
```

### 2. PostgreSQL (pgvector) を起動

```bash
docker-compose up -d
```

### 3. 初期化とマイグレーション

```bash
bun run db:init
```

備考:
- embedding 生成のため `../embedding` が必要です。
- KnowFlow のブラウジング連携を使う場合は `../localLlm` が必要です。

## 日常コマンド（CLI）

### MCP サーバー起動

```bash
bun run src/index.ts
```

### KnowFlow タスク投入

```bash
bun run src/services/knowflow/cli.ts enqueue --topic "PostgreSQL logical replication"
```

### KnowFlow ワーカー実行（単発）

```bash
bun run src/services/knowflow/cli.ts run-once
```

プロファイル適用例:

```bash
bun run src/services/knowflow/cli.ts run-once --profile default --verbose
```

### KnowFlow ワーカー実行（ループ）

```bash
bun run src/services/knowflow/cli.ts run-worker --interval-ms 1000
```

### KnowFlow ナレッジ参照

```bash
bun run src/services/knowflow/cli.ts search-knowledge --query "logical replication"
bun run src/services/knowflow/cli.ts get-knowledge --topic "PostgreSQL logical replication"
```

### KnowFlow ナレッジ統合（入力JSONを直接渡す）

```bash
bun run src/services/knowflow/cli.ts merge-knowledge --input '{"topic":"...","claims":[],"sources":[]}'
```

### KnowFlow 評価スイート（ローカル）

```bash
bun run src/services/knowflow/cli.ts eval-run --suite local
```

### CLI 共通オプション

- `--json`: JSON 形式で出力（既定）
- `--table`: テーブル形式で出力
- `--verbose`: 詳細ログを stderr に出力
- `--run-id <id>`: 実行IDを指定（未指定時は自動採番）
- `--profile <name-or-path>`: `profiles/*.toml` または任意の TOML ファイルを適用
- `--dry-run`: `enqueue` / `merge-knowledge` を副作用なしで検証実行
- `--max-degraded-rate <0-100>`: `eval-run` の劣化率(degradedRate)の許容上限（超過時は終了コード1）

各 CLI 実行は `logs/runs/<run-id>.jsonl` に実行ログを記録します。

### ログ同期

```bash
bun run src/scripts/sync.ts
```

## MCP で使える主なツール

### 記憶・グラフ操作
- `store_memory`: 記憶テキストと抽出したエンティティ/関係を保存
- `search_memory`: Vibe Memory のセマンティック検索
- `query_graph`: エンティティ起点で Knowledge Graph を探索
- `update_graph`: ナレッジ修正/関係削除

### 知見・失敗学習
- `record_experience`: 失敗または成功事例を構造化保存
- `recall_lessons`: 類似失敗から教訓と解決策を検索

### KnowFlow（自律調査）
- `enqueue_knowledge_task`: 調査タスクの投入
- `run_knowledge_worker`: タスク実行と知識獲得
- `search_knowledge`: `knowledge_claims` を対象にした全文検索（登録済み知識のみ）
- `get_knowledge`: トピックごとの詳細エビデンス取得

## ローカル品質チェック

```bash
# Lint
bun run lint

# Typecheck
bunx tsc --noEmit

# Test
bun test

# Local smoke (CLI dry-run + eval)
bun run smoke

# 必要に応じて eval 劣化率の許容を緩和（既定は 0）
KNOWFLOW_MAX_DEGRADED_RATE=100 bun run smoke

# All-in-one local gate
bun run verify
```

## 障害対応メモ（ローカル）

### DB 接続エラー時
1. `docker-compose ps` で PostgreSQL コンテナ状態を確認
2. `docker-compose up -d` で再起動
3. 必要なら `bun run db:init` を再実行

### KnowFlow 実行時に外部検索が失敗する場合
1. `--local-llm-path` の指定先が正しいか確認
2. `../localLlm` 側の MCP ツールサーバー実行環境（venv, 依存）を確認
3. 一時的に `run-once --fail` を使ってキュー挙動のみ検証

### 型エラーや実行時エラーが混在する場合
1. `bun run lint`
2. `bunx tsc --noEmit`
3. `bun test`
の順で失敗箇所を切り分ける
