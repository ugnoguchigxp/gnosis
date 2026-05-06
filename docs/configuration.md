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
| `GNOSIS_BACKGROUND_WORKER_MAX_CONCURRENCY` | `2` | background worker の同時処理枠。LLM 実行は local-llm daemon の single-thread queue 側で直列化する |
| `GNOSIS_NO_WORKERS` | `false` | MCP host 内で background workers を起動しない。`scripts/setup-automation.sh` の `com.gnosis.mcp-host` は worker LaunchAgent との二重起動を避けるため `true` を指定 |
| `GNOSIS_MCP_HOST_REPLACE_EXISTING` | `false` | 起動時に既存 MCP host が健康な場合、それを shutdown して自プロセスが host を引き継ぐ。LaunchAgent の `KeepAlive` ループ防止用 |
| `GNOSIS_MCP_HOST_REQUEST_TIMEOUT_MS` | `330000` | shared MCP host の1リクエスト上限。MCP `review_task` の既定 LLM timeout より長くし、host が先に切れないようにする |
| `ASTMEND_REPO_PATH` | `../Astmend` | MCP host が Astmend service factory を読み込むローカル repo path |
| `DIFFGUARD_REPO_PATH` | `../diffGuard` | MCP host が diffGuard service factory を読み込むローカル repo path |

### MCP クライアント互換

- Gnosis 本体の primary tool surface は Agent-First の6件に固定されています。
- stdio adapter の `tools/list` は shared host へ forward され、Gnosis / Astmend / diffGuard の service tools を集約して返します。
- クライアント側のツールキャッシュ不整合が疑われる場合は、MCP サーバーとクライアントを再起動してください。
- macOS ログイン時から MCP host を常駐させる場合は `scripts/setup-automation.sh install` と `scripts/setup-automation.sh load` を実行します。`com.gnosis.mcp-host` は `RunAtLoad` / `KeepAlive` で起動し、stdio adapter はこの host へ接続します。既存の手動 host が残っている場合は LaunchAgent 側が shutdown して引き継ぎます。
- Gnosis MCP host は Gnosis / Astmend / diffGuard の service factory を同一 process に読み込みます。Codex 側では Astmend / diffGuard を個別 MCP server として起動せず、Gnosis adapter だけを登録します。

### 埋め込み (Embedding)

| 変数名 | デフォルト値 | 説明 |
| :--- | :--- | :--- |
| `GNOSIS_EMBED_COMMAND` | `services/embedding/.venv/bin/embed` | ベクトル生成スクリプトのフルパス |
| `GNOSIS_EMBED_DAEMON_URL` | `http://127.0.0.1:44512` | 常駐embedding daemonのURL。空文字を明示するとdaemonを使わずCLI fallbackのみ |
| `GNOSIS_EMBED_DAEMON_TIMEOUT_MS` | `5000` | daemon呼び出しのタイムアウト |
| `GNOSIS_EMBED_HIGH_CONCURRENCY` | `8` | MCP/search/review query embedding用の同時実行上限 |
| `GNOSIS_EMBED_NORMAL_CONCURRENCY` | `2` | 通常登録embedding用の同時実行上限 |
| `GNOSIS_EMBED_BACKGROUND_CONCURRENCY` | `1` | 背景補完embedding用の同時実行上限 |
| `GNOSIS_EMBED_BACKGROUND_CHUNK_SIZE` | `8` | 背景補完の1 daemon requestあたりの最大件数 |
| `GNOSIS_EMBEDDING_DIMENSION` | `384` | ベクトルの次元数（モデルに合わせる必要があります） |
| `GNOSIS_EMBED_TIMEOUT_MS` | `30000` | 埋め込み生成のタイムアウト |

### ローカル LLM

| 変数名 | デフォルト値 | 説明 |
| :--- | :--- | :--- |
| `LOCAL_LLM_API_BASE_URL` | `http://127.0.0.1:44448` | ローカル LLM API のエンドポイント |
| `LOCAL_LLM_MODEL` | `gemma-4-e4b-it` | 使用するモデル名 |
| `LOCAL_LLM_ENABLE_CLI_FALLBACK` | `false` | API 失敗時にスクリプトを直接実行するか。通常運用では daemon 1本に集約するため無効 |
| `GNOSIS_LLM_SCRIPT` | `services/local-llm/scripts/gemma4` | 直接実行時のスクリプトパス |
| `GNOSIS_LLM_CONCURRENCY_LIMIT` | `1` | `gemma4` / `bonsai` 等のローカルLLMプロセス同時実行上限。daemon single-thread 前提のため、1より大きい値は1に丸める |
| `LOCAL_LLM_DAEMON_PRELOAD` | `true` | local-llm daemon 起動時にモデルを読み込んで ready 状態にする |
| `LOCAL_LLM_DAEMON_REQUEST_TIMEOUT_MS` | `900000` | daemon 内部 single-thread queue の1リクエスト待機上限 |
| `LOCAL_LLM_ALLOW_MLX_IN_SEATBELT` | `false` | `CODEX_SANDBOX=seatbelt` で MLX (`gemma4`/`bonsai`) を強制有効化するか（既定は安全のため無効） |

local-llm は `com.gnosis.local-llm` LaunchAgent で1プロセスだけ常駐します。HTTP リクエストは TypeScript 側で直列化せず、daemon 内部の single-worker priority queue に登録されます。追加の poll 間隔を置かず、queue に入ったものから直ちに処理対象になります。CLI fallback を明示的に有効化した場合だけ、プロセス起動を `GNOSIS_LLM_CONCURRENCY_LIMIT=1` のセマフォで守ります。
| `GNOSIS_CODEX_INITIAL_LOOKBACK_HOURS` | `0` | Codex 初回同期の対象期間。`0` は既存 JSONL を全件対象にする |

### Memory Loop (Local-first)

| 変数名 | デフォルト値 | 説明 |
| :--- | :--- | :--- |
| `MEMORY_LOOP_ALLOW_CLOUD` | `false` | ループ処理で cloud LLM（OpenAI/Bedrock）を許可するか |
| `MEMORY_LOOP_CLOUD_PROVIDER` | `openai` | cloud 利用時の優先プロバイダ（`openai` / `bedrock`） |
| `MEMORY_LOOP_DEFAULT_ALIAS` | `gemma4` | ループ処理の第一候補ローカルモデル |
| `MEMORY_LOOP_LIGHT_ALIAS` | `bonsai` | 軽量処理向けローカルモデル |
| `MEMORY_LOOP_INTERVAL_MS` | `300000` | ループ間隔（5分） |
| `MEMORY_LOOP_MAX_LOCAL_RETRIES` | `1` | ローカルLLMの再試行回数 |
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
| `KNOWFLOW_WORKER_PARALLELISM` | `3` | worker loop 数。実効値は `GNOSIS_BACKGROUND_WORKER_MAX_CONCURRENCY` 以下に制限される |
| `KNOWFLOW_WORKER_MAX_CONSECUTIVE_ERRORS` | `5` | 連続失敗時の自動停止閾値 |
| `KNOWFLOW_KEYWORD_CRON_ENABLED` | `true` | Phrase Scout による新規調査フレーズ投入を有効にするか |
| `KNOWFLOW_KEYWORD_CRON_MAX_TOPICS` | `10` | 1 回の Phrase Scout で queue に投入する最大 topic 数 |
| `KNOWFLOW_KEYWORD_CRON_LOOKBACK_HOURS` | `168` | Phrase Scout が最近の作業ログを見る時間幅 |
| `KNOWFLOW_PHRASE_SCOUT_INTERVAL_MS` | `GNOSIS_BACKGROUND_WORKER_INTERVAL_MS` | 常駐 worker で Phrase Scout を走らせる間隔 |

### Code Review

| 変数名 | デフォルト値 | 説明 |
| :--- | :--- | :--- |
| `GNOSIS_REVIEW_MCP_MODE` | `cli` | MCP `review` ツールの実行経路（`cli` / `inproc`）。`cli` は `src/scripts/review.ts` へ委譲 |
| `GNOSIS_REVIEW_ALLOW_UNSAFE_MLX_IN_SEATBELT` | `false` | `CODEX_SANDBOX=seatbelt` でも review 経路で `LOCAL_LLM_ALLOW_MLX_IN_SEATBELT=1` をそのまま使うか（デバッグ専用） |
| `GNOSIS_REVIEW_LLM_PROVIDER` | `azure-openai` | Cloud reviewer のプロバイダ（`openai` は Azure OpenAI alias。`azure-openai` / `bedrock` / `anthropic` / `google`） |
| `GNOSIS_MCP_REVIEW_LLM_TIMEOUT_MS` | `300000` | MCP `review_task` から呼ぶ review LLM の同期 timeout。local provider が最大5分考えられる値にしている |
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
```

### 優先順位

1.  CLI 引数 (フラグ)
2.  `--profile` で指定された TOML ファイル
3.  `.env` ファイル（または環境変数）
4.  `src/config.ts` のハードコードされたデフォルト値
