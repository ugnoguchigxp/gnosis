# Monitor データメンテナンス改善計画（Refined）

## 目的

Tauri Monitor で「運用上重要だが現在は保守・監視しづらいデータ」を段階的に扱えるようにする。  
本計画は DB 管理画面化ではなく、運用フロー単位での可視化と安全な操作に限定する。

## スコープと前提（2026-05-01 時点）

- 現行 Monitor 画面: `Dashboard / Queue / Graph / Memories`
- 現行 Tauri command: Queue/Graph/Memories 系のみ
- 未実装領域: Failure Firewall / Review / KnowFlow Corpus / Sync State 専用 command
- schema 制約:
1. Failure Firewall status は `active | needs_review | deprecated`
2. `topic_tasks` に `cancelled` は未定義

## 実態差分（現行ドキュメントとの差）

1. Graph は relation create は可能だが relation delete は UI 非対応（command は存在）。
2. Queue snapshot は `pending/running/deferred/failed` のみで `done` 可視化なし。
3. Failure Firewall の遷移は `rejected/archived` ではなく `deprecated` 前提で設計する必要がある。
4. Queue の cancel は status 追加 migration なしで直接導入できない。

## 監視・保守対象の全体像

### A. 既に UI で一部扱える

- `experience_logs`
- `vibe_memories` / guidance 用 entity
- `entities`
- `relations`（作成中心）
- `topic_tasks`（一覧中心）

### B. 現行機能で使われるが UI 未対応

- `failure_firewall_golden_paths`
- `failure_firewall_patterns`
- `review_cases`
- `review_outcomes`
- `knowledge_topics`
- `knowledge_claims`
- `knowledge_relations`
- `knowledge_sources`
- `knowflow_keyword_evaluations`
- `sync_state`
- `communities`

### C. 監視不能/監視弱い項目（優先追加対象）

1. Queue terminal volume: `topic_tasks(status='done')`
2. Queue lock health: `locked_at`, `lock_owner`, `next_run_at`
3. Failure Firewall backlog: `needs_review` 件数と経過時間
4. Review lifecycle drift: `review_cases.status/review_status` と `review_outcomes.outcome_type`
5. Knowledge freshness: `knowledge_sources.fetched_at`, `knowledge_topics.updated_at`
6. Keyword eval quality: `decision`, `threshold`, `modelAlias` の偏り
7. Community health: `communities` と member count

## 操作ポリシー（初期実装）

- 禁止:
1. raw SQL 実行
2. 任意 JSON patch
3. schema 未定義 status への更新
4. hard delete（明示許可した cleanup phase を除く）

- 許可:
1. Failure Firewall: `needs_review -> active`, `active -> deprecated`
2. Queue: retry は新規 enqueue、defer は既存 status ルール内で更新
3. Graph: バリデーション済み entity update/create、relation create/delete
4. Sync State: dry-run preview 後の明示確認付き reset

## 実装フェーズ（実行順）

### Phase 1: Inventory と監視基盤（Read-only）

目的: まず「見える化」を完成させ、書き込み前に運用状態を把握可能にする。

対象:
- `src/scripts/monitor-data-inventory.ts`（新規）
- `apps/monitor/src-tauri/src/monitor/cli.rs`
- `apps/monitor/src-tauri/src/monitor/commands.rs`
- `apps/monitor/src/lib/monitor/types.ts`
- `apps/monitor/src/routes/+page.svelte` または新規 `/data`

実装:
1. 主要 table ごとの `rowCount`, `latestUpdatedAt`, `statusCounts`, `maintenanceState` を返す CLI を追加。
2. 監視弱点（Queue done/lock, Failure backlog, Review drift, Knowledge freshness）を summary 指標として返す。
3. UI はカテゴリ別カード表示にし、Graph/Queue/Memories と独立表示する。

完了条件:
1. row count がハードコードなしで表示される。
2. 監視弱点7項目のうち少なくとも6項目が UI 上で確認可能。
3. Hook table が存在する場合のみ `deprecated` 表示。

### Phase 2: Queue 運用保守

目的: Queue を「見るだけ」から「安全に整備できる」へ拡張する。

対象:
- `src/scripts/monitor-tasks.ts`
- `src/scripts/enqueue-task.ts`
- `apps/monitor/src/routes/tasks/+page.svelte`
- 必要なら新規 `src/scripts/monitor-task-actions.ts`

実装:
1. retry（新規 task 作成）
2. defer（許可状態のみ）
3. stale running 判定表示（lock health ベース）
4. 履歴フィルタに `done` 集計ビュー追加

完了条件:
1. retry で元 task の in-place mutation が発生しない。
2. running task への危険操作（delete/invalid update）を拒否。
3. done 蓄積が可視化される。

### Phase 3: Graph 補完

目的: 既存 Graph を運用保守に必要な最小操作まで拡張する。

対象:
- `apps/monitor/src/routes/graph/+page.svelte`
- `src/scripts/monitor-memory-crud.ts`

実装:
1. entity create 導線
2. metadata/provenance/freshness/confidence/scope 編集
3. relation delete UI（既存 command 接続）

完了条件:
1. relation create/delete 両方を UI から実行可能。
2. metadata 不正 JSON を事前バリデーションで拒否。

### Phase 4: Failure Firewall 保守

目的: `needs_review` backlog の解消と quality 維持。

対象:
- `src/scripts/monitor-failure-firewall.ts`（新規）
- `apps/monitor/src/routes/failure-firewall/+page.svelte`（新規）
- Tauri command 追加

実装:
1. Golden Paths/Patterns 一覧
2. `needs_review -> active`
3. `active -> deprecated`
4. false positive count 更新

完了条件:
1. schema 制約外遷移（`rejected` 等）を拒否。
2. `needs_review` の滞留件数と経過時間を確認可能。

### Phase 5: Review データ保守（Read-heavy）

目的: Review 記録を運用改善に再利用する。

対象:
- `src/scripts/monitor-review-data.ts`（新規）
- `apps/monitor/src/routes/reviews/+page.svelte`（新規）

実装:
1. cases/outcomes 一覧・詳細
2. provider/createdAt/finding count/filter
3. Failure Firewall 候補化への導線（source review id 付与）

完了条件:
1. pending 長期滞留が抽出可能。
2. case -> outcome -> 候補化が UI で追える。

### Phase 6: KnowFlow Corpus と Evaluation

目的: 検索面で使われる corpus/eval の鮮度・偏りを保守可能にする。

対象:
- `src/scripts/monitor-knowflow-corpus.ts`（新規）
- `src/scripts/monitor-knowflow-evals.ts`（新規）
- `apps/monitor/src/routes/knowflow-corpus/+page.svelte`（新規）

実装:
1. topic/claim/relation/source の topic 集約表示
2. freshness/duplicate/dead source チェック
3. eval decision/threshold/modelAlias の偏り可視化

完了条件:
1. `search_knowledge` の根拠データを Monitor で追跡可能。
2. source freshness 劣化と eval 偏りを機械的に検知可能。

### Phase 7: Sync State と Communities

目的: 運用上重要だが盲点になりやすい補助データを管理対象に入れる。

対象:
- `src/scripts/monitor-sync-state.ts`（新規）
- `src/scripts/monitor-communities.ts`（新規）
- 新規 route

実装:
1. sync cursor preview/reset（dry-run 必須）
2. communities の一覧・member count・summary 保守

完了条件:
1. cursor reset が常に preview + confirm を通る。
2. community health を一覧で監視できる。

### Phase 8: Hook schema cleanup

目的: 使われていない hook テーブルを安全に撤去する。

対象:
- `src/db/schema.ts`
- `drizzle/*.sql`
- `drizzle/meta/_journal.json`
- `drizzle/meta/*_snapshot.json`

実装:
1. 参照検索で runtime read/write 不在を確認
2. 既存 row の export または破棄判断を記録
3. forward drop migration 追加

完了条件:
1. migration 後に hook tables が残らない。
2. verify が通る。

## Migration 依存ルール

- `topic_tasks` に cancel 系 status を追加したい場合:
1. status check migration
2. action CLI test 更新
3. UI 操作の順で導入

- Failure Firewall の status を増やしたい場合:
1. schema check 更新
2. service 側読み取り条件更新
3. Monitor 操作追加

## 検証

共通:

```sh
bun run typecheck
bun test
bun run verify
```

Monitor 変更フェーズ:

```sh
bun run monitor:snapshot -- --json
cd apps/monitor && bun run check
```

DB 変更フェーズ:

- migration SQL
- `src/db/schema.ts`
- Drizzle journal
- Drizzle snapshot

の4点同時更新を必須とする。

## 対象外

- 汎用 SQL editor 化
- 既存 migration の書き換え
- hard delete 中心の運用
