# KnowFlow Guide

KnowFlow は、Gnosis の知識収集・検証タスクを queue 化して実行するローカル-first の仕組みです。MCP primary tool を増やさず、収集結果は既存の knowledge/memory/review 層に統合します。

## 入口

| 目的 | コマンド |
| :--- | :--- |
| dry-run enqueue | `bun src/services/knowflow/cli.ts enqueue --topic "..." --dry-run --json` |
| 1件実行 | `bun run task:knowflow:once` |
| seed phrases | `bun src/services/knowflow/cli.ts seed-phrases --limit 3 --json` |
| mock eval | `bun src/services/knowflow/cli.ts eval-run --suite local --mock --json` |
| smoke | `bun run smoke` |
| snapshot | `bun run monitor:snapshot -- --json` |

## Queue 状態

| status | 意味 | 対応 |
| :--- | :--- | :--- |
| `pending` | 実行待ち | worker 起動を確認 |
| `running` | 実行中 | lock owner と stale lock を確認 |
| `deferred` | 後で再実行 | error reason と retry 条件を確認 |
| `failed` | 失敗終了 | run log と task payload を確認 |

## Smoke Gate

`bun run smoke` は次を確認します。

1. KnowFlow enqueue dry-run
2. knowledge merge dry-run
3. local mock eval

`eval-run` は pass/fail のみを gate とし、旧 `--max-degraded-rate` は使いません。

## Monitor 連携

`bun run monitor:snapshot -- --json` は以下を返します。

- KnowFlow queue counts
- embedding queue counts
- queue interpretation (`runtimeStatus` と `backlogStatus`)
- worker / eval / KnowFlow latest event
- automation gate
- quality gate latest status
- task index

Monitor UI は同じ snapshot を WebSocket で受け取り、queue と gate を表示します。

`knowflow.status` は runtime の状態、`queueInterpretation.backlogStatus` は failed/deferred backlog の状態です。`knowflow.status=healthy` かつ `backlogStatus=needs_attention` は、worker は動いているが失敗済み task の確認が必要な状態として扱います。

## 運用手順

1. 作業前: `bun run doctor`
2. Queue 健全性確認: `bun run monitor:snapshot -- --json`
3. KnowFlow 変更後: `bun run smoke`
4. strict 証跡更新: `GNOSIS_DOCTOR_STRICT=1 bun run doctor`
5. 失敗分類: `bun run monitor:knowflow-failures -- --json`
6. 再試行: `bun run monitor:task-action -- --action retry --task-id <id> --json`
7. 詳細確認: `logs/runs/*.jsonl` の最新 `task.failed` / `background.task.failed` を見る
8. 価値証跡: `bun run status-report --json` の `projectValueEvidence` を見る

## 注意点

- KnowFlow は MCP primary tool ではありません。エージェント向けの通常入口は `agentic_search` です。
- mock eval は外部サービスの成熟度を測るものではなく、queue/eval 配線の回帰検出用です。
- local LLM が未設定でも minimal smoke は通る設計にします。
- `llm_provider_unavailable` は task payload 不正ではなく provider/env/backoff 側の失敗として扱います。
