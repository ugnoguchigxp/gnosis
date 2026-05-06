# Data Layers

Gnosis の永続化層は PostgreSQL を中心に、MCP の一次導線、KnowFlow、Review、Monitor が同じローカル DB と run log を共有します。

## 主要ストア

| 層 | 主な用途 | 代表データ |
| :--- | :--- | :--- |
| `entities` / relations | 再利用可能な知識単位と関係 | rule, lesson, procedure, skill, decision, risk |
| `vibe_memories` | 会話・作業文脈の長期記憶 | session memory, seed marker |
| `experience_logs` | 成功/失敗体験 | failure pattern, solution, scenario |
| `review_cases` / `review_outcomes` | review 実行と結果 | findings, knowledge refs, reviewer metadata |
| `topic_tasks` | KnowFlow / background queue | pending, running, deferred, failed |
| `logs/runs/*.jsonl` | 実行イベント | task.done, task.failed, cli.result |
| `logs/quality-gates.json` | 品質 gate の最終結果 | doctor, smoke, verify, MCP contract |

## 検索導線

- `agentic_search` は `knowledge_search` を通じて `entities` の候補を取得し、必要に応じて web/fetch を併用します。
- `search_knowledge` は raw 候補確認用です。通常の作業では `agentic_search` を優先します。
- `review_task` は code diff では review orchestrator、document/spec/plan では document reviewer を使い、採用済み context を `knowledgeUsed` に載せます。

## 運用ルール

1. migration は `bun run db:migrate` を使い、schema drift が疑われる場合は `bun run db:meta-check` と `bun run db:reconcile` を先に確認します。
2. queue 状態は `bun run monitor:snapshot -- --json` または Monitor UI で確認します。
3. quality gate の最新結果は各 gate 実行時に `logs/quality-gates.json` に保存され、Monitor UI の `Quality Gates` に表示されます。
4. local LLM は optional です。minimal では DB、embedding、MCP primary tools、cloud-review または degraded JSON を価値導線として扱います。

## 障害時の切り分け

| 症状 | 最初に見るもの | 次の操作 |
| :--- | :--- | :--- |
| DB 接続不可 | `bun run doctor` | `docker compose up -d gnosis` / `bun run db:init` |
| 検索候補が空 | `search_knowledge` raw 候補 | seed/import 状態と embedding daemon を確認 |
| review が返らない | `review_task` diagnostics | provider env と `GNOSIS_MCP_REVIEW_LLM_TIMEOUT_MS` を確認 |
| queue が進まない | Monitor UI / `topic_tasks` | `bun run process:diagnose` と worker LaunchAgent を確認 |
| gate 状態が古い | `logs/quality-gates.json` | 対象 gate を再実行 |
