# Gnosis Monitoring App (Tauri + Svelte) 実装計画（刷新）

## 1. 目的と方針

- ローカル専用運用を前提に、監視UIをTauriデスクトップアプリとして提供する。
- リアルタイム性は **WebSocket** を主経路にする。
- GUIの豪華さより「確かに見えること」を優先する（数値・状態・履歴を明快に表示）。
- 軽量性最優先で **SvelteKit** を採用する。
- 外部バックエンド（常駐Web API）は作らず、**Rust（Tauri本体）内で収集・配信を完結**させる。
- DB参照は当面 **CLI経由** とし、クエリは「変化検知時のみ」を原則にする。

## 2. 採用技術（軽量構成）

- Desktop Shell: `Tauri v2`
- Frontend: `SvelteKit + TypeScript`
- UI: `shadcn/ui (Svelte版 / shadcn-svelte)`
- State: `Svelte stores`（最小構成）
- Icon: `lucide-svelte`
- WS Server (Rust): `axum` + `tokio-tungstenite`（axum ws feature）
- UI部品: shadcn/ui を必要最小限のみ導入して構築。

非採用（初期）:
- 大規模コンポーネントライブラリ（MUI/Antd等）
- 重いチャートライブラリ（まずはテーブルと軽量インジケータ中心）

## 3. 表示対象（MVP）

既存要件に合わせ、表示対象は以下で固定する。

- Dashboard
  - Queue: `pending / running / deferred / failed` 件数
  - Worker: 直近成功時刻、直近失敗時刻、連続失敗数
  - Eval: `degradedRate`, `passed`, `failed`
- Timeline
  - `task.done`, `task.failed`, `task.deferred`, `llm.task.degraded`
- Detail
  - `taskId` 起点で `runId`, `resultSummary`, `errorReason`, 関連ログ断片
- Controls
  - 自動更新 ON/OFF
  - 表示件数上限
  - 接続状態（WS connected / reconnecting / offline）

## 4. リアルタイム配信仕様（WebSocket）

### 4.1 接続

- URL: `ws://127.0.0.1:<port>/monitor`
- 通信: JSON line / JSON frame
- 初回接続時:
  1. Client -> Server: `hello`
  2. Server -> Client: `hello_ack`
  3. Server -> Client: `snapshot`（全体状態）
  4. 以降 `event` をpush

### 4.2 メッセージ型

- `hello`
  - `{ "type": "hello", "clientVersion": "x.y.z" }`
- `hello_ack`
  - `{ "type": "hello_ack", "serverVersion": "x.y.z", "protocolVersion": 1 }`
- `snapshot`
  - `{ "type": "snapshot", "ts": 1770000000000, "data": { ... } }`
- `event`
  - `{ "type": "event", "ts": 1770000000100, "event": { "id": "...", "kind": "task.done", ... } }`
- `heartbeat`
  - `{ "type": "heartbeat", "ts": ... }`

### 4.3 再接続

- 指数バックオフ（500ms -> 1s -> 2s -> 4s、上限10s）
- 再接続成功時は `snapshot` を再取得して整合性を回復

### 4.4 WS実装クレート方針

- 採用: `axum`（`ws` feature） + `tokio-tungstenite`
- 理由:
  - Tauri v2 / tokio ランタイムと統合しやすい
  - 将来、ヘルスチェックや設定取得などHTTPエンドポイントを同一プロセスに追加しやすい
  - 単体テストを `axum` のルータ単位で実施しやすい

## 5. アーキテクチャ

1. Collector（ローカル集約）
   - CLI実行結果（snapshot）と `logs/runs/*.jsonl` を監視
   - 正規化イベントを生成
2. WS Gateway
   - Collectorの更新をクライアントにpush
   - 新規接続時に最新snapshotを送信
3. Svelte UI
   - snapshot適用 + event差分適用
   - 表示件数上限でメモリを固定

### 5.1 実行トポロジ（単一アプリ）

- `Tauri app process`（唯一の常駐プロセス）
  - Rust内 Collector タスク
  - Rust内 WebSocket サーバー（localhostバインド）
  - WebView（Svelte UI）
- `gnosis` / `localLlm` は既存CLIを必要時に subprocess 実行
- 別途「バックエンドサーバープロセス」は起動しない

### 5.2 データ取得方式（CLI先行）

- Rust Collector は必要時のみ CLI を呼び出して snapshot を取得する。
- 取得対象はドメイン分割する（`queue`, `worker`, `eval`, `detail`）。
- 各ドメインごとにキャッシュと最終更新時刻を保持する。
- 取得コマンドは将来的に `monitor-snapshot` 系を追加し、1コマンド1責務に分割する。

### 5.3 クエリ抑制ポリシー（重要）

- 原則: **変化がなければCLIを呼ばない**。
- 変化トリガー:
  - `logs/runs/*.jsonl` の更新検知（notify-rs）
  - UIで詳細パネルを開いた時（オンデマンド）
  - 低頻度の整合チェックタイマー（例: 30秒〜60秒）
- 抑制制御:
  - Dirty flag（`queueDirty`, `evalDirty` など）
  - Debounce（200ms〜500ms）で複数イベントを1回に集約
  - ドメイン別最小実行間隔（例: queue 2秒 / eval 15秒）
  - In-flight lock（同一ドメインの同時CLI起動禁止）
- push条件:
  - 新snapshotのハッシュが前回と異なる場合のみ `event/snapshot` を配信

### 5.4 Rust 内モジュール案

- `src-tauri/src/monitor/collector.rs`
  - 変化検知、CLI実行制御、イベント正規化
- `src-tauri/src/monitor/ws.rs`
  - `hello/snapshot/event/heartbeat` プロトコル実装
- `src-tauri/src/monitor/state.rs`
  - リングバッファ、最新snapshot、購読者管理
- `src-tauri/src/monitor/commands.rs`
  - フロントへWS接続先・初期設定を返す Tauri command

## 6. 軽量コンポーネントセット（shadcn/ui Svelte）

- `Card`（統計カード）
- `Badge`（状態表示）
- `Table`（一覧）
- `Sheet`（詳細パネル）
- `ScrollArea`（イベント履歴）
- `Separator`（区切り）
- `Button` / `Select`（最小操作）

補助:
- アイコンは `lucide-svelte` のみ使用
- スタイルは素のCSS + CSS variables（最小）
- 追加コンポーネントは「監視精度向上に必要なものだけ」を採用する

## 7. メモリ抑制ルール

- イベント保持はリングバッファ
  - Timeline: 最大 500 件（設定可能）
  - Detail cache: 最大 50 task
- 文字列payloadはトリムして保持（長文はオンデマンド再取得）
- 再計算を避けるため、store更新は差分適用のみ行う

## 8. 実装フェーズ

### Phase 0: 雛形（1日）
- Tauri + SvelteKit プロジェクト生成
- 最小画面（接続状態のみ）
- WS クライアント接続確認

### Phase 1: Snapshot表示（1-2日）
- Collectorからsnapshot取得
- Dashboard（Queue/Worker/Eval）表示

### Phase 2: Event配信（2日）
- `event` push実装
- Timeline更新
- 再接続・heartbeat対応

### Phase 3: Detailと運用導線（1-2日）
- task詳細パネル
- フィルタ（status/source/topic）
- 保持件数設定

## 9. 受け入れ基準（MVP）

- アプリ起動後 2 秒以内に snapshot 表示
- `task.done` など主要イベントが 1 秒以内に反映
- 1時間連続稼働でメモリ増加が抑制される（目安: +100MB以内）
- WS切断後に自動復旧し、snapshot再取得で表示整合が戻る
- 高イベント時でも CLI 呼び出し回数が抑制される（例: 1分あたり上限を設定）

## 10. 実装時の注意

- UIを先に作り込まない。まず「データが正しく見える」ことを優先。
- 可視化は表形式中心。初期段階で複雑グラフは入れない。
- プロトコル変更時は `protocolVersion` を上げ、後方互換を管理する。
- WSは `127.0.0.1` のみに bind し、起動時にランダムトークンを発行して接続時検証する。
- notify-rs を使ったログ更新検知では、ローテーション・rename をエッジケースとして扱う。
- 可観測性として「CLI呼び出し回数」「抑制ヒット率」を内部メトリクスで記録する。

## 11. 直近アクション

1. Tauri + SvelteKit 雛形を追加
2. WSプロトコル（`hello/snapshot/event/heartbeat`）を固定
3. Queue/Worker/Evalのsnapshotを最初に表示
4. `task.done / task.failed / task.deferred / llm.task.degraded` のpush実装
