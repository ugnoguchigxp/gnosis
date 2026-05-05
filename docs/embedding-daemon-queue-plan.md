# Embedding Daemon + 専用Queue 計画

## 目的

embeddingをLLM実行queueから分離し、MCP由来の検索クエリを待たせずに処理できるようにする。

この計画は実行基盤だけを扱う。`search_knowledge` の検索品質改善や `review_task` のknowledge injection改善は `docs/knowledge-retrieval-improvement-plan.md` で扱う。

## 背景

現行の `generateEmbedding()` は `llm-pool` を使っており、local LLM / review LLM と同じ同時実行枠を奪い合う。さらにCLI方式では、1回のembeddingごとにPython起動、`sentence_transformers` import、モデルロードが走る。

実測では、100文字前後のクエリ1本のCLI実行は約3.2秒から3.4秒だった。一方、モデルロード後のencode自体は単発で数msから数十msだった。

## 方針

### 1. embedding daemonを常時Readyにする

- `multilingual-e5-small` を起動時にロードする。
- HTTPで `/health` と `/embed` を提供する。
- `/embed` は `texts[]`, `type=query|passage`, `priority=high|normal|low` を受ける。
- daemon内部でpriority queueを持つ。
- 既存CLIはfallbackとして残す。

### 2. LLM queueとembedding queueを分離する

- LLM: local-llm daemon の single-thread priority queue（API request はTS側で事前直列化せず、daemon queueに直接積む）
- embedding high: `embedding-high-pool`
- embedding normal: `embedding-normal-pool`
- embedding background: `embedding-background-pool`

MCP由来の検索クエリは `high`、保存時の通常embeddingは `normal`、背景補完は `low` にする。

### 3. 背景embeddingは低優先度batchにする

対象:

- `entities`
- `experience_logs`
- `session_knowledge_candidates`

これらのNULL embedding補完は `priority=low` でbatch実行し、MCP検索を塞がない。

## 実装済み

- `services/embedding/e5embed/daemon.py`
  - 常駐HTTP daemon
  - daemon内部 priority queue
  - batch embedding
- `services/embedding/tests/test_daemon.py`
  - query prefix
  - batch result
  - priority order
- `scripts/automation/com.gnosis.embedding-daemon.plist`
  - macOS LaunchAgentでdaemonを常時起動
  - `RunAtLoad` / `KeepAlive`
- `scripts/automation/com.gnosis.embedding-batch.plist`
  - 5分ごとにNULL embedding補完を別プロセスで実行
  - `GNOSIS_EMBED_BATCH_SIZE=50`
- `src/services/memory.ts`
  - daemon優先、CLI fallback
  - `generateEmbeddings()`
  - embedding専用セマフォ
  - `type=query|passage`
  - `priority=high|normal|low`
- `src/services/background/tasks/embeddingBatchTask.ts`
  - 低優先度batch embedding
  - low priority batchを小さなchunkに分け、daemon queueがhigh priority queryを割り込ませられるようにする
- `package.json`
  - `bun run embedding:daemon`
  - `bun run embedding:batch`
- `scripts/setup-automation.sh`
  - `install` / `load` / `status` の対象に embedding daemon と embedding batch worker を追加

## 起動

```bash
bun run embedding:daemon
```

LaunchAgentとして常時起動する場合:

```bash
scripts/setup-automation.sh install
scripts/setup-automation.sh load
scripts/setup-automation.sh status
```

別プロセスからdaemonを明示指定する場合:

```bash
export GNOSIS_EMBED_DAEMON_URL=http://127.0.0.1:44512
```

`GNOSIS_EMBED_DAEMON_URL` 未設定時は `http://127.0.0.1:44512` を既定値として使う。
明示的に無効化したい場合は `GNOSIS_EMBED_DAEMON_URL=` を空で設定する。
daemon呼び出しに失敗した場合は既存CLIにfallbackする。

## 優先度

| 優先度 | 用途 | 待ち方 |
| --- | --- | --- |
| high | MCP検索、`search_knowledge`, `agentic_search`, `review_task` のquery embedding | できるだけ待たせない |
| normal | 手動保存、通常のmemory/guidance登録 | 短時間待つ |
| low | `embedding_batch` によるNULL embedding補完 | ゆっくり処理 |

NULL embedding補完は、通常のKnowFlow `topic_tasks` workerではなく `com.gnosis.embedding-batch` が別プロセスで実行する。
このプロセスは `priority=low` でdaemonへ投げるため、MCP由来の `priority=high` query embedding を塞がない。
low priority batchは `GNOSIS_EMBED_BACKGROUND_CHUNK_SIZE` 単位でdaemonへ送る。
これにより、実行中の巨大batchがhigh priority queryを長時間待たせる状態を避ける。
legacy/migration由来の `__system__/embedding_batch` が `topic_tasks` に残る場合だけ、priority 20 として扱う。

## 次の実装候補

1. `doctor --strict` にdaemon healthとモデルロード状態を追加する。
2. daemon latencyを `embeddingLatencyMs` としてMCP/workerログに出す。
3. query hash cacheを追加する。
4. background batch sizeをdaemonの実測に合わせて調整する。

## 受け入れ基準

- LLMが3枠すべて埋まっていても、embeddingは別queueで実行できる。
- daemon起動時、query embeddingはCLI方式より大幅に短く返る。
- `embedding_batch` は低優先度として動き、MCP由来のquery embeddingを長時間塞がない。
- daemonが落ちていても既存CLI fallbackでembedding生成できる。
