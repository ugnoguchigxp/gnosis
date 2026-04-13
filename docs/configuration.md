# Configuration Reference

Gnosis は環境変数を中心に構成されています。一部の機能（KnowFlow）については、`.toml` プロファイルによる詳細設定も可能です。

## 環境変数一覧

### 基本設定 (Core)

| 変数名 | デフォルト値 | 説明 |
| :--- | :--- | :--- |
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:7888/gnosis` | PostgreSQL 接続文字列 |
| `GNOSIS_BUN_COMMAND` | `bun` | 実行に使用する Bun バイナリのパス |
| `GNOSIS_LLM_TIMEOUT_MS` | `90000` | LLM 処理の標準タイムアウト |

### 埋め込み (Embedding)

| 変数名 | デフォルト値 | 説明 |
| :--- | :--- | :--- |
| `GNOSIS_EMBED_COMMAND` | `services/embedding/.venv/bin/embed` | ベクトル生成スクリプトのフルパス |
| `GNOSIS_EMBEDDING_DIMENSION` | `384` | ベクトルの次元数（モデルに合わせる必要があります） |
| `GNOSIS_EMBED_TIMEOUT_MS` | `30000` | 埋め込み生成のタイムアウト |

### ローカル LLM

| 変数名 | デフォルト値 | 説明 |
| :--- | :--- | :--- |
| `LOCAL_LLM_API_BASE_URL` | `http://127.0.0.1:44448` | ローカル LLM API のエンドポイント |
| `LOCAL_LLM_MODEL` | `gemma-4-e4b-it` | 使用するモデル名 |
| `LOCAL_LLM_ENABLE_CLI_FALLBACK` | `true` | API 失敗時にスクリプトを直接実行するか |
| `GNOSIS_LLM_SCRIPT` | `services/local-llm/scripts/gemma4` | 直接実行時のスクリプトパス |

### KnowFlow ワーカー

| 変数名 | デフォルト値 | 説明 |
| :--- | :--- | :--- |
| `KNOWFLOW_WORKER_POLL_INTERVAL_MS` | `60000` | タスクキューの監視間隔 |
| `KNOWFLOW_WORKER_MAX_CONSECUTIVE_ERRORS` | `5` | 連続失敗時の自動停止閾値 |
| `USER_BUDGET` | `12` | ユーザー投入タスクの検索最大数 |
| `CRON_BUDGET` | `6` | 定期実行タスクの検索最大数 |

### ガイダンス (Guidance Registry)

| 変数名 | デフォルト値 | 説明 |
| :--- | :--- | :--- |
| `GUIDANCE_ENABLED` | `true` | ガイダンス注入機能を有効にするか |
| `GUIDANCE_INBOX_DIR` | `imports/guidance/inbox` | ZIP インポートの監視ディレクトリ |
| `GUIDANCE_MIN_SIMILARITY` | `0.72` | プロンプト注入時の類似度閾値 |

---

## プロファイル設定 (profiles/*.toml)

KnowFlow CLI では `--profile <name>` を指定することで、プロジェクトごとに設定を切り替えられます。
設定ファイルは `profiles/` ディレクトリ内に配置します。

### 例: `profiles/research.toml`

```toml
[knowflow.llm]
apiBaseUrl = "http://127.0.0.1:44448"
model = "gemma-4-e4b-it"
temperature = 0

[knowflow.budget]
userBudget = 50      # 通常より多くの検索を許可
cronBudget = 10
```

### 優先順位

1.  CLI 引数 (フラグ)
2.  `--profile` で指定された TOML ファイル
3.  `.env` ファイル（または環境変数）
4.  `src/config.ts` のハードコードされたデフォルト値
