# Gnosis: AI Local Stack

Gnosis（グノーシス）は、AIエージェントに**長期記憶**と**構造化知識**を提供するローカル統合スタックです。  
[Model Context Protocol (MCP)](https://modelcontextprotocol.io/) サーバーとして動作し、Cursor・Claude Code・Cline 等のエージェントクライアントから透過的に利用できます。

エージェントが単発で応答するだけでなく、過去の文脈を思い出し、知識を構造化し、必要に応じて自律的に調査し、教訓を次回に活かすための基盤を目指しています。

## 何ができるか

- 会話・レビュー・設計判断を `store_memory` で蓄積し、後から `search_memory` で再利用できる
- エンティティと関係をグラフ化し、`query_graph` や `find_path` で文脈を引き出せる
- KnowFlow でトピック調査を非同期キューに積み、知識テーブルへ継続的に統合できる
- 失敗と成功の経験を `record_experience` / `recall_lessons` で再利用できる
- Guidance Registry でルールやスキルを登録し、エージェントの振る舞いを安定化できる
- Monitor でキュー・ワーカー・評価状態をデスクトップ UI から監視できる

## 想定ユースケース

| ユースケース | 使い方 |
|------|------|
| エージェントの長期記憶 | レビュー結果、設計判断、調査メモを `store_memory` で保存し、次回の作業で `search_memory` から再利用 |
| Graph RAG | ドメイン知識をエンティティ/リレーションとして保存し、関連文脈を `query_graph` で取得 |
| 継続調査 | `enqueue_knowledge_task` で調査トピックを積み、KnowFlow ワーカーで段階的に知識化 |
| ポストモーテム学習 | 障害対応や失敗事例を `record_experience` し、類似作業時に `recall_lessons` で参照 |
| エージェント運用基盤 | ログ同期、自己省察、Guidance 登録、Monitor を組み合わせてローカル運用を整備 |

## クイックスタート

最短で触るなら、次の流れです。

```bash
bun install
bun run monorepo:setup
docker-compose up -d
cp .env.example .env
bun run db:init
bun run verify
bun run start
```

次に MCP クライアントへ `gnosis` を登録し、以下のような順で試すと全体像を掴みやすいです。

1. `store_memory` で短いメモを保存する
2. `search_memory` で意味検索してヒットを確認する
3. `enqueue_knowledge_task` で調査トピックを積む
4. `run_knowledge_worker` で 1 件処理する
5. `search_knowledge` や `get_knowledge` で結果を確認する

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

### 5. 動作確認

```bash
# 品質ゲート
bun run verify

# 監視 UI（任意）
bun run monitor:dev
```

`verify` が通れば、最低限のフォーマット・lint・型チェック・テスト・スモークは完了しています。

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

より詳しい入出力仕様や使い分けは `docs/mcp-tools.md` を追加予定です。

## 最初の実行例

### 1. メモリを保存して検索する

クライアントから次のような情報を保存します。

```json
{
  "tool": "store_memory",
  "arguments": {
    "sessionId": "demo",
    "content": "Graph RAG for incident analysis should prioritize timeline reconstruction before root-cause summarization.",
    "metadata": {
      "source": "manual",
      "topic": "incident-analysis"
    }
  }
}
```

その後、次のような検索で取り出せます。

```json
{
  "tool": "search_memory",
  "arguments": {
    "sessionId": "demo",
    "query": "How should Graph RAG help with incident analysis?",
    "limit": 3
  }
}
```

### 2. KnowFlow を単発で回す

```bash
bun run src/services/knowflow/cli.ts enqueue --topic "PostgreSQL logical replication"
bun run src/services/knowflow/cli.ts run-once --json
bun run src/services/knowflow/cli.ts search-knowledge --query "logical replication" --json
```

### 3. Guidance を登録する

`register_guidance` にルール本文を渡すことで、共通の運用ルールを蓄積できます。たとえば「レビューでは再現条件を必ず明記する」といった規約を登録しておくと、エージェントの出力を安定化しやすくなります。

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

主なコマンドの役割:

- `enqueue`: 調査タスクを登録する
- `run-once`: タスクを 1 件だけ処理する
- `run-worker`: ワーカーループを回し続ける
- `llm-task`: 個別の LLM タスクを直接試す
- `search-knowledge`: 収集済み知識を検索する
- `get-knowledge`: 1 トピックの詳細を確認する
- `merge-knowledge`: 外部 JSON を知識テーブルへ統合する
- `eval-run`: 評価スイートを実行する

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

プロファイルは次の優先順で反映されます。

1. CLI 引数
2. `profiles/<name>.toml`
3. `src/config.ts` のデフォルト値

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

### Guidance

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `GUIDANCE_ENABLED` | `true` | Guidance Registry の有効/無効 |
| `GUIDANCE_PROJECT` | (なし) | プロジェクト識別子 |
| `GUIDANCE_INBOX_DIR` | `imports/guidance/inbox` | ZIP アーカイブの投入先 |
| `GUIDANCE_MAX_ZIPS` | `1000` | 読み込む ZIP 数の上限 |

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

## コンポーネント別の責務

| コンポーネント | 責務 |
|------|------|
| `src/mcp/` | MCP サーバー本体とツール定義 |
| `src/services/memory.ts` | ベクトル化・保存・類似検索 |
| `src/services/graph.ts` | グラフ探索、関連文脈、コミュニティ検出 |
| `src/services/knowledge.ts` | KnowFlow の知識検索・取得 |
| `src/services/guidance.ts` | Guidance の登録・インポート |
| `src/services/knowflow/` | キュー、フロー、評価、LLM タスク |
| `services/embedding/` | 埋め込み生成の Python サービス |
| `services/local-llm/` | ローカル LLM API / MCP 補助サービス |
| `apps/monitor/` | デスクトップ監視 UI |

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

現在のテスト領域の中心:

- MCP ツールの契約テスト
- KnowFlow のキュー、フロー、評価、LLM アダプタ
- Experience / lock / secret filter
- 一部の integration / e2e テスト

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

## トラブルシューティング

### `bun run db:init` が失敗する

- `docker-compose up -d` が完了しているか確認する
- `DATABASE_URL` が `localhost:7888` を指しているか確認する
- pgvector 拡張が有効な PostgreSQL コンテナを使っているか確認する

### `search_memory` が失敗する

- `GNOSIS_EMBED_COMMAND` が正しいか確認する
- `services/embedding/.venv/bin/embed` が存在するか確認する
- `bun run monorepo:setup` を再実行する

### KnowFlow ワーカーが動かない

- `LOCAL_LLM_API_BASE_URL` が正しいか確認する
- `services/local-llm` 側が起動しているか確認する
- まず `llm-task` を単体で実行して疎通確認する

### Monitor が表示されない

- `bun run monitor:dev` をリポジトリルートで実行しているか確認する
- Tauri / Rust ツールチェーンがローカルにあるか確認する

## ロードマップ

- ドキュメント群の拡充: `docs/mcp-tools.md`, `docs/architecture.md`, `docs/configuration.md`, `docs/knowflow-guide.md`
- `guidance.ts` の分割
- `config.ts` の専用テスト追加
- サービス層 DI の統一
- `GnosisError` の横断適用

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

- [アーキテクチャ](docs/architecture.md) — 全体構成、主要コンポーネント、設計判断の整理
- [MCP ツールリファレンス](docs/mcp-tools.md) — ツール一覧、用途、入出力の整理
- [設定リファレンス](docs/configuration.md) — 環境変数、プロファイル、主要設定の説明
- [KnowFlow ガイド](docs/knowflow-guide.md) — CLI、評価、運用フローのガイド
- [自動化ガイド](docs/automation.md) — 自動化まわりの運用メモ
- [セキュリティニュース計画](docs/security-news.md) — セキュリティニュース収集機能の設計

README では入口に絞っているため、詳細な仕様・運用・設計判断は `docs/` 配下に段階的に切り出していく方針です。

## OSS メタデータ

- [LICENSE](LICENSE) — ライセンス本文
- [CONTRIBUTING.md](CONTRIBUTING.md) — 開発参加ガイド
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — 行動規範
- [SECURITY.md](SECURITY.md) — 脆弱性報告ポリシー
- [SUPPORT.md](SUPPORT.md) — サポート窓口と使い分け
- [GitHub Issue Templates](.github/ISSUE_TEMPLATE) — バグ報告・機能要望テンプレート
- [Pull Request Template](.github/pull_request_template.md) — PR 作成時のチェックリスト

## ライセンス

MIT
