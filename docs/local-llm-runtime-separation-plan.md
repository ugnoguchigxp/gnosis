# localLlm 分離計画

## 目的

Gemma4 / Bonsai / embedding のモデル実行基盤を Gnosis から分離し、Gnosis は外部 runtime の consumer に徹する。

現在の Gnosis は memory / knowledge / MCP / KnowFlow を持つプロダクトであり、MLX モデル、local LLM daemon、embedding daemon の起動・配布・依存管理まで抱えると責務が膨らみすぎる。分離後は、Gnosis 側は OpenAI-compatible API、embedding HTTP API、必要最小限の CLI contract だけを参照する。

## 方針

- local LLM daemon と embedding daemon の起動責務は Gnosis から外す。
- `services/local-llm` と `services/embedding` は新しい `localLlm` repo に移す。
- Gnosis 側に残すのは、Gnosis DB を読む・書く処理だけにする。
- MCP は規格どおりの外部接続面として扱い、localLlm repo から Gnosis MCP server を任意接続できるようにする。
- 長期互換のために同じ実装を二重保持しない。移行後は Gnosis 内の旧 runtime 実体を削除する。

## 対象範囲

### localLlm repo に移すもの

- Gemma4 / Qwen / Bonsai の Python runtime
- MLX / mlx-vlm / MTP / Bonsai backend
- CLI chat loop と streaming 表示
- OpenAI-compatible API daemon
- embedding CLI / daemon / model download
- shared daemon queue
- runtime 用 launchd plist / setup / health check
- optional MCP client bridge

### Gnosis に残すもの

- Gnosis MCP server
- memory / entity / review / KnowFlow / Monitor
- pgvector schema と DB 操作
- embedding batch worker
  - これは Gnosis DB の未埋め込み row を埋める Gnosis 側 worker なので残す。
  - ただし embedding 生成自体は外部 localLlm embedding API を呼ぶ。
- external runtime の health / configuration check

## 目標構成

```text
~/Code/localLlm/
  README.md
  .env.example
  pyproject.toml
  requirements.txt
  requirements.lock
  shared/
    daemon_queue.py
  llm/
    api/
    backends/
    core/
    vibe_mcp/
    main.py
    tools.py
  embedding/
    e5embed/
    models/
    scripts/
    tests/
  scripts/
    setup.sh
    gemma4
    qwen
    bonsai
    run_openai_api.sh
    run_embedding_daemon.sh
    install_path.sh
  launchd/
    com.localLlm.llm.plist
    com.localLlm.embedding.plist
  examples/
    mcp.gnosis.json
```

Gnosis 側は以下のように外部 contract だけを見る。

```text
LOCAL_LLM_API_BASE_URL=http://127.0.0.1:44448
LOCAL_LLM_API_PATH=/v1/chat/completions
LOCAL_LLM_MODEL=gemma-4-e4b-it
LOCAL_LLM_API_KEY_ENV=LOCAL_LLM_ACCESS_TOKEN

GNOSIS_EMBED_DAEMON_URL=http://127.0.0.1:44512
GNOSIS_EMBED_API_KEY_ENV=LOCAL_LLM_ACCESS_TOKEN
GNOSIS_EMBED_COMMAND=embed

GNOSIS_GEMMA4_SCRIPT=gemma4
GNOSIS_BONSAI_SCRIPT=bonsai
```

## 外部 contract

### LLM API

localLlm repo が提供する。

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- request fields:
  - `model`
  - `messages`
  - `stream`
  - `temperature`
  - `max_tokens`
  - `tools`
  - `priority`
- response fields:
  - OpenAI-compatible `choices`
  - `usage.prompt_tokens`
  - `usage.completion_tokens`
  - `usage.total_tokens`
- Gnosis 側はこの API を主経路にする。
- CLI fallback は明示的に有効化された場合だけ使う。

### 認証

localLlm repo は OpenAI-compatible な Bearer token 認証を提供する。

```http
Authorization: Bearer <access-token>
```

localLlm 側:

```text
LOCAL_LLM_REQUIRE_AUTH=true
LOCAL_LLM_ACCESS_TOKEN=...
```

Gnosis 側:

```text
LOCAL_LLM_API_KEY_ENV=LOCAL_LLM_ACCESS_TOKEN
LOCAL_LLM_ACCESS_TOKEN=...
```

Gnosis の chat completions client は `LOCAL_LLM_API_KEY_ENV` が指す環境変数から token を読み、HTTP request に `Authorization: Bearer ...` を付ける。token は `.env` に置き、docs や generated config には値を出さない。

### Embedding API

localLlm repo が提供する。

- `GET /health`
- `POST /embed`
- `POST /v1/embeddings`
- request:

```json
{
  "texts": ["..."],
  "type": "query",
  "priority": "high",
  "normalize": true
}
```

- response:

```json
{
  "embeddings": [[0.1, 0.2]],
  "dimension": 384,
  "count": 1,
  "type": "query",
  "normalize": true,
  "queueWaitMs": 0.0,
  "encodeMs": 6.0
}
```

OpenAI-compatible embeddings endpoint も提供する。

```json
{
  "model": "multilingual-e5-small",
  "input": ["hello"]
}
```

```json
{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "index": 0,
      "embedding": [0.1, 0.2]
    }
  ],
  "model": "multilingual-e5-small",
  "usage": {
    "prompt_tokens": 1,
    "total_tokens": 1
  }
}
```

Gnosis は `GNOSIS_EMBED_DAEMON_URL` が設定されていれば daemon を使う。daemon が未設定または利用不可の場合だけ `GNOSIS_EMBED_COMMAND` の CLI fallback を試す。どちらも使えない場合は、検索系は degraded として継続し、書き込み系は embedding を `null` にできる場所では `null` 保存へ倒す。

embedding daemon にも chat completions と同じ Bearer token を使えるようにする。

```text
GNOSIS_EMBED_API_KEY_ENV=LOCAL_LLM_ACCESS_TOKEN
LOCAL_LLM_ACCESS_TOKEN=...
```

Gnosis の embedding client は `GNOSIS_EMBED_API_KEY_ENV` が指す環境変数から token を読み、`/embed` または `/v1/embeddings` への request に `Authorization: Bearer ...` を付ける。

### CLI

PATH 上の外部 command として扱う。

- `gemma4 --prompt "..." --output text`
- `bonsai --prompt "..." --output text`
- `qwen --prompt "..." --output text`
- `embed "text"`
- `e5embed --type query --text "..."`

Gnosis は repo 内 Python path を組み立てない。

### MCP

localLlm は任意の MCP server に接続できる client を持つ。Gnosis は MCP server を提供するだけで、localLlm 側に内蔵されない。

localLlm 側の設定例:

```json
{
  "servers": [
    {
      "name": "gnosis",
      "command": "bun",
      "args": ["run", "/Users/y.noguchi/Code/gnosis/src/index.ts"],
      "cwd": "/Users/y.noguchi/Code/gnosis",
      "env": {
        "GNOSIS_NO_WORKERS": "true"
      }
    }
  ]
}
```

## Gnosis 側の変更計画

### 1. 設定 default を外部 runtime 前提に変える

対象:

- `src/constants.ts`
- `src/config.ts`
- `.env.example`
- `.env.minimal`
- `.env.local-llm`
- `docs/configuration.md`

変更:

- `LLM_SCRIPT_DEFAULT` を `gemma4` にする。
- `BONSAI_SCRIPT_DEFAULT` を `bonsai` にする。
- `EMBED_COMMAND_DEFAULT` を `embed` にする、または未設定扱いにできるようにする。
- `LOCAL_LLM_PATH_DEFAULT` は削除または deprecated にする。
- `GNOSIS_LOCAL_LLM_PATH` 前提のコードを段階的に削除する。
- `LOCAL_LLM_API_BASE_URL` と `GNOSIS_EMBED_DAEMON_URL` を Gnosis の external dependency として明記する。
- `LOCAL_LLM_API_KEY_ENV` と `GNOSIS_EMBED_API_KEY_ENV` を追加し、OpenAI-compatible endpoint / embedding endpoint の token 参照を env 名で指定する。

### 2. Gnosis bootstrap から runtime install を削除する

対象:

- `scripts/bootstrap.ts`
- `scripts/bootstrap-local-llm.ts`
- `scripts/setup-services.sh`
- `scripts/register-path.sh`
- `package.json`

変更:

- `bun run bootstrap` は DB と Gnosis 依存だけを準備する。
- embedding venv を Gnosis 内に作らない。
- `bootstrap:local-llm` は削除するか、外部 localLlm runtime の検出・案内だけに縮小する。
- PATH 登録は `gemma4` / `bonsai` / `embed` の存在確認だけにする。
- `local-llm:daemon` script は Gnosis から削除する。

### 3. Gnosis LaunchAgent から daemon 起動を削除する

対象:

- `scripts/setup-automation.sh`
- `scripts/automation/com.gnosis.local-llm.plist`
- `scripts/automation/com.gnosis.embedding-daemon.plist`
- `scripts/automation/com.gnosis.embedding-batch.plist`

変更:

- `com.gnosis.local-llm.plist` は削除する。
- `com.gnosis.embedding-daemon.plist` は削除する。
- `setup-automation.sh` の `PLISTS` から上記2つを外す。
- `com.gnosis.embedding-batch.plist` は残す。
  - これは Gnosis DB を埋める worker なので Gnosis の責務。
  - ただし `GNOSIS_EMBED_DAEMON_URL` は外部 localLlm embedding daemon を指す。

### 4. Gnosis runtime health を consumer 観点に変える

対象:

- `scripts/doctor.ts`
- `src/scripts/monitor-snapshot.ts`
- `docs/no-local-llm-setup.md`
- `docs/startup.md`
- `docs/operations-runbook.md`

変更:

- local LLM / embedding daemon は「Gnosis が起動するもの」ではなく「外部 dependency」として表示する。
- strict mode でだけ external runtime の応答を必須にする。
- default doctor は、未設定なら `skipped`、設定済みで応答なしなら `WARN` にする。
- Gnosis 管理 LaunchAgent の一覧から local LLM / embedding daemon を外す。

### 5. 直接 path 依存を削除する

対象:

- `src/scripts/local-llm-cli.ts`
- `src/services/review/llm/localProvider.ts`
- `src/services/memoryLoopLlmRouter.ts`
- `src/adapters/retriever/mcpRetriever.ts`
- `src/scripts/worker.ts`
- `src/services/background/manager.ts`
- `src/services/background/runner.ts`
- `src/services/knowflow/cli.ts`
- tests

変更:

- repo 内 `services/local-llm/main.py` を直接呼ばない。
- `resolveLauncherPlan()` は外部 command を返す。
- `createLocalLlmRetriever(config.localLlmPath)` は Gnosis の Bun MCP tools server か web tools client に置き換える。
- `GNOSIS_LOCAL_LLM_PATH` を runtime path ではなく、必要なら external runtime discovery 用の deprecated env として一時的に扱う。

### 6. `services/local-llm` と `services/embedding` を削除する

条件:

- localLlm repo 側で CLI/API/embedding daemon が動く。
- Gnosis 側の tests が external contract 前提に更新済み。
- Gnosis docs が external runtime 前提になっている。

削除対象:

- `services/local-llm`
- `services/embedding`
- Gnosis 内の local runtime 用 requirements / setup / README
- 内包 runtime 前提の tests

## localLlm 側の変更計画

### 1. shared queue を localLlm repo に移す

現状の `services/shared/daemon_queue.py` は Gnosis 側にある。LLM daemon と embedding daemon の両方が使うため、新 repo の `shared/daemon_queue.py` に置く。

### 2. Gnosis 固有 env / path を除去する

対象例:

- `GNOSIS_MCP_SERVER_ROOT`
- `GNOSIS_LOCAL_LLM_ENABLED`
- `GNOSIS_EMBEDDING_DAEMON_ENABLED`
- `services/local-llm/.debug`

方針:

- runtime 自身の env は `LOCAL_LLM_*` / `E5_*` に寄せる。
- Gnosis 連携は example config に閉じ込める。
- log path は localLlm repo の `logs/` または env 指定にする。

### 3. embedding を localLlm repo 内 service にする

移植対象:

- `services/embedding/e5embed`
- `services/embedding/scripts`
- `services/embedding/tests`
- `services/embedding/models` は git 管理対象から外し、download script で取得する。
- `services/embedding/requirements.txt`
- `services/embedding/requirements.lock`

新配置:

```text
localLlm/embedding/e5embed
localLlm/embedding/scripts/download_model.py
localLlm/embedding/tests
localLlm/scripts/run_embedding_daemon.sh
```

### 4. daemon 起動を localLlm repo の責務にする

localLlm repo に以下を持たせる。

- `scripts/run_openai_api.sh`
- `scripts/run_embedding_daemon.sh`
- `scripts/setup_launch_agents.sh`
- `launchd/com.localLlm.llm.plist`
- `launchd/com.localLlm.embedding.plist`

Gnosis からはこれらを呼ばない。

### 5. localLlm health command を提供する

例:

```bash
localLlm doctor
localLlm status
curl http://127.0.0.1:44448/health
curl http://127.0.0.1:44512/health
```

Gnosis の `doctor` はこの結果を参照するだけにする。

## 移行ステップ

### Phase 0: contract freeze

- Gnosis 側の現行 contract を doc 化する。
- LLM API / embedding API / CLI の fixture tests を用意する。
- `bun run verify` を baseline として通す。

### Phase 1: localLlm repo 作成

- Gnosis から `services/local-llm` をコピーする。
- Gnosis から `services/embedding` をコピーする。
- `services/shared/daemon_queue.py` を `shared/daemon_queue.py` としてコピーする。
- Gnosis 固有 path/env を除去する。
- localLlm repo 単独で以下を通す。

```bash
python -m pytest embedding/tests -q
python llm/scripts/test_tool_parsing.py
./scripts/gemma4 --prompt "hello" --no-mcp --output text
./scripts/run_embedding_daemon.sh
./scripts/run_openai_api.sh
```

### Phase 2: Gnosis を外部 runtime 参照に切り替える

- Gnosis の config default を外部 command/API に変更する。
- `src/scripts/local-llm-cli.ts` を外部 command wrapper にする。
- `src/services/memory.ts` は external embedding API/CLI だけを見る。
- `src/services/memory.ts` は `GNOSIS_EMBED_API_KEY_ENV` を見て Bearer token を付与する。
- `scripts/doctor.ts` を external dependency check に変える。
- `bun run verify` を通す。

### Phase 3: Gnosis の daemon 起動責務を削除する

- local LLM / embedding daemon の LaunchAgent を Gnosis から削除する。
- `scripts/setup-automation.sh` から daemon plist を外す。
- docs を更新する。
- `scripts/setup-automation.sh status` が Gnosis 管理 job だけを表示することを確認する。

### Phase 4: 内包 runtime を削除する

- `services/local-llm` を削除する。
- `services/embedding` を削除する。
- 旧 bootstrap / PATH 登録 / tests を削除または外部 contract tests に置換する。
- `bun run verify:strict` を通す。

### Phase 5: 運用切替

- localLlm repo 側の LaunchAgent を install/load する。
- Gnosis 側で external runtime を参照する `.env` を設定する。
- Gnosis の DB worker / MCP / KnowFlow は外部 daemon を consumer として使う。

## 検証計画

### localLlm repo

```bash
python -m pytest embedding/tests -q
python llm/scripts/test_tool_parsing.py
./scripts/gemma4 --prompt "hello" --no-mcp --output text
./scripts/bonsai --prompt "hello" --no-mcp --output text
curl -fsS http://127.0.0.1:44448/health
curl -fsS http://127.0.0.1:44512/health
curl -fsS http://127.0.0.1:44512/embed \
  -H 'content-type: application/json' \
  -d '{"texts":["hello"],"type":"query","priority":"high","normalize":true}'
```

### Gnosis

```bash
bun run doctor
GNOSIS_DOCTOR_REQUIRE_LOCAL_LLM=true bun run doctor
bun run verify
bun run verify:strict
```

追加 smoke:

```bash
LOCAL_LLM_API_BASE_URL=http://127.0.0.1:44448 bun run task:knowflow:once
GNOSIS_EMBED_DAEMON_URL=http://127.0.0.1:44512 bun run agentic-search -- "Gnosis MCP tools"
```

## リスクと対策

| リスク | 対策 |
| --- | --- |
| Gnosis の fresh clone が embedding なしで弱くなる | vector 検索は degraded、LIKE fallback を明示。strict doctor でのみ必須化する |
| daemon 起動場所が分からなくなる | localLlm repo に `doctor` / `status` / launchd docs を置く |
| CLI fallback が PATH 依存で壊れる | Gnosis doctor で `gemma4` / `bonsai` / `embed` の解決結果を表示する |
| MCP 接続が Gnosis 固有に戻る | localLlm 側は MCP config ファイルだけを読む。Gnosis 接続は example 扱いにする |
| 二重保守になる | Gnosis 側の内包 runtime は Phase 4 で物理削除する |

## 完了条件

- Gnosis repo に `services/local-llm` と `services/embedding` が存在しない。
- Gnosis の LaunchAgent から local LLM daemon と embedding daemon が消えている。
- localLlm repo 単体で LLM API と embedding API を起動できる。
- Gnosis は外部 API / CLI が未設定でも起動でき、設定済みなら vector / local LLM 機能を使える。
- `bun run verify` と `bun run verify:strict` が通る。
