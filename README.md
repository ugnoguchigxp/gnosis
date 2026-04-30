# Gnosis: Agent-First Memory and Review MCP

Gnosis は、LLM エージェント向けの agent-first な知識・記憶・レビュー基盤です。  
MCP サーバーとして動作し、一次導線は `agentic_search` と `review_task` を中心に設計されています。

中核ワークフローは、再利用可能な knowledge（rule/lesson/procedure/skill/decision/risk/command recipe）に寄せています。

## 5分で最小起動 (minimal)

### 前提条件
- Bun 1.1+
- Docker (`postgres` コンテナ起動用)
- Python 3.10+（embedding サービス初期化で使用）

### 最短手順
```bash
git clone https://github.com/ugnoguchigxp/gnosis.git
cd gnosis
bun run bootstrap
bun run doctor
bun run onboarding:smoke
```

`onboarding:smoke` が成功すれば最小導線は完了です。

## 構成別セットアップ

| 構成 | 想定用途 | 実行コマンド |
| :--- | :--- | :--- |
| minimal | まず起動確認したい | `bun run bootstrap` |
| local-llm | ローカル LLM も使いたい | `bun run bootstrap:local-llm` |
| cloud-review | cloud reviewer を使いたい | `.env` に `.env.cloud-review` の必要項目を追記 |

利用テンプレート:
- `.env.minimal`
- `.env.local-llm`
- `.env.cloud-review`
- `.env.example`（テンプレート案内用）

## MCP 公開面

- MCP `tools/list` は Agent-First の一次導線のみを公開します。
- 公開ツールは `initial_instructions / agentic_search / search_knowledge / record_task_note / review_task / doctor` に固定です。
- `agentic_search` は通常の知識取得入口です。`search_knowledge` は raw 候補やスコアを確認する低レベル検索です。

## 品質チェック

`verify` は品質ゲートを一括実行します。

```bash
bun run verify:fast
bun run verify
bun run verify:strict
```

実行内容:
- `verify:fast`: `format-check` / `lint` / `typecheck` / `build`
- `verify`: `format-check` / `lint` / `typecheck` / `build` / `test`
- `verify:strict`: `verify` + `coverage` + `failure-path` + `smoke` + `flaky-check` + `integration-local`

## 日常コマンド

```bash
bun run start
bun run doctor
bun run db:init
bun run verify
bun run maintenance
```

## 主要機能

| 機能 | 説明 |
| :--- | :--- |
| Agent-First MCP | `initial_instructions`, `agentic_search`, `search_knowledge`, `review_task` などの一次導線 |
| Vibe Memory | ベクトル + メタデータ検索による長期記憶 |
| Knowledge Graph | 関係性を扱う Graph RAG |
| Review | コード/ドキュメント/実装計画レビュー |
| KnowFlow | 自律的な知識収集タスク（キュー/ワーカー） |
| Monitor UI | Tauri + SvelteKit の管理画面 |

## アーキテクチャ（概要）

```text
┌─────────────────────────────────────────────────────────────┐
│                    MCP Clients (IDE/Agents)                 │
└──────────────────────────────┬──────────────────────────────┘
                               │ MCP Protocol
┌──────────────────────────────▼──────────────────────────────┐
│                      Gnosis Core (Bun)                      │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ Agent-First Tools / Memory / Graph / Review / KnowFlow│ │
│  └──────┬───────────────────────────┬─────────────────────┘ │
│         │                           │                       │
│  ┌──────▼──────┐             ┌──────▼──────┐                │
│  │ PostgreSQL  │             │  Local LLM  │                │
│  │ (pgvector)  │             │ (optional)  │                │
│  └─────────────┘             └─────────────┘                │
└─────────────────────────────────────────────────────────────┘
```

## ドキュメント

- [Startup Guide](docs/startup.md)
- [Configuration](docs/configuration.md)
- [MCP Tools](docs/mcp-tools.md)
- [Data Layers](docs/data-layers.md)
- [Hooks Guide](docs/hooks-guide.md)
- [KnowFlow Guide](docs/knowflow-guide.md)
- [Active-Use Improvement Plan](docs/active-use-improvement-plan.md)
- [Agent-First Refactoring Plan](docs/agent-first-gnosis-refactoring-plan.md)

## ライセンス

MIT
