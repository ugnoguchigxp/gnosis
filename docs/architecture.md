# Gnosis Architecture

Gnosis は、ローカル環境で動作する AI エージェントのための「外部脳」として設計されています。

## 設計思想

1.  **ローカルファースト**: すべてのデータ（ベクトル、知識、ログ）はローカルの PostgreSQL に保存され、プライバシーとオフライン動作を保証します。
2.  **MCP 準拠**: Model Context Protocol をインターフェースとして採用し、Cursor や Claude Code などの多様なクライアントと親和性を持ちます。
3.  **多層記憶構造**: 短期的な連想（Memory）、長期的な構造（Graph）、確証された事実（Knowledge）の 3 レイヤーで知識を管理します。

---

## コンポーネント構成

```mermaid
graph TD
    subgraph "Clients (MCP)"
        Cursor[Cursor / Claude Code]
    end

    subgraph "Gnosis Core (Bun/TS)"
        MCP[MCP Server]
        Services[Services: memory, graph, knowflow, etc.]
        DB_Adapter[Drizzle ORM]
        
        MCP --> Services
        Services --> DB_Adapter
    end

    subgraph "Intelligent Services"
        Embed[Embedding Service (Python)]
        LLM[Local LLM Service (MLX/Ollama)]
    end

    subgraph "Infrastructure"
        DB[(PostgreSQL + pgvector)]
    end

    DB_Adapter --> DB
    Services --> Embed
    Services --> LLM
    Cursor <--> MCP
```

### 主要コンポーネントの役割

-   **Gnosis Core**: MCP ツールのハンドリング、ビジネスロジックの実行、データベースとのやり取りを統括します。
-   **Embedding Service**: 外部の Python スクリプト。`multilingual-e5-small` を使用して、日本語を含むテキストの高品質なベクトル化を提供します。
-   **Local LLM**: MLX (Apple Silicon) または Ollama を介して、推論・要約・抽出を実行します。
-   **PostgreSQL + pgvector**: HNSW インデックスを使用した高速なベクトル検索と、構造化データの永続化を担います。

---

## データフロー

### 1. 記憶の永続化 (Memory Flow)
1. エージェントが `store_memory` を呼び出す。
2. Core がテキストを **Embedding Service** に送り、ベクトルを取得。
3. Core がテキスト + ベクトル + メタデータを `vibe_memories` テーブルに保存。

### 2. 知識の検索 (Search Flow)
1. `search_memory` 呼び出しにより、クエリをベクトル化。
2. `pgvector` の `cosine_similarity`（HNSW）を用いて、類似度の高い上位 N 件を高速に抽出。

### 3. 自律調査 (KnowFlow Pipeline)
1. `enqueue_knowledge_task` で調査トピックを投入。
2. Worker がキューをポーリングし、以下のステップを自律実行：
    - **Search**: ウェブ検索等で証拠を収集。
    - **Extraction**: LLM が証拠から「クレーム（事実断片）」を抽出。
    - **Verification**: 既存知識と照合・検証。
    - **Merging**: 重複排除して `knowledge_claims` テーブルへ統合。

---

## 技術選択の理由

| 技術 | 理由 |
| :--- | :--- |
| **Bun** | Node.js 互換でありながら、起動が極めて速く、TypeScript のネイティブ実行と優秀なテストランナーを備えているため。 |
| **Drizzle ORM** | 型安全性が高く、スキーマ管理が簡潔。pgvector 拡張のサポートが優れているため。 |
| **pgvector (HNSW)** | 汎用 RDBMS である PostgreSQL 上で、数ミリ秒でのベクトル検索が可能なため。 |
| **Python Sidecar** | 機械学習ライブラリ (MLX, sentence-transformers) のエコシステムを直接利用するため。 |

---

## データベーススキーマ概要 (10テーブル)

-   **記憶系**: `vibe_memories` (非構造化), `experience_logs` (失敗・成功)
-   **グラフ系**: `entities` (ノード), `relations` (エッジ), `communities` (クラスター)
-   **KnowFlow系**: `topic_tasks` (キュー), `knowledge_topics` (トピック), `knowledge_claims` (事実), `knowledge_relations` (トピック間), `knowledge_sources` (出典)
-   **その他**: `sync_state` (同期カーソル)
