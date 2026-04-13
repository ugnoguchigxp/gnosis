# KnowFlow 運用ガイド

KnowFlow は、ウェブ検索と LLM を組み合わせて、特定のトピックに関する信頼性の高い知識を自律的に収集・統合するエンジンです。

## 主要な概念

-   **トピック (Topic)**: 調査の対象となるキーワード（例: "Bun runtime", "Model Context Protocol"）。
-   **タスク (Task)**: 特定のトピックを調査するための最小単位。
-   **キュー (Queue)**: 実行待ちのタスクを保持する PostgreSQL 上のテーブル (`topic_tasks`)。
-   **ワーカー (Worker)**: キューからタスクを拾い、ウェブ検索・証拠抽出・検証・マージの一連のパイプラインを実行するプロセス。
-   **予算 (Budget)**: 1 回の調査での最大クエリ数や LLM 呼び出し回数の制限。

---

## CLI コマンド

すべてのコマンドは `bun run src/services/knowflow/cli.ts` を介して実行されます。

### 1. タスクの投入 (`enqueue`)
調査したいトピックをキューに追加します。

```bash
bun run src/services/knowflow/cli.ts enqueue --topic "Bun runtime" --mode directed --priority 100
```
-   `--mode`: `directed` (標準), `expand` (関連トピックも調査), `explore` (未踏領域の探索)。

### 2. 単発実行 (`run-once`)
キューからタスクを 1 つ取り出して、その場でパイプラインを実行します。

```bash
bun run src/services/knowflow/cli.ts run-once
```

### 3. デーモン実行 (`run-worker`)
一定間隔でキューを監視し、タスクがあれば実行し続けます。

```bash
bun run src/services/knowflow/cli.ts run-worker --interval-ms 60000
```

### 4. 知識の検索 (`search-knowledge`)
収集された確証済みの事実を検索します。

```bash
bun run src/services/knowflow/cli.ts search-knowledge --query "Bun SQLite support"
```

### 5. 詳細の取得 (`get-knowledge`)
特定のトピックに関するすべての情報を JSON 形式で取得します。

```bash
bun run src/services/knowflow/cli.ts get-knowledge --topic "Bun runtime"
```

---

## 評価パイプライン (`eval-run`)

KnowFlow の「知識抽出の質」を評価するためのスイートを実行します。

```bash
bun run src/services/knowflow/cli.ts eval-run --suite local --mock
```
-   `--mock`: 実際の LLM を呼び出さず、テスト用データを使用してパイプラインの動作のみを確認します。

---

## トラブルシューティング

-   **タスクが `failed` になる**: LLM API のタイムアウトやウェブ検索のレートリミットが原因の可能性があります。`topic_tasks` テーブルの `status` とエラーログを確認してください。
-   **知識がマージされない**: `dedupeThreshold`（デフォルト 0.9）が厳しすぎると、類似した知識が別物として扱われることがあります。`config.ts` で数値を調整してください。
