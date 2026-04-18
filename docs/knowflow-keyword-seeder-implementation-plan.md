# KnowFlow Keyword Seeder 実装計画

作成日: 2026-04-18

## 1. 目的

既存の5分バッチチェックに相乗りして、以下を自動実行する。

- 入力源: `experience_logs` と `vibe_memories(memory_type='episode')`
- LLM評価: `search_score` / `term_difficulty_score` / `uncertainty_score` + `category` + `why_research`
- 判定: `search_score > 6.5` のみ `topic_tasks` へ投入（`source='cron'`, `priority=1`）
- 保存: 投入/非投入を `knowflow_keyword_evaluations` に永続化

## 2. 実装方針

- 既存アーキテクチャ（background scheduler + knowflow queue/worker）を維持
- モデルは alias 切替式（`bonsai|gemma4|bedrock|openai`）
- 既定モデルは `gemma4`
- フォールバックは設定で任意（例: `openai`）
- 判定根拠は必ず保存（監査可能にする）

## 3. 現在の状態（開始時点）

完了済み:
- `knowflow_keyword_evaluations` テーブル追加
- Drizzle migration `0014_lethal_kid_colt.sql` 生成
- schema/typecheck/meta-check 通過

未実装:
- 評価ロジック本体
- キュー投入ロジック本体
- 5分チェックループへの組み込み
- `gemma4/openai` 検証テスト

## 4. フェーズ別タスク

## Phase A: 設定と型の追加

目的:
- alias切替・閾値・件数上限を設定可能にする

変更対象:
- `src/config.ts`

実装:
- 追加設定
  - `knowflow.keywordCron.enabled`
  - `knowflow.keywordCron.maxTopics`
  - `knowflow.keywordCron.minResearchScore`
  - `knowflow.keywordCron.lookbackHours`
  - `knowflow.keywordCron.evalModelAlias`
  - `knowflow.keywordCron.evalFallbackAlias` (optional)
- alias の型を `bonsai|gemma4|bedrock|openai` に固定
- デフォルトは `gemma4`

完了条件:
- 設定未指定でも起動可能
- alias 不正値は起動時に明示エラー

## Phase B: Keyword Seeder ドメイン実装

目的:
- 候補抽出 → 評価 → 永続化 → 条件投入を1ユースケースにまとめる

新規ファイル:
- `src/services/knowflow/cron/keywordSeeder.ts`
- `src/services/knowflow/cron/types.ts`
- `src/services/knowflow/prompts/keyword_seed_evaluation.md`

主な型:
- `KeywordCandidate`
- `KeywordEvaluation`
- `KeywordSeederRunResult`

処理:
1. lookback対象の入力データ取得
2. LLMで候補評価を生成
3. `knowflow_keyword_evaluations` に全件保存（enqueued/skipped）
4. `search_score > minResearchScore` のみ enqueue
5. enqueue成功時 `enqueued_task_id` を評価レコードに反映

完了条件:
- 1回実行で評価保存と投入が動く
- 入力0件時に安全終了

## Phase C: 永続化レイヤー

目的:
- `knowflow_keyword_evaluations` の保存/更新を分離

新規ファイル:
- `src/services/knowflow/cron/evaluationRepository.ts`

実装メソッド:
- `saveEvaluations(runId, rows)`
- `attachEnqueuedTaskId(evaluationId, taskId)`
- `listRecentEvaluations(limit)` (運用確認用)

完了条件:
- DB書き込みがトランザクションで一貫
- エラー時ロールバック

## Phase D: 5分チェックループ統合

目的:
- 既存の background ループ内で出番時に seeder を実行

変更対象:
- `src/services/background/manager.ts`
- `src/services/background/runner.ts`

実装方針:
- 新しい background task type: `knowflow_keyword_seed` を追加
- `manager.ts` の tick で定期 enqueue（固定ID、priority は `knowflow` より低く設定）
- `runner.ts` の `runTask` に `knowflow_keyword_seed` 分岐を追加
- 優先順実行は既存 scheduler の `priority DESC` に委譲

推奨優先度:
- `knowflow` が 5 のため、`knowflow_keyword_seed` は 1

完了条件:
- 5分ごとの処理タイミングで、上位タスクが空いたときに seeder が実行される

## Phase E: LLM alias ルータ

目的:
- `gemma4/openai` などを同一I/Fで切替

変更/新規対象:
- `src/services/knowflow/cron/keywordSeeder.ts` 内部に実装
  または
- `src/services/knowflow/cron/llmRouter.ts` を新設

要件:
- 入力: alias, prompt
- 出力: JSON評価結果
- フォールバック: `evalFallbackAlias` がある場合のみ実施
- `model_alias` を評価レコードに保存

完了条件:
- `gemma4` 既定で動作
- `openai` へ設定切替で動作

## 5. テスト計画

## 5.1 単体テスト

新規:
- `test/knowflow/keywordSeeder.test.ts`
  - 空入力
  - `search_score` 閾値判定
  - enqueue 成否
  - evaluation 保存

- `test/knowflow/evaluationRepository.test.ts`
  - insert/update/list

追加:
- `test/runner.test.ts`
  - `knowflow_keyword_seed` task 分岐

## 5.2 モデル検証テスト（必須）

新規:
- `test/knowflow/keywordSeeder.model.test.ts`

必須ケース:
- `gemma4` で評価結果を返せる
- `openai` で評価結果を返せる
- 両者で最低限のスキーマ整合（必須キー存在）

注記:
- CIはモック中心
- 実接続検証は環境変数で opt-in（例: `KNOWFLOW_RUN_LIVE_LLM=1`）

## 5.3 境界値テスト

- `search_score = 6.5` は投入しない
- `search_score = 6.5001` は投入する

## 6. ロールアウト手順

1. `KNOWFLOW_KEYWORD_CRON_ENABLED=false` でデプロイ
2. マイグレーション適用
3. dry-run 相当（評価保存のみ、enqueue無効）で観測
4. enqueue有効化
5. `maxTopics` を低め（例: 3）で開始
6. 問題なければ `maxTopics=10` へ拡張

## 7. 運用監視

監視対象:
- 5分ごとの実行回数
- `enqueued/skipped` 比率
- `search_score` 分布
- alias別の失敗率（`gemma4`, `openai`）

最低限の確認SQL例:
- 直近24h の件数
- `decision='enqueued'` 比率
- `model_alias` 別エラー率

## 8. 受け入れ完了条件

- keyword seeder が5分チェック内で実行される
- 評価結果が `knowflow_keyword_evaluations` に保存される
- `search_score > 6.5` のみ `topic_tasks` に投入される
- `priority=1` で投入される
- `gemma4` と `openai` の検証テストが通る
- `bun run typecheck` と対象テストが通る

## 9. 実行コマンド（実装後の確認）

- `bun run typecheck`
- `bun test test/knowflow/keywordSeeder.test.ts`
- `bun test test/knowflow/keywordSeeder.model.test.ts`
- `bun test test/runner.test.ts`
- `bun run db:meta-check`
