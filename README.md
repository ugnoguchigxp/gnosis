# Gnosis: AI Autonomous Memory Stack

Gnosis（グノーシス）は、AIエージェントに「長期記憶」と「構造化知識」を提供するだけでなく、**自律的に情報を整理・昇華し、自身の経験から学習し続ける**ためのローカル統合スタックです。

[Model Context Protocol (MCP)](https://modelcontextprotocol.io/) サーバーとして動作し、Cursor, Claude Code, Cline 等のエージェントクライアントに、単なる検索を超えた「外付けの脳」を提供します。

---

## 💡 コア・コンセプト：2層記憶モデル (Dual Layer Memory)

Gnosis は情報を性質の異なる2つの層に整理し、相互に連携させることで、エージェントに深い洞察と一貫性を提供します。

1.  **エピソード記憶 (Episode Memory)**:
    - **文脈と因果**: 断片的な事実（Rawメモ）や体験を LLM で統合し、因果関係、判断理由、教訓を含む「ナラティブ（物語）」として抽象化（`vibe_memories`）。
    - **高速想起**: 高品質なベクトル検索（pgvector）を用いることで、過去の類似体験を瞬時に呼び出します。
2.  **手続き記憶 (Procedural Memory)**:
    - **目標と手順**: 実現したい目標 (`Goal`) と具体的なステップ (`Task`) をグラフ構造で保持（`entities` + `relations`）。
    - **経験による学習**: 実行結果に基づき `Confidence`（信頼度）を動的に更新。成功体験は強化され、失敗は制約として次回に活かされる「生きたスキル」として機能します。

> [!NOTE]
> 普遍的事実（意味記憶）は LLM 自体の知識やウェブ検索 MCP に委譲し、Gnosis はプロジェクト固有の体験と手順の最適化に特化しています。

---

## 🛠 エンジニアリングの独自性

### 1. 多重起動抑制とリソース保護 (Global Resource Guard)
ローカル LLM や Embedding モデルはリソース消費が激しく、複数プロセスからの同時呼び出しはシステムの不安定化を招きます。Gnosis は OS レベルのファイルシステム・ロックを利用した**グローバルセマフォ**を実装しており、MCPクライアントが複数立ち上がっている状況でも、システム全体の同時実行数を厳格に制御します。

### 2. 自律的な情報整理サイクル (Autonomous Promotion Cycle)
Gnosis は受動的なデータベースではありません。統合バックグラウンドスケジューラーが、定期的に以下のサイクルを自律実行します。
- **Consolidation**: 未整理の Raw メモをエピソード記憶へ変換。
- **Synthesis**: エピソードから知識（エンティティ・リレーション）を抽出し、知識グラフへシームレスに統合。
- **Reflection**: 蓄積された情報から新たな洞察やコミュニティを自動検出。

### 3. データレイヤーの抽象化 (Robust Data Layer)
`MainGraphAdapter` インターフェースにより、データストレージの実装が完全に抽象化されています。現在は PostgreSQL (pgvector) を主力としつつ、テスト用のインメモリ実装や、将来的なブロックチェーン・ローカルファイルへの拡張が容易な構造になっています。
- 詳細は [データレイヤー・アーキテクチャ](docs/data-layers.md) を参照。

### 4. インテリジェント・ルーティング (MemoryLoop)
`MemoryLoopRouter` がタスクの重要度や失敗頻度を評価し、ローカル LLM (Gemma 4/Bonsai) とクラウド LLM (OpenAI/Bedrock) を動的に切り替えます。高品質が必要な場面やリトライ時には、シームレスに上位モデルへフォールバックします。

---

## 🚀 主要機能

| 機能 | 説明 |
| :--- | :--- |
| **Vibe Memory** | ハイブリッド検索（ベクトル + メタデータ）による長期記憶 |
| **Knowledge Graph** | 18種類以上の関係性を定義可能な Graph RAG 基盤 |
| **Learning Loop** | 失敗/成功の教訓 (`record_experience`) を次回の作業に自動注入 |
| **KnowFlow** | ウェブ検索と連携した自律的な知識収集・検証エンジン |
| **Guidance Registry** | ルール・スキルをエージェントのプロンプトへ自動的に動的注入 |
| **Unified Scheduler** | SQLite ベースのタスク管理による背景整理の自律化 |
| **Maintenance Tool** | バックグラウンドタスクの整理や DB 最適化を行う専用スクリプト |
| **Monitor UI** | Tauri + SvelteKit によるリアルタイム監視デスクトップ UI |

---

## 📂 アーキテクチャ

```text
┌─────────────────────────────────────────────────────────────┐
│                      MCP Clients (IDE)                      │
└──────────────────────────────┬──────────────────────────────┘
                               │ MCP Protocol
┌──────────────────────────────▼──────────────────────────────┐
│                      Gnosis Core (Bun)                      │
│  ┌────────────────────────────────────────────────────────┐ │
│  │   Memory Services (Triple Layer)                       │ │
│  │   [Semantic]     [Episode]     [Procedural]            │ │
│  └──────┬───────────────┬───────────────┬─────────────────┘ │
│         │               │               │                   │
│  ┌──────▼───────────────▼───────────────▼─────────────────┐ │
│  │           Autonomous Resource Guard                    │ │
│  │   (Global Semaphores & MemoryLoop LLM Router)          │ │
│  └──────┬───────────────┬───────────────┬─────────────────┘ │
│         │               │               │                   │
│  ┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐            │
│  │  PostgreSQL │ │   SQLite    │ │  Local LLM  │            │
│  │  (pgvector) │ │  (Scheduler)│ │ (Gemma/MLX) │            │
│  └─────────────┘ └─────────────┘ └─────────────┘            │
└─────────────────────────────────────────────────────────────┘
```

---

## 🛠️ クイックスタート

### 前提条件
- **Bun** v1.1+
- **Docker** (PostgreSQL 用)
- **Python 3.10+** (Embedding / Local LLM 用)

### セットアップ
```bash
# プロジェクト初期化
bun install
bun run monorepo:setup   # Python サービスのセットアップ
docker-compose up -d     # DB 起動
bun run db:init          # DB 初期化・マイグレーション

# 品質検証 & 実行
bun run verify           # Lint/Typecheck/Test(逐次)/Smoke 一括検証
bun run start            # サーバー起動
```

### 便利コマンド
- `bun run maintenance`: 異常終了したバックグラウンドタスクのクリーンアップなど。
- `bun run verify`: コミット前の品質チェックに必須。全テストがパスすることを確認。

---

## 📄 ドキュメント

より詳細な情報は、`docs/` ディレクトリ配下のドキュメントを参照してください。

- [アーキテクチャ詳細](docs/architecture.md)
- [データレイヤー・アーキテクチャ](docs/data-layers.md)
- [記憶リファクタリング計画](docs/memory-refactoring.md)
- [MCP ツールリファレンス](docs/mcp-tools.md)
- [KnowFlow ガイド](docs/knowflow-guide.md)

---

## 📜 ライセンス

MIT
