# Batch Process Review / Refactoring Plan

## 実施状況（2026-04-20）
- Phase 1: 実装済み
- Phase 2: 実装済み
- Phase 3: 実装済み（`test/scripts/batch-process.phase3.integration.test.ts`）
- Phase 4: 実装済み（`src/scripts/worker.ts`, `src/services/knowflow/ops/runtimeMonitor.ts`, `src/services/knowflow/scheduler/policy.ts`）
- 通しテスト: 実行済み（`RUN_BATCH_PROCESS_INTEGRATION=1 bun test`）
  - 結果: `447 pass / 25 skip / 0 fail`

## 目的
- knowflow と episode 作成の cron 系バッチについて、CLI から「完了できたか」を厳密判定できる入口を用意する。
- 現行実装の失敗要因をコードレビューし、段階的なリファクタリング計画を定義する。

## 今回追加した厳密判定オプション

### 1) knowflow worker の厳密完了判定
- 追加先: `src/services/knowflow/cli.ts`
- オプション: `--strict-complete`（`run-once` 専用）
- 動作:
  - キューが空 (`processed=false`) の場合はエラー終了
  - `status !== done`（`deferred` / `failed`）の場合はエラー終了
- 適用範囲:
  - 手動/外部 cron から `src/services/knowflow/cli.ts` を直接呼ぶ経路
  - `BackgroundManager` の内部定期実行経路（`startBackgroundWorkers -> processQueue`）には未接続
- 対象実装: `src/services/knowflow/cli.ts:28`, `src/services/knowflow/cli.ts:120`, `src/services/knowflow/cli.ts:166`, `src/services/knowflow/cli.ts:242`

実行例:
```bash
bun run src/services/knowflow/cli.ts enqueue --topic "strict-probe-$(date +%s)" --mode directed --source cron --priority 99 --json
bun run src/services/knowflow/cli.ts run-once --strict-complete --max-attempts 1 --json
```

### 2) episode 統合の厳密判定
- 追加先: `src/scripts/monitor-episodes.ts`
- オプション: `--strict`（`consolidate` 専用）
- 動作:
  - `consolidate` の結果が `null`（統合スキップ）なら終了コード `1`
  - 生成成功時のみ終了コード `0`
- 対象実装: `src/scripts/monitor-episodes.ts:9`, `src/scripts/monitor-episodes.ts:13`, `src/scripts/monitor-episodes.ts:121`, `src/scripts/monitor-episodes.ts:124`

実行例:
```bash
bun run src/scripts/monitor-episodes.ts register "batch strict test memo"
# 上の JSON 出力に含まれる sessionId を控える
bun run src/scripts/monitor-episodes.ts consolidate <registerで得たsessionId> --strict
```

## コードレビュー結果（優先度順）

### [P0] 定期タスク再登録が実行中/失敗状態を破壊する
- `src/services/background/manager.ts:38-50` で固定 ID の periodic タスクを毎 tick で enqueue。
- `src/services/background/scheduler.ts:78-82` が `INSERT OR REPLACE` のため、既存行の状態（`running` / `failed` / `error_message` / `next_run_at`）を強制的に潰す。
- 影響:
  - 長時間タスクの進捗がリセットされる
  - 失敗分析に必要なエラーメッセージが失われる
  - 「成功しない/状態が安定しない」症状を誘発

### [P1] タスク関数内で例外を握りつぶし、スケジューラー側で成功扱いになる
- `src/services/background/tasks/synthesisTask.ts:8-18` は例外を catch して再 throw しない。
- `src/services/background/tasks/consolidationTask.ts:36-58` もグループ単位で失敗を握りつぶす。
- `src/services/background/runner.ts:149-150` は `runTask` が throw しない限り `completed` にするため、部分失敗/全失敗が可視化されにくい。

### [P1] cron で「未実行・スキップ」を成功扱いしやすいインターフェース
- 変更前の `monitor-episodes consolidate` は `result === null` でも終了コード 0。
- 運用側で「実際には episode が作られていないのに成功通知」となる。
- 今回 `--strict` で回避可能にしたが、デフォルト挙動の整理は継続課題。

### [P2] `processQueue` のタイムアウト実装が cancel 不可
- `src/services/background/runner.ts:137-141` の `setTimeout` を clear しておらず、遅延 reject が残る構造。
- 直ちに機能停止はしないが、長時間運用で不要なタイマー/ログノイズ要因になる。

## 観測ログからの補足（運用要因）
- `logs/worker.log` で以下が継続発生:
  - local LLM CLI パス不整合（`services/local-llm/scripts/gemma4: No such file or directory`）
  - `Global lock timeout: local-llm`
  - `Task execution timed out after 600000ms`
- これはコード修正だけでなく、環境設定（`LOCAL_LLM_CLI_COMMAND`, `GNOSIS_LLM_SCRIPT`）の検証導線が必要。

## リファクタリング計画

### Phase 0: 失敗検知を先に強化（即日）
1. 手動/外部 cron から叩く CLI 実行コマンドを `--strict-complete` / `--strict` 付きに切替（`BackgroundManager` 内部経路は別途対応）。
2. 失敗時は必ず非 0 終了で通知（監視・再試行が効く状態）に統一。
3. 監視に「処理件数 0 を失敗にする」判定を追加（noop 成功の抑止）。

### Phase 1: スケジューラー整合性修正（最優先）
1. `enqueue` を `INSERT OR REPLACE` から「状態を保護する upsert」に変更。
2. periodic 登録は `running` を上書きしない条件更新にする。
3. `failed` の `error_message` / `next_run_at` を保持する。
4. 固定 ID periodic タスクの `failed` 再投入ポリシーを明文化する（例: `next_run_at` 経過時に `pending` へ戻す、直近エラーを別カラム/ログへ退避して可観測性を維持）。

### Phase 2: タスク結果契約の明確化
1. `runTask` / 各 task を `TaskOutcome`（`ok`, `processed`, `partialFailures`）で返す。
2. `consolidationTask` / `synthesisTask` は失敗件数を返し、閾値超過時は throw。
3. `processQueue` は outcome に応じて `completed` / `failed` を厳密更新。

### Phase 3: E2E テスト整備（CLI 起点）
1. `strict` 付き CLI の統合テストを追加（成功ケース/失敗ケース）。
2. ケース:
   - queue empty（strict で fail）
   - deferred/failed（strict で fail）
   - episode skipped（strict で fail）
   - 実生成成功（strict で pass）
3. cron 相当のコマンド列を CI で再現（最小データセット）。

### Phase 4: 運用安定化
1. LLM ヘルスチェック結果を起動時だけでなく定期レポート化。
2. タイムアウト・ロック待ちの計測をメトリクス化し、閾値超過でアラート。
3. retry/backoff に jitter を導入し、同時再試行を緩和。

実装内容:
- `src/scripts/worker.ts`
  - `checkLlmHealth` を起動時 + 定期実行（`worker.health_check.report`）
  - `WorkerRuntimeMonitor` を組み込み、`worker.runtime.metrics` を定期出力
  - `task timeout` / `lock timeout` の閾値超過時に `worker.runtime.alert` を出力
- `src/services/knowflow/ops/runtimeMonitor.ts`
  - ランタイムウィンドウ集計（処理数、idle、task timeout、lock timeout、lock wait統計）
  - レポート出力間隔とアラートクールダウン管理
- `src/services/knowflow/scheduler/policy.ts`
  - `computeBackoffWithJitterMs` を追加し、`decideFailureAction` の defer に jitter を適用

Phase4 追加ENV（任意）:
- `KNOWFLOW_HEALTH_CHECK_REPORT_INTERVAL_MS`（default: `300000`）
- `KNOWFLOW_RUNTIME_METRICS_WINDOW_MS`（default: `900000`）
- `KNOWFLOW_RUNTIME_METRICS_REPORT_INTERVAL_MS`（default: `60000`）
- `KNOWFLOW_RUNTIME_TASK_TIMEOUT_ALERT_THRESHOLD`（default: `3`）
- `KNOWFLOW_RUNTIME_LOCK_TIMEOUT_ALERT_THRESHOLD`（default: `3`）

## 完了条件（Definition of Done）
- strict モードの CLI を cron で利用し、未処理/失敗が必ず非 0 終了になる。
- periodic enqueue が `running`/`failed` 状態を破壊しない。
- バッチ失敗が scheduler とログの双方で同じ意味で観測できる。
- E2E テストで strict 成功/失敗パターンが再現可能。
