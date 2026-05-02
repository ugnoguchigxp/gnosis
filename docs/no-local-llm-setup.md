# Local LLM なしセットアップ

この手順は、Gemma4 / Bonsai / Qwen などの local LLM を入れずに Gnosis の最小価値を確認するための導入です。

## 位置づけ

local LLM なしでも使えるもの:

- Agent-First MCP primary tools
- `doctor` による状態確認
- `search_knowledge` による既存 knowledge 検索
- `record_task_note` による再利用知識の保存
- PostgreSQL + pgvector
- embedding CLI による memory / graph のベクトル検索
- cloud-review 設定後の `agentic_search` / `review_task`

local LLM 設定後に増えるもの:

- Gemma4 / Bonsai / Qwen のローカル推論
- local provider による `review_task`
- KnowFlow の LLM rerank
- memory loop のローカル LLM 処理
- `LOCAL_LLM_API_BASE_URL` を使う OpenAI-compatible local API

embedding CLI は local LLM ではありません。Gnosis の memory / graph 検索に必要な 384 次元ベクトルを作るための軽量な embedding 導線です。

## 前提条件

- Bun 1.1+
- Docker
- Python 3.10+

local LLM 用の `services/local-llm/.venv`、MLX runtime、Gemma4/Bonsai モデル、local LLM API は不要です。

## セットアップ

```bash
git clone https://github.com/ugnoguchigxp/gnosis.git
cd gnosis
bun run bootstrap
bun run doctor
bun run onboarding:smoke
```

`bun run bootstrap` は minimal profile を準備します。ローカル LLM を入れない場合は `bun run bootstrap:local-llm` を実行しません。

## Cloud Review を使う場合

local LLM を入れずに `agentic_search` や `review_task` の LLM レビュー導線を使う場合は、cloud reviewer を設定します。

`.env.cloud-review` を参考に、既存の `.env` へ必要な値だけ追加してください。API key などの secret はリポジトリへコミットしません。

代表的な設定項目:

```bash
GNOSIS_REVIEW_LLM_PROVIDER=azure-openai
GNOSIS_REVIEW_LLM_API_BASE_URL=https://your-resource.openai.azure.com
GNOSIS_REVIEW_LLM_API_VERSION=2025-04-01-preview
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_MODEL=...
```

## 実行確認

```bash
bun run doctor
bun run monitor:snapshot
```

期待値:

- `python`, `docker compose`, `DATABASE_URL connection` が OK
- `GNOSIS_EMBED_COMMAND` が OK
- `MCP tool exposure` が OK
- `local-llm health` は `skipped` でもよい
- `monitor:snapshot` の `automation.localLlmConfigured` は `false` でもよい

## 避けること

- `bun run bootstrap:local-llm` を実行しない
- `LOCAL_LLM_API_BASE_URL` を設定しない
- `services/local-llm/scripts/run_openai_api.sh` を起動しない
- `gemma4` / `qwen` / `bonsai` の利用を前提にしない

local LLM が必要になった時点で、`bun run bootstrap:local-llm` に切り替えてください。
