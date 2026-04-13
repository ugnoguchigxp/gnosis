# Gnosis: AI Local Stack (Vibe Memory & Knowledge Graph)

Gnosis (グノーシス) は、AIエージェントに「長期的な意味記憶 (Vibe Memory)」と「構造化された知識 (Knowledge Graph)」の両方を提供するための統合ローカルスタックです。

本プロジェクトは **モノレポ構成** となっており、Core ロジック、監視 UI、および AI コンポーネント（埋め込みベクトル生成、LLM ツール連携）がすべて一つのリポジトリに集約されています。

## 特徴

1.  **Vibe Memory (意味的記憶)**: テキストをベクトル化し、PostgreSQL (`pgvector`) を用いてコサイン類似度検索。セッション分離やハイブリッド検索に対応。
2.  **Knowledge Graph (構造化知識)**: エンティティ間の関係を記録。Graph RAG により深い文脈をエージェントに提供。
3.  **Failure Learning Loop (失敗学習)**: 過去の失敗と成功パッチを記録し、同様のミスを未然に防ぐ教訓を提供。
4.  **KnowFlow (自律調査エンジン)**: ウェブ検索と LLM を組み合わせ、特定のトピックについて根拠のある知識を自律的に収集・統合。

## プロジェクト構成

```text
gnosis/
  ├── apps/
  │   └── monitor/      (UI) Tauri/Svelte によるステータス・グラフ監視
  ├── services/
  │   ├── embedding/    (AI) multilingual-e5-small によるベクトル生成
  │   └── local-llm/    (AI) Gemma 4 / MCP ツールサーバー (検索・スクレイピング)
  ├── src/              (Core) Bun による Gnosis 本体・MCP サーバー
  └── scripts/          (Tools) セットアップ・検証用自動化スクリプト
```

## セットアップ

### 1. 依存関係のインストール

```bash
# Node.js/Bun 依存関係
bun install

# Python サービス（Embedding, Local-LLM）のセットアップ
bun run monorepo:setup
```

### 2. インフラの起動

```bash
# Docker で PostgreSQL (pgvector 対応) を起動
docker-compose up -d
```

### 3. 初期設定

```bash
# 環境変数の準備
cp .env.example .env
# (必要に応じて .env を編集)

# データベースの初期化とマイグレーション
bun run db:init
```

## 主要コマンド

### MCP サーバーの起動 (Cursor/Cline 等からの利用)
```bash
bun run start
```

### 検証 (品質ゲート)
```bash
bun run verify
```

### 自律調査タスクの実行 (KnowFlow)
```bash
# タスク投入
bun run src/services/knowflow/cli.ts enqueue --topic "Bun runtime"
# 実行 (単発)
bun run src/services/knowflow/cli.ts run-once
```

### 監視 UI の開発起動
```bash
bun run monitor:dev
```

## 技術スタック
- **Runtime**: Bun
- **Database**: PostgreSQL 16 + `pgvector`
- **ORM**: Drizzle ORM
- **AI Backend**: Python 3.10+, MLX (Optional for Mac)
- **UI**: Svelte 5 + Tauri

## ライセンス
MIT
