# Gnosis Hook 運用調整ガイド

最終更新: 2026-04-23  
対象: Gnosis (`MCP前提 / Monitor前提 / KnowFlow前提`)

## 1. 目的

Hook は「LLM の意味理解」を担わず、以下を自動化するための実行レイヤとして扱う。

1. 手順漏れ防止（lint / typecheck / test / review）
2. 品質ゲートの定型化（区切りごとの軽量検証）
3. episode / lesson の候補化
4. Monitor でのトレース可能性（説明責任）

## 2. 非目的

- Hook で知識検索クエリ生成やタスク意味解釈を行わない
- Hook で LLM の最終判断を置き換えない
- Hook で重い推論を常時実行しない

意味理解が必要な処理は、既存の MCP tools / review orchestrator / KnowFlow に委譲する。

## 3. 現行実装との整合ポイント

このガイドは、既存コードに合わせて以下を前提とする。

- 実行コマンド基準: `package.json` の `bun run lint / typecheck / test / verify:*`
- 現行ログ相関キー: `runId`（`logs/runs/*.jsonl`）
- Monitor が現状監視する主要イベント: `task.done`, `task.failed`, `task.deferred`, `llm.task.degraded`
- review 実行系は既存で非同期起動可能（MCP `review` ツール）
- `test:related` は現状未実装（本ガイドで追加対象）

## 4. 設計原則

### 4.1 Hook の責務

Hook は次だけを担う。

- いつ（event）
- 何を（actions）
- どの条件で（conditions）
- 失敗時にどうするか（on_failure）

### 4.2 追跡性

- 既存 `runId` を維持
- 新規 `traceId` を導入し、1タスクの連鎖を一意に追跡

`traceId` は以下で共有する。

- hook 実行ログ
- monitor timeline event
- review request/result
- candidate queue item

## 5. イベントモデル（v1）

Hook が扱う正規イベントを以下に固定する。

1. `task.segment.completed`
2. `task.ready_for_review`
3. `task.completed`
4. `task.failed`
5. `file.changed`
6. `review.completed`

補足:

- 既存 `task.done/failed/deferred`（KnowFlow worker）は維持し、Hook イベントと併存させる
- Hook イベントは `hook.*` namespace の monitor event としても出力する

## 6. ルール定義仕様（YAML）

```yaml
id: segment-lint-typescript
event: task.segment.completed
enabled: true
priority: 100

conditions:
  project_type: typescript
  changed_files_min: 1
  changed_lines_min: 10

actions:
  - type: run_command
    command: bun run lint
    timeout_sec: 120

on_failure:
  strategy: block_with_guidance
  guidance: |
    lint に失敗しました。修正してから続行してください。
```

### 6.1 `conditions`（v1）

- `project_type`
- `changed_files_min`
- `changed_lines_min`
- `path_matches`
- `risk_tags_contains`
- `branch_pattern`
- `task_mode`
- `review_requested`
- `last_hook_result`

### 6.2 `actions`（v1）

- `run_command`
- `emit_monitor_event`
- `add_guidance`
- `tag_risk`
- `enqueue_review`
- `create_episode_candidate`
- `create_lesson_candidate`
- `block_progress`
- `soft_warn`

### 6.3 `on_failure.strategy`

- `ignore`
- `soft_warn`
- `block_with_guidance`
- `block_progress`

## 7. 初期ルールセット（Phase 1: 全量導入）

## 7.1 segment lint/typecheck

- event: `task.segment.completed`
- command:
  - `bun run lint`
  - `bun run typecheck`
- failure: `block_with_guidance`

## 7.2 segment 軽量 test

- event: `task.segment.completed`
- command: `bun run test:related`（新規）
- failure: `soft_warn`
- 備考: `test:related` が対象抽出不可の場合は `soft_warn + fallback note` を返す

## 7.3 review 前品質ゲート（review enqueue 一体化）

- event: `task.ready_for_review`
- command:
  - `bun run lint`
  - `bun run typecheck`
  - `bun run test`
- 後続 action: `enqueue_review`（成功時のみ）
- failure: `block_progress`

重要:

- review 起動はこのルールに集約する
- `task.ready_for_review` で review を二重 enqueue しない

## 7.4 高リスク変更 guidance

### DB 変更

- event: `file.changed`
- path:
  - `src/db/**`
  - `drizzle/**`
  - `migrations/**`
- action:
  - `tag_risk: db-change`
  - `add_guidance`（破壊的変更、後方互換、データ影響、rollback）

### Auth 変更

- event: `file.changed`
- path:
  - `src/auth/**`
  - `src/middleware/**`
  - `src/security/**`
- action:
  - `tag_risk: auth-change`
  - `add_guidance`（認可漏れ、権限昇格、default allow、token整合）

## 7.5 review 結果 → lesson 候補

- event: `review.completed`
- action:
  - `create_lesson_candidate`（`min_severity >= medium`）
  - `emit_monitor_event`

## 7.6 task 完了/失敗 → episode 候補

### success

- event: `task.completed`
- action: `create_episode_candidate(episode_kind=success)`

### failure

- event: `task.failed`
- action:
  - `create_episode_candidate(episode_kind=failure)`
  - `create_lesson_candidate(source=failure_episode)`

## 8. Monitor 連携要件

Monitor は「ログ表示」ではなく、Hook の説明責任レイヤとして扱う。

### 8.1 Timeline 表示項目

- event kind
- success/failure/blocked
- duration
- runId
- traceId
- taskId（存在時）

### 8.2 Quality Gate 面

- lint / typecheck / test の最新結果
- 最終成功時刻
- 連続失敗回数

### 8.3 Risk Tags

- `db-change`
- `auth-change`
- `api-change`
- `infra-change`

### 8.4 Candidate 可視化

- episode candidate: status / summary / source
- lesson candidate: status / severity / source

## 9. Candidate Queue 設計

即保存はせず候補として積む。KnowFlow で昇格判定する。

### 9.1 status

- `pending`
- `scored`
- `deduplicated`
- `promoted`
- `rejected`

### 9.2 item 最低フィールド

- `id`
- `kind` (`episode` | `lesson`)
- `traceId`
- `sourceEvent`
- `dedupeKey`
- `score`（任意）
- `status`
- `payload`
- `createdAt`

### 9.3 昇格先

- success episode → procedure/knowledge 種
- failure episode → experience/lesson 種
- review finding lesson → guidance/lesson 種

## 10. MCP 連携（LLM が自然に使えるための補助）

LLM に自然な運用をさせるため、以下を追加する。

- 新規 tool: `task_checkpoint`
  - 目的: 「一区切り」を明示し `task.segment.completed` を発火
- review tool 連携:
  - review 要求時に内部で `task.ready_for_review` を発火
  - ゲート失敗時は `block_progress` を返却

この形により、会話の曖昧解釈ではなく明示イベントで Hook を駆動できる。

## 11. 実装構成（推奨）

```text
src/
  hooks/
    core/
      hook-bus.ts
      hook-runner.ts
      hook-types.ts
      condition-evaluator.ts
      action-executor.ts
    rules/
      typescript/
        segment-lint.yaml
        segment-test-light.yaml
        pre-review-quality-gate.yaml
      risk/
        db-change-guidance.yaml
        auth-change-guidance.yaml
      review/
        review-result-to-lesson.yaml
      episodes/
        task-completed-episode-candidate.yaml
        task-failed-episode-candidate.yaml
    integrations/
      monitor-hook-reporter.ts
      review-hook-bridge.ts
      candidate-hook-bridge.ts
```

## 12. フェーズ導入

## Phase 1（今回）

- 7章のルールを全量導入
- Monitor timeline に hook event と traceId を追加
- candidate queue の最小実装
- `task_checkpoint` を追加

## Phase 2

- `test:related` 精度改善
- candidate scoring / dedupe 強化
- review profile の最適化（fast/standard/strict）

## Phase 3

- 言語別ルール分岐（TS 以外）
- provider 差分吸収
- adaptive threshold（変更量や失敗率に応じ動的調整）

## 13. 受け入れ基準

以下を満たしたら v1 導入完了とする。

1. `task.segment.completed` で lint/typecheck が確実に実行される
2. `task.ready_for_review` で品質ゲート成功時のみ review が起動する
3. `file.changed` で DB/Auth の risk tag + guidance が付与される
4. `task.completed/task.failed/review.completed` で candidate が作成される
5. Monitor で同一 `traceId` のイベント連鎖を追える
6. 同一 event の再送で Hook action が重複実行されない（冪等）

## 14. 注意点（実装時）

- `run_command` 出力は monitor 送信時に必要なマスク処理を入れる
- block 系戦略は「なぜ止めたか」を必ず guidance として返す
- Hook ルールは fail-open / fail-closed をイベントごとに明示し、暗黙にしない
- review enqueue は単一ルールに集約し、重複起動を禁止する

