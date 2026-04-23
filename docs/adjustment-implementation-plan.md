# Gnosis Hook 実装計画（v1）

最終更新: 2026-04-23  
前提: `MCP前提 / Monitor前提 / KnowFlow前提`

## 1. 目的

`docs/adjustment-usage.md` で定義した運用設計を、実装可能な順序と責務に分解し、Phase 1 で実運用に投入できる形にする。

本計画は次を必達とする。

1. 品質ゲートの自動化（lint / typecheck / test / review）
2. candidate queue（episode/lesson 候補）運用開始
3. Monitor での可視化（trace 追跡）
4. 冪等性、デバウンス、タイムアウト強制の担保

## 2. 設計確定事項（今回固定）

### 2.1 Hook 実行面

- 一次導入先は MCP サーバ内（tool 呼び出し経路の直近）
- background worker は candidate 昇格処理を担当

### 2.2 イベント仕様（v1）

- `task.segment.completed`
- `task.ready_for_review`
- `task.completed`
- `task.failed`
- `file.changed`
- `review.completed`

### 2.3 追跡キー

- `runId` は既存継続
- `traceId` を新規導入
- 全 Hook event / Monitor event / candidate に `traceId` を持たせる

### 2.4 重要レビュー反映（必須）

1. `file.changed` はデバウンス実装を前提にする  
2. 冪等性は DB 永続で担保する  
3. `run_command` は全 action で timeout を強制する  

## 3. 実装スコープ

## 3.1 In Scope（Phase 1）

- Hook core engine（bus / runner / condition / action）
- ルールローダー（YAML）
- 7本の初期ルール実装
- `task_checkpoint` MCP tool 追加
- review 前ゲートと review 完了イベント連携
- candidate queue（episode/lesson）保存
- Monitor timeline 拡張（hook 系イベント）
- `test:related` 新規コマンド追加
- IDE/LLM 向け hooks 設定スクリプト追加（`hooks:setup`）

## 3.2 Out of Scope（Phase 1 では実施しない）

- 多言語別ルール最適化
- adaptive threshold 自動調整
- candidate scoring 高度化（統計学習）

## 4. アーキテクチャ実装方針

## 4.1 Hook Core

新規実装:

- `src/hooks/core/hook-types.ts`
- `src/hooks/core/hook-bus.ts`
- `src/hooks/core/condition-evaluator.ts`
- `src/hooks/core/action-executor.ts`
- `src/hooks/core/hook-runner.ts`

要点:

- event envelope を標準化（`eventId`, `traceId`, `runId`, `taskId`, `payload`, `ts`）
- rule は priority 順に評価
- action ごとの結果を構造化ログ出力
- 失敗戦略（ignore/soft_warn/block_with_guidance/block_progress）を統一適用

## 4.2 ルールローダー

新規実装:

- `src/hooks/rules/**.yaml`
- `src/hooks/core/rule-loader.ts`

方針:

- YAML パーサ依存（`yaml`）を追加
- 起動時ロード + 変更検知リロード（開発時のみ）
- スキーマバリデーションは zod で行う

## 4.3 冪等性（レビュー反映）

新規 DB テーブル:

- `hook_executions`

最低カラム:

- `id` (uuid)
- `event_id`
- `rule_id`
- `trace_id`
- `status` (`started|succeeded|failed|blocked|skipped`)
- `error_message`
- `created_at`
- `updated_at`

制約:

- `UNIQUE(event_id, rule_id)`

実装:

- action 実行前に `started` を登録
- 実行完了後 `status` 更新
- 重複イベント再送は `skipped` で即 return

補助:

- プロセス内 LRU キャッシュ（短期）で DB アクセスを抑制
- 正式な唯一判定は DB 制約で行う

## 4.4 `file.changed` デバウンス（レビュー反映）

新規実装:

- `src/hooks/core/file-change-aggregator.ts`

仕様:

- デフォルト `debounceMs=10000`
- キー: `traceId + normalizedPath`
- 同一キーの連続変更は最後のイベントのみ実行
- flush タイミング:
  - デバウンス満了時
  - `task.segment.completed` 受信時
  - `task.ready_for_review` 受信時

## 4.5 `run_command` タイムアウト強制（レビュー反映）

仕様:

- 全 `run_command` action に timeout 必須
- 未指定時はデフォルト適用（例: 120 秒）
- 上限（例: 900 秒）を超える値は拒否
- timeout 失敗時は error code を `HOOK_ACTION_TIMEOUT` で統一

実装:

- `action-executor.ts` で一元管理
- `AbortController` + 子プロセス kill を必須化

## 4.6 `test:related`（Phase 1）

新規:

- `scripts/test-related.ts`
- `package.json` に `test:related` 追加

仕様:

- `git diff --name-only` から変更ファイル取得
- 対応テスト候補をパスマッピングで抽出
- 抽出不能時: `soft_warn` 可能な結果を返し、全面停止しない
- テスト件数過多時: 上限件数で打ち切り（例: 30 件）
- timeout 超過時: 失敗を返し、Hook戦略に委譲

## 4.7 MCP 連携

変更対象:

- `src/mcp/tools`（新規 `task_checkpoint`）
- `src/mcp/tools/review.ts`
- `src/mcp/server.ts`（Hook dispatcher 注入）

仕様:

- `task_checkpoint` 呼び出しで `task.segment.completed` 発火
- review 実行前に `task.ready_for_review` を発火
- pre-review gate 成功時のみ review enqueue
- review 終了時に `review.completed` 発火

## 4.8 Candidate Queue + KnowFlow Bridge

新規 DB テーブル:

- `hook_candidates`

最低カラム:

- `id` (uuid)
- `kind` (`episode|lesson`)
- `status` (`pending|scored|deduplicated|promoted|rejected`)
- `trace_id`
- `source_event`
- `dedupe_key`
- `severity`
- `payload` (jsonb)
- `score`
- `created_at`
- `updated_at`

フロー:

- Hook action が candidate 作成
- background task（新規 `hook_candidate_promotion`）で昇格処理
- 昇格先は既存 `record_outcome` / `record_experience` / `store_memory` を再利用

## 4.9 Monitor 拡張

変更対象:

- `apps/monitor/src-tauri/src/monitor/collector.rs`
- `apps/monitor/src-tauri/src/monitor/models.rs`
- `apps/monitor/src/lib/monitor/types.ts`
- `apps/monitor/src/routes/+page.svelte`

仕様:

- 監視対象に `hook.*` と `review.completed` を追加
- timeline event に `traceId`, `ruleId`, `gateName`, `riskTags`, `candidateId` を optional 追加
- 既存表示は後方互換を保つ

## 4.10 IDE/LLM Hooks 設定配布

変更対象:

- `scripts/setup-hooks.ts`（新規）
- `package.json`（`hooks:setup`）

目的:

- MCP 設定配布と同じ運用で、hooks も一括セットアップ可能にする

仕様:

- グローバル manual を生成: `~/.gnosis/hooks/manual.md`
- プロジェクト env テンプレートを生成: `.gnosis/hooks/.env.hooks`
- IDE/LLM ごとの snippet を生成:
  - `.gnosis/hooks/snippets/cursor.md`
  - `.gnosis/hooks/snippets/claude.md`
  - `.gnosis/hooks/snippets/codex.md`
  - `.gnosis/hooks/snippets/cline.md`
  - `.gnosis/hooks/snippets/windsurf.md`
  - `.gnosis/hooks/snippets/generic.md`
- `--apply-project-rules` 指定時は以下へ marker block を挿入/更新:
  - `.cursorrules`
  - `.clauderules`
  - `.ai-rules.md`

運用:

- 標準実行: `bun run hooks:setup`
- dry-run: `bun run scripts/setup-hooks.ts --dry-run`
- 対象限定: `bun run scripts/setup-hooks.ts --target cursor --apply-project-rules`

## 5. ルール実装順（WBS）

## 5.1 Step 1: Core + 基盤

1. Hook types / runner / action 実装
2. DB migration（`hook_executions`, `hook_candidates`）
3. YAML loader + zod schema

## 5.2 Step 2: 品質ゲート

1. `segment-lint-typescript`
2. `segment-test-light`
3. `pre-review-quality-gate`

## 5.3 Step 3: リスク guidance

1. `db-change-guidance`
2. `auth-change-guidance`
3. file.changed デバウンス動作

## 5.4 Step 4: 記録起点

1. `review-result-to-lesson`
2. `task-completed-episode-candidate`
3. `task-failed-episode-candidate`

## 5.5 Step 5: MCP/Monitor 接続

1. `task_checkpoint` tool
2. review tool bridge
3. monitor timeline 拡張

## 5.6 Step 6: 配布整備

1. `hooks:setup` で hooks 設定を自動配布
2. onboarding 導線（README or startup docs）に実行手順を追加
3. project rule 更新時の `.bak` 運用を確認

## 6. テスト計画

## 6.1 Unit

- 条件評価
- 失敗戦略分岐
- timeout 強制
- デバウンス集約
- 冪等制御（重複 event）

## 6.2 Integration

- segment -> lint/typecheck/test:related
- ready_for_review -> full gate -> enqueue_review
- file.changed -> risk tag + guidance
- review.completed -> lesson candidate
- task.completed/failed -> episode candidate

## 6.3 E2E（Monitor 含む）

- `task_checkpoint` から Hook event が Monitor に流れる
- 同一 `traceId` で timeline を追跡できる
- candidate 生成から昇格まで追える

## 7. ロールアウト計画

## 7.1 Feature Flag

- `GNOSIS_HOOKS_ENABLED`（default: false で段階導入）
- `GNOSIS_HOOK_FILE_CHANGED_DEBOUNCE_MS`
- `GNOSIS_HOOK_ACTION_TIMEOUT_SEC_DEFAULT`
- `GNOSIS_HOOK_ACTION_TIMEOUT_SEC_MAX`

## 7.2 段階適用

1. Shadow mode（monitor emit のみ、block 無効）
2. soft_warn 有効化
3. block_with_guidance / block_progress 有効化

## 8. 受け入れ基準（Definition of Done）

1. Hook ルール7本が YAML でロードされる
2. `run_command` の timeout 強制が全 action で有効
3. `file.changed` のデバウンスが有効
4. 冪等性が DB 制約で担保される
5. pre-review gate 成功時のみ review が起動する
6. episode/lesson が candidate queue 経由で作成される
7. Monitor で `traceId` 追跡が可能

## 9. 実装リスクと対策

1. Hook の過剰発火  
対策: デバウンス + しきい値条件 + shadow mode

2. テスト実行時間の膨張  
対策: `test:related` 上限、timeout、soft_warn fallback

3. 多重実行による重複副作用  
対策: `hook_executions` の unique 制約

4. Monitor ノイズ増大  
対策: 表示フィルタ（status/rule/event kind）を同時実装

## 10. 実装開始順の提案

最短で価値を出す順序は次。

1. Core + DB 冪等性 + timeout 強制
2. pre-review-quality-gate（review 二重起動排除）
3. file.changed デバウンス + risk guidance
4. candidate queue + monitor 拡張
5. `test:related` 最適化と昇格ロジック改善
