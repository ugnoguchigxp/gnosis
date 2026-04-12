# Gnosis Monitoring App (Tauri) 実装計画（粗案）

## 1. 前提と目的

- 前提:
  - 本プロジェクトはローカル専用運用（クラウド配備なし）
  - 監視UIは「ブラウザ常時起動」ではなくデスクトップアプリとして提供
- 目的:
  - リアルタイムに近い監視体験
  - メモリ消費を抑えた常用可能な運用UI
  - 既存の Bun/TypeScript 資産（CLI/DB/ログ）を最大限再利用

## 2. 技術方針（結論）

- UI: Tauri + Web frontend（React/Vite か SvelteKit）
- データ更新: Push型（イベント配信）を主、ポーリングは最小限フォールバック
- データ源:
  - `logs/runs/*.jsonl`
  - PostgreSQL（`topic_tasks`, `knowledge_*`, `experience_logs`, `vibe_memories`）
- メモリ抑制:
  - アプリ内はリングバッファ保持（例: 各ストリーム最大 500 件）
  - 古いイベントは要約値のみ残す

## 3. 全体アーキテクチャ

1. **Collector 層（ローカル集約）**
   - DB問い合わせ + JSONL tail を集約
   - 正規化イベントを生成（`task.updated`, `llm.degraded`, `queue.depth` など）
2. **Bridge 層（Tauri連携）**
   - Tauri command で snapshot を返す
   - Tauri event で incremental update を push
3. **UI 層**
   - Dashboard（現在状態）
   - Timeline（イベント時系列）
   - Drilldown（task/run/topic別の詳細）

## 4. 最小機能セット（MVP）

- Dashboard:
  - Queue: pending/running/deferred/failed 数
  - Worker: 直近成功/失敗、連続失敗数
  - Eval: degradedRate / pass/fail
- Timeline:
  - `task.done`, `task.failed`, `task.deferred`, `llm.task.degraded`
- Detail:
  - taskId で run log / resultSummary / errorReason を表示
- Controls:
  - 自動更新 ON/OFF
  - 更新レート（例: 250ms / 1s / 3s）
  - ログ保持件数上限

## 5. リアルタイム更新戦略

- 第一選択: イベント push
  - Collector が差分検知したときだけ UI にイベント送信
- フォールバック:
  - 低頻度ポーリング（例: 3秒）で整合性チェック
- 負荷制御:
  - burst 時は 200ms 窓でバッチ化してまとめて通知

## 6. 低メモリ運用の設計ルール

- 生イベント保持件数を固定（リングバッファ）
- 巨大 payload は UI に持ち込まず、必要時オンデマンド取得
- ログ文字列は全文常駐させず、概要 + 詳細取得 API を分離
- チャート計算は都度集計ではなくインクリメンタル更新

## 7. 実装フェーズ

### Phase 0: 土台（1-2日）
- Tauri プロジェクト作成
- 画面スケルトンとレイアウト確定
- 監視イベント型（TypeScript）定義

### Phase 1: Snapshot 監視（2-3日）
- DB由来メトリクスの snapshot 取得
- `logs/runs` の最新 run 一覧取得
- Dashboard 初版表示

### Phase 2: Push 更新（2-3日）
- Collector の差分検知
- Tauri event 配信 + UI反映
- リングバッファ導入

### Phase 3: 詳細分析（2-4日）
- task/run 詳細ビュー
- エラー分類（budget超過、timeout、parser失敗等）
- フィルタ（source/topic/status/level）

### Phase 4: 運用品質（1-2日）
- 起動時自己診断（DB接続、ログディレクトリ存在）
- 設定画面（更新間隔、保持件数、DB接続先）
- 障害時の復旧導線（再接続、リトライ）

## 8. データモデル草案

- `MonitoringSnapshot`
  - `queue`: `{ pending, running, deferred, failed }`
  - `worker`: `{ lastSuccessAt, lastFailureAt, consecutiveErrors }`
  - `eval`: `{ degradedRate, passed, failed }`
- `MonitoringEvent`
  - `id`, `ts`, `type`, `level`, `taskId?`, `runId?`, `summary`, `payload?`

## 9. 受け入れ基準（MVP）

- アプリ起動後 2 秒以内に初期 snapshot 表示
- 更新遅延（イベント発生からUI反映）1 秒以内
- 1時間連続稼働でメモリ増加が上限内（例: +150MB以内）
- Worker が高頻度ログを出しても UI 操作が固まらない

## 10. 既知リスクと回避策

- リスク: ログ量過多で描画詰まり
  - 対策: 仮想リスト + バッチ反映 + 保持上限
- リスク: DB遅延で snapshot 取得が詰まる
  - 対策: タイムアウト + 部分表示 + 再試行
- リスク: スキーマ変更で UI が壊れる
  - 対策: イベント型のバージョン付与

## 11. 直近アクション

1. Tauri 雛形作成（最小画面 + snapshot command）
2. Collector の最小実装（queue + recent runs）
3. Push 更新（task.done / task.failed のみ）を先に開通
