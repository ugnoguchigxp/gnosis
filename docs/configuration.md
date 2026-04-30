# Configuration Reference

Gnosis は環境変数を中心に構成されています。一部の機能（KnowFlow）については、`.toml` プロファイルによる詳細設定も可能です。

## 構成別テンプレート

| 構成 | テンプレート | 用途 |
| :--- | :--- | :--- |
| minimal | `.env.minimal` | DB + embedding だけで最短起動する |
| local-llm | `.env.local-llm` | minimal に local LLM 運用設定を追加する |
| cloud-review | `.env.cloud-review` | minimal に cloud reviewer 設定を追加する |

推奨フロー:
1. `cp .env.minimal .env`
2. 必要に応じて `.env.local-llm` または `.env.cloud-review` の必要項目を `.env` へ追記

## 環境変数一覧

### 基本設定 (Core)

| 変数名 | デフォルト値 | 説明 |
| :--- | :--- | :--- |
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:7888/gnosis` | PostgreSQL 接続文字列 |
| `GNOSIS_BUN_COMMAND` | `bun` | 実行に使用する Bun バイナリのパス |
| `GNOSIS_LLM_TIMEOUT_MS` | `90000` | LLM 処理の標準タイムアウト |
| `GNOSIS_DOCTOR_REQUIRE_LOCAL_LLM` | `false` | `bun run doctor` で local-llm API 未起動を失敗扱いにするか |
| `GNOSIS_ENABLE_AUTOMATION` | `true` | LaunchAgent / background manager などの自動処理を実行するか。停止したい場合だけ `false` を指定 |
| `GNOSIS_BACKGROUND_WORKER_ENABLED` | `true` | background worker daemon の常駐処理を実行するか。停止したい場合だけ `false` を指定 |
| `GNOSIS_NO_WORKERS` | `false` | MCP host 内で background workers を起動しない。`scripts/setup-automation.sh` の `com.gnosis.mcp-host` は worker LaunchAgent との二重起動を避けるため `true` を指定 |
| `GNOSIS_MCP_HOST_REPLACE_EXISTING` | `false` | 起動時に既存 MCP host が健康な場合、それを shutdown して自プロセスが host を引き継ぐ。LaunchAgent の `KeepAlive` ループ防止用 |
| `ASTMEND_REPO_PATH` | `../Astmend` | MCP host が Astmend service factory を読み込むローカル repo path |
| `DIFFGUARD_REPO_PATH` | `../diffGuard` | MCP host が diffGuard service factory を読み込むローカル repo path |

### MCP クライアント互換

- MCP `tools/list` は Agent-First 公開面に固定されています。
- クライアント側のツールキャッシュ不整合が疑われる場合は、MCP サーバーとクライアントを再起動してください。
- macOS ログイン時から MCP host を常駐させる場合は `scripts/setup-automation.sh install` と `scripts/setup-automation.sh load` を実行します。`com.gnosis.mcp-host` は `RunAtLoad` / `KeepAlive` で起動し、stdio adapter はこの host へ接続します。既存の手動 host が残っている場合は LaunchAgent 側が shutdown して引き継ぎます。
- Gnosis MCP host は Gnosis / Astmend / diffGuard の service factory を同一 process に読み込みます。Codex 側では Astmend / diffGuard を個別 MCP server として起動せず、Gnosis adapter だけを登録します。

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
| `LOCAL_LLM_ALLOW_MLX_IN_SEATBELT` | `false` | `CODEX_SANDBOX=seatbelt` で MLX (`gemma4`/`bonsai`) を強制有効化するか（既定は安全のため無効） |
| `GNOSIS_CODEX_INITIAL_LOOKBACK_HOURS` | `0` | Codex 初回同期の対象期間。`0` は既存 JSONL を全件対象にする |

### Memory Loop (Local-first)

| 変数名 | デフォルト値 | 説明 |
| :--- | :--- | :--- |
| `MEMORY_LOOP_ALLOW_CLOUD` | `false` | ループ処理で cloud LLM（OpenAI/Bedrock）を許可するか |
| `MEMORY_LOOP_CLOUD_PROVIDER` | `openai` | cloud 利用時の優先プロバイダ（`openai` / `bedrock`） |
| `MEMORY_LOOP_DEFAULT_ALIAS` | `gemma4` | ループ処理の第一候補ローカルモデル |
| `MEMORY_LOOP_LIGHT_ALIAS` | `bonsai` | 軽量処理向けローカルモデル |
| `MEMORY_LOOP_INTERVAL_MS` | `300000` | ループ間隔（5分） |
| `MEMORY_LOOP_MAX_LOCAL_RETRIES` | `3` | ローカルLLMの再試行回数 |
| `MEMORY_LOOP_MIN_QUALITY_SCORE` | `0.5` | quality スコア閾値（cloud 切替判定） |
| `MEMORY_LOOP_IDLE_BACKOFF_MULTIPLIER` | `2` | idle 連続時の間隔倍率 |
| `MEMORY_LOOP_MAX_INTERVAL_MS` | `900000` | idle バックオフの上限間隔（15分） |
| `MEMORY_LOOP_ENABLE_DAILY_AUDIT` | `true` | 日次 KG 監査を有効化するか |
| `MEMORY_LOOP_ENABLE_WEEKLY_AUDIT` | `true` | 週次 KG 監査を有効化するか |
| `GNOSIS_MEMORY_LOOP_ALLOW_UNSAFE_MLX_IN_SEATBELT` | `false` | `CODEX_SANDBOX=seatbelt` でも memory loop 経路で `LOCAL_LLM_ALLOW_MLX_IN_SEATBELT=1` を保持するか（デバッグ専用） |

### KnowFlow ワーカー

| 変数名 | デフォルト値 | 説明 |
| :--- | :--- | :--- |
| `KNOWFLOW_WORKER_POLL_INTERVAL_MS` | `60000` | タスクキューの監視間隔 |
| `KNOWFLOW_WORKER_MAX_CONSECUTIVE_ERRORS` | `5` | 連続失敗時の自動停止閾値 |
| `KNOWFLOW_FRONTIER_ENABLED` | `true` | 既存 entity からの frontier 自動投入を有効にするか |
| `KNOWFLOW_FRONTIER_LLM_ENABLED` | `true` | frontier 候補の LLM 再順位付けを有効にするか |
| `KNOWFLOW_FRONTIER_MAX_TOPICS` | `3` | 1 tick で queue に投入する frontier topic の最大件数 |
| `KNOWFLOW_FRONTIER_SCAN_LIMIT` | `50` | frontier 候補生成時に見る entity 件数 |
| `KNOWFLOW_FRONTIER_MAX_PER_COMMUNITY` | `1` | 同一 community から選ぶ frontier topic の最大件数 |
| `USER_BUDGET` | `12` | ユーザー投入タスクの検索最大数 |
| `CRON_BUDGET` | `6` | 定期実行タスクの検索最大数 |

### Code Review

| 変数名 | デフォルト値 | 説明 |
| :--- | :--- | :--- |
| `GNOSIS_REVIEW_MCP_MODE` | `cli` | MCP `review` ツールの実行経路（`cli` / `inproc`）。`cli` は `src/scripts/review.ts` へ委譲 |
| `GNOSIS_REVIEW_ALLOW_UNSAFE_MLX_IN_SEATBELT` | `false` | `CODEX_SANDBOX=seatbelt` でも review 経路で `LOCAL_LLM_ALLOW_MLX_IN_SEATBELT=1` をそのまま使うか（デバッグ専用） |
| `GNOSIS_REVIEW_LLM_PROVIDER` | `azure-openai` | Cloud reviewer のプロバイダ（`openai` は Azure OpenAI alias。`azure-openai` / `bedrock` / `anthropic` / `google`） |
| `GNOSIS_REVIEW_LLM_API_BASE_URL` | プロバイダ依存 | Cloud reviewer の API base URL（Azure 利用時は必須） |
| `AWS_ACCESS_KEY_ID` | - | Bedrock 利用時の AWS access key |
| `AWS_SECRET_ACCESS_KEY` | - | Bedrock 利用時の AWS secret access key |
| `AWS_REGION` | - | Bedrock 利用時のリージョン（例: `ap-northeast-1`） |
| `GNOSIS_REVIEW_LLM_BEDROCK_MODEL_ID` | - | Bedrock モデルID |
| `GNOSIS_REVIEW_LLM_BEDROCK_INFERENCE_PROFILE_ID` | - | Bedrock Inference Profile ID |

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
