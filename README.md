# Gnosis: AI Local Stack

Gnosis（グノーシス）は、AIエージェントに**長期記憶**と**構造化知識**を提供するローカル統合スタックです。  
[Model Context Protocol (MCP)](https://modelcontextprotocol.io/) サーバーとして動作し、Cursor・Claude Code・Cline 等のエージェントクライアントから透過的に利用できます。

## 特徴

| 機能 | 概要 |
|------|------|
| **Vibe Memory** | テキストをベクトル化し、PostgreSQL + pgvector でセマンティック類似検索。セッション分離・ハイブリッド検索対応 |
| **Knowledge Graph** | エンティティ間の関係を構造化。Graph RAG でエージェントに深い文脈を提供 |
| **Failure Learning Loop** | 失敗と成功パッチを記録・類似検索し、同種のミスを未然に防ぐ |
| **KnowFlow** | ウェブ検索と LLM を組み合わせた自律調査エンジン。根拠付きの知識を自動収集・統合 |
| **Guidance Registry** | ルール・スキルを登録し、エージェントのプロンプトに自動注入 |
| **Monitor** | Tauri + SvelteKit によるリアルタイム監視デスクトップ UI |

## アーキテクチャ

```text
┌─────────────────────────────────────────────────────────┐
│                    MCP Clients                          │
│           (Cursor / Claude Code / Cline)                │
└──────────────────────┬──────────────────────────────────┘
                       │ stdio (MCP Protocol)
┌──────────────────────▼──────────────────────────────────┐
│                  Gnosis Core (Bun)                      │
│  ┌────────────────────────────────────────────────────┐ │
│  │              MCP Server (18 tools)                 │ │
│  │  memory │ graph │ knowledge │ knowflow │ experience│ │
│  │         │       │           │  sync    │ guidance  │ │
│  └────┬────┴───┬───┴─────┬─────┴────┬─────┴──────────┘ │
│       │        │         │          │                   │
│  Services   Adapters   Domain    Scripts                │
│  (memory,   (llm,      (errors,  (worker,              │
│   graph,    retriever)  schemas)  import-guidance)      │
│   guidance,                                             │
│   knowflow)                                             │
└───┬──────────────┬──────────────────┬───────────────────┘
    │              │                  │
┌───▼───┐   ┌─────▼──────┐   ┌──────▼──────┐
│  DB   │   │ Embedding  │   │  Local LLM  │
│ pg16  │   │ e5-small   │   │  Gemma 4    │
│pgvector│  │ (Python)   │   │  MLX/Ollama │
└───────┘   └────────────┘   │  (Python)   │
                              └─────────────┘
```

## プロジェクト構成

```text
gnosis/
├── src/                    Gnosis Core — MCP サーバー・サービス・DB
│   ├── mcp/                  MCP サーバー・ツール定義 (tools/*.ts)
│   ├── services/             ビジネスロジック (memory, graph, knowflow, ...)
│   ├── adapters/             外部接続 (LLM, MCP Retriever)
│   ├── db/                   Drizzle スキーマ・マイグレーション
│   ├── domain/               共通型・エラー・スキーマ
│   └── scripts/              ワーカー・インポート用エントリポイント
├── apps/
│   └── monitor/              Tauri + SvelteKit 監視 UI
├── services/
│   ├── embedding/            multilingual-e5-small ベクトル生成 (Python)
│   └── local-llm/            Gemma 4 / Ollama — OpenAI 互換 API (Python)
├── scripts/                  セットアップ・検証・自動化スクリプト
├── eval/                     KnowFlow 評価スイート
├── profiles/                 KnowFlow プロファイル (TOML)
├── docs/                     設計ドキュメント・改善計画
└── drizzle/                  SQL マイグレーションファイル
```

## セットアップ

### 前提条件

- [Bun](https://bun.sh/) v1.1+
- [Docker](https://www.docker.com/) (PostgreSQL 用)
- Python 3.10+ (Embedding / Local LLM 用)
- Mac の場合: MLX が Apple Silicon で自動利用される

### 1. 依存関係のインストール

```bash
bun install

# Python サービス（Embedding, Local-LLM）のセットアップ
bun run monorepo:setup
```

### 2. インフラの起動

```bash
# PostgreSQL (pgvector 対応) を起動
docker-compose up -d
```

### 3. 初期設定

```bash
cp .env.example .env
# 必要に応じて .env を編集（特に LOG_DIR 系のパス）

# DB の作成・マイグレーション・シードデータ投入
bun run db:init
```

### 4. MCP クライアントへの登録

MCP 対応クライアントの設定ファイルに以下を追加:

```json
{
  "mcpServers": {
    "gnosis": {
      "command": "bun",
      "args": ["run", "start"],
      "cwd": "/path/to/gnosis"
    }
  }
}
```

## MCP ツール一覧

Gnosis は 18 の MCP ツールを提供します。

### Memory（記憶）

| ツール | 説明 |
|--------|------|
| `store_memory` | テキストをベクトル化して保存。エンティティ・リレーションも同時に登録可能 |
| `search_memory` | セマンティック類似検索。メタデータフィルタ対応 |
| `delete_memory` | ID 指定でメモリを削除 |

### Graph（知識グラフ）

| ツール | 説明 |
|--------|------|
| `query_graph` | 起点エンティティから最大 2 ホップの関連を Graph RAG で取得 |
| `digest_text` | テキストのキーワードに関連する既存エンティティを候補提示 |
| `update_graph` | エンティティ更新またはリレーション削除 |
| `find_path` | 2 エンティティ間の最短経路を探索 |
| `build_communities` | グラフ全体を分析しコミュニティを検出・要約 |

### Knowledge（構造化知識）

| ツール | 説明 |
|--------|------|
| `search_knowledge` | KnowFlow で収集した知識を全文検索 (FTS) |
| `get_knowledge` | トピック単位でクレーム・関連・情報源の詳細を取得 |
| `search_unified` | FTS / KG / Semantic の3モードで横断検索 |

### KnowFlow（自律調査）

| ツール | 説明 |
|--------|------|
| `enqueue_knowledge_task` | トピックの調査タスクを非同期キューに投入 |
| `run_knowledge_worker` | キューからタスクを1件取得して実行 |

### Experience（経験学習）

| ツール | 説明 |
|--------|------|
| `record_experience` | 失敗・成功の教訓を記録 |
| `recall_lessons` | 類似の過去経験から教訓を検索 |

### Sync & Reflection（同期・省察）

| ツール | 説明 |
|--------|------|
| `sync_agent_logs` | エージェントの会話履歴を解析し一括同期 |
| `reflect_on_memories` | 未処理メモリからエンティティ・関係を抽出しグラフに統合 |

### Guidance（ガイダンス）

| ツール | 説明 |
|--------|------|
| `register_guidance` | ルール・スキルを Guidance Registry に登録 |

## 主要コマンド

### 基本操作

```bash
bun run start              # MCP サーバー起動
bun run dev                # 開発モード（ファイル監視付き）
bun run verify             # 品質ゲート（format → lint → typecheck → test → smoke）
```

### KnowFlow CLI

```bash
# タスク投入
bun run src/services/knowflow/cli.ts enqueue --topic "Bun runtime"

# 単発実行
bun run src/services/knowflow/cli.ts run-once

# ワーカーループ
bun run src/services/knowflow/cli.ts run-worker --interval-ms 60000

# LLM タスク直接実行
bun run src/services/knowflow/cli.ts llm-task --task hypothesis --context-json '{"topic":"Graph RAG"}'

# 知識検索
bun run src/services/knowflow/cli.ts search-knowledge --query "cache invalidation"

# 評価スイート実行
bun run src/services/knowflow/cli.ts eval-run --suite local --mock
```

CLI の全フラグ: `--json` `--table` `--verbose` `--profile <name>` `--run-id <id>`

### データベース

```bash
bun run db:init            # DB 作成 + マイグレーション + シード
bun run db:generate        # スキーマ変更から SQL マイグレーション生成
bun run db:migrate         # マイグレーション適用
```

### 監視 UI

```bash
bun run monitor:dev        # Tauri 開発サーバー起動
bun run monitor:snapshot   # CLI でスナップショット取得 (JSON)
bun run monitor:detail     # タスク詳細取得 (--task-id <id>)
```

### その他

```bash
bun run guidance:import    # Guidance アーカイブの一括インポート
bun run lint               # Biome による静的解析
bun run format             # Biome によるフォーマット
bun run test:coverage      # テスト実行 + カバレッジレポート (lcov + text)
```

## プロファイル設定

KnowFlow CLI は TOML プロファイルで LLM・予算設定をカスタマイズできます。

```bash
# デフォルトプロファイルで実行
bun run src/services/knowflow/cli.ts run-once

# カスタムプロファイルを指定
bun run src/services/knowflow/cli.ts run-once --profile custom
```

プロファイルは `profiles/<name>.toml` に配置:

```toml
[knowflow.llm]
apiBaseUrl = "http://127.0.0.1:44448"
model = "gemma-4-e4b-it"
temperature = 0
timeoutMs = 60000
maxRetries = 2
enableCliFallback = true

[knowflow.budget]
userBudget = 12
cronBudget = 6
cronRunBudget = 30
```

## 環境変数

主要な環境変数の一覧です。全量は `.env.example` を参照してください。

### 必須

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:7888/gnosis` | PostgreSQL 接続文字列 |

### LLM・埋め込み

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `GNOSIS_EMBED_COMMAND` | `services/embedding/.venv/bin/embed` | 埋め込みベクトル生成コマンド |
| `GNOSIS_EMBEDDING_DIMENSION` | `384` | ベクトル次元数 |
| `LOCAL_LLM_API_BASE_URL` | `http://127.0.0.1:44448` | ローカル LLM API ベース URL |
| `LOCAL_LLM_MODEL` | `gemma-4-e4b-it` | 使用モデル名 |
| `LOCAL_LLM_ENABLE_CLI_FALLBACK` | `true` | API 失敗時の CLI フォールバック |

### KnowFlow ワーカー

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `KNOWFLOW_WORKER_POLL_INTERVAL_MS` | `60000` | ポーリング間隔 (ms) |
| `KNOWFLOW_WORKER_TASK_TIMEOUT_MS` | `600000` | タスクタイムアウト (ms) |
| `KNOWFLOW_WORKER_MAX_CONSECUTIVE_ERRORS` | `5` | 連続エラー許容回数 |
| `USER_BUDGET` | `12` | ユーザー起点タスクの予算上限 |
| `CRON_BUDGET` | `6` | cron 起点タスクの予算上限 |

### ログ同期

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `GNOSIS_CLAUDE_LOG_DIR` | (なし) | Claude Code ログディレクトリ |
| `GNOSIS_ANTIGRAVITY_LOG_DIR` | (なし) | Gemini Antigravity ログディレクトリ |

## データベーススキーマ

Gnosis は PostgreSQL 16 + pgvector 上に以下のテーブルを持ちます:

| テーブル | 役割 |
|----------|------|
| `vibe_memories` | ベクトル付き非構造化メモリ（HNSW インデックス） |
| `entities` | Knowledge Graph のノード |
| `relations` | Knowledge Graph のエッジ |
| `communities` | Louvain 法で検出されたコミュニティ |
| `experience_logs` | 失敗・成功の教訓レコード |
| `topic_tasks` | KnowFlow タスクキュー (JSONB) |
| `knowledge_topics` | KnowFlow で収集されたトピック |
| `knowledge_claims` | トピックに紐づくクレーム（FTS 対応） |
| `knowledge_relations` | トピック間の関係 |
| `knowledge_sources` | クレームの出典 URL |
| `sync_state` | 外部ログ同期の進捗状態 |

## 開発

### 品質ゲート

`bun run verify` は以下の 5 ステップを順に実行します:

1. **format-check** — Biome によるフォーマット検証
2. **lint** — Biome による静的解析
3. **typecheck** — TypeScript コンパイラ (strict モード)
4. **test** — Bun テスト + カバレッジ出力
5. **smoke** — MCP スモークテスト + eval スイート (mock)

### テスト

```bash
bun test                        # 全テスト実行
bun test --coverage             # カバレッジ付き
bun test test/knowflow/         # ディレクトリ指定

# 統合テスト（DB 接続が必要）
KNOWFLOW_RUN_INTEGRATION=1 bun test test/knowflow/queuePostgres.integration.test.ts
```

### コミット規約

[Conventional Commits](https://www.conventionalcommits.org/) に準拠:

```
feat: KnowFlow に gap_planner タスクを追加
fix: 埋め込みコマンドのタイムアウト処理を修正
refactor: MCP server.ts をツール単位に分割
docs: MCP ツール API リファレンスを追加
```

### リリース

```bash
# verify 通過後にバージョンタグを作成
bun run release
```

## 技術スタック

| レイヤー | 技術 |
|----------|------|
| Runtime | [Bun](https://bun.sh/) |
| Language | TypeScript 6.0 (strict) |
| Database | PostgreSQL 16 + [pgvector](https://github.com/pgvector/pgvector) |
| ORM | [Drizzle ORM](https://orm.drizzle.team/) |
| Schema Validation | [Zod](https://zod.dev/) |
| Graph | [graphology](https://graphology.github.io/) + Louvain コミュニティ検出 |
| Protocol | [Model Context Protocol](https://modelcontextprotocol.io/) |
| Embedding | multilingual-e5-small (Python / sentence-transformers) |
| LLM | Gemma 4 via MLX / Ollama (OpenAI 互換 API) |
| Monitor UI | [SvelteKit](https://kit.svelte.dev/) + [Tauri v2](https://tauri.app/) |
| Lint/Format | [Biome](https://biomejs.dev/) |

## ドキュメント

- [改善実装計画](docs/improve-plan.md) — 現在の改善ロードマップ
- [Tauri 監視アプリ設計](docs/tauri-monitoring-implementation-plan.md) — Monitor の設計と WebSocket プロトコル
- [KnowFlow KG/FTS 統合計画](docs/knowflow-kg-fts-unified-plan.md) — Knowledge Graph と全文検索の統合設計
- [セキュリティニュース計画](docs/security-news.md) — セキュリティニュース収集機能の設計

## ライセンス

MIT
