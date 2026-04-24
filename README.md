# Gnosis: AI Autonomous Memory Stack

Gnosis は、AI エージェント向けのローカル記憶スタックです。MCP サーバーとして動作し、長期記憶（ベクトル検索）と知識グラフを統合します。

## 5分で最小起動 (minimal)

### 前提条件
- Bun 1.1+
- Docker (PostgreSQL + pgvector 用)
- Python 3.10+

### サポート方針
- 正式対象: macOS / Linux
- Windows: まだ正式サポート外（ただし新規セットアップ実装は Windows 展開を阻害しない方針）

### 最短手順
```bash
git clone https://github.com/ugnoguchigxp/gnosis.git
cd gnosis
bun run bootstrap
bun run doctor
bun run onboarding:smoke
```

`onboarding:smoke` が成功すれば、最小導線は完了です。

## 構成別の導線

| 構成 | 想定用途 | セットアップ |
| :--- | :--- | :--- |
| minimal | まず起動確認だけしたい | `bun run bootstrap` |
| local-llm | ローカル LLM も同時に運用したい | `bun run bootstrap:local-llm` |
| cloud-review | cloud reviewer を使いたい | `.env.minimal` へ `.env.cloud-review` の必要項目を追記 |

テンプレート:
- `.env.minimal`
- `.env.local-llm`
- `.env.cloud-review`
- `.env.example`（互換用の入口）

## よくある失敗

1. Docker が起動していない  
`docker compose up -d db` を実行してから `bun run doctor` を再実行。

2. `.env` がない  
`bun run bootstrap` が未実行。先に bootstrap を実行。

3. DB 初期化が未完了  
`bun run db:init` を実行後、`bun run onboarding:smoke` を再実行。

## 日常コマンド

```bash
bun run start
bun run verify:fast
bun run verify
bun run verify:strict
bun run maintenance
```

## 概要

### 主要機能

| 機能 | 説明 |
| :--- | :--- |
| Vibe Memory | ベクトル + メタデータのハイブリッド検索 |
| Knowledge Graph | 関係性を持つ Graph RAG 基盤 |
| Gnosis Hook | 変更検知ベースの自動検証・ガード |
| KnowFlow | Web 検索連携の知識収集・検証フロー |
| Unified Scheduler | バックグラウンド整理タスクの統合運用 |
| Monitor UI | Tauri + SvelteKit の監視 UI |

### アーキテクチャ

```text
┌─────────────────────────────────────────────────────────────┐
│                      MCP Clients (IDE)                      │
└──────────────────────────────┬──────────────────────────────┘
                               │ MCP Protocol
┌──────────────────────────────▼──────────────────────────────┐
│                      Gnosis Core (Bun)                      │
│  ┌────────────────────────────────────────────────────────┐ │
│  │   Memory Services (Semantic / Episode / Procedural)   │ │
│  └──────┬───────────────┬───────────────┬─────────────────┘ │
│         │               │               │                   │
│  ┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐            │
│  │ PostgreSQL  │ │   SQLite    │ │  Local LLM  │            │
│  │ (pgvector)  │ │ (Scheduler) │ │ (optional)  │            │
│  └─────────────┘ └─────────────┘ └─────────────┘            │
└─────────────────────────────────────────────────────────────┘
```

## ドキュメント

- [アーキテクチャ詳細](docs/architecture.md)
- [設定リファレンス](docs/configuration.md)
- [データレイヤー](docs/data-layers.md)
- [MCP ツール](docs/mcp-tools.md)
- [Hook ガイド](docs/hooks-guide.md)
- [KnowFlow ガイド](docs/knowflow-guide.md)
- [Automation 運用](docs/automation.md)

## ライセンス

MIT
