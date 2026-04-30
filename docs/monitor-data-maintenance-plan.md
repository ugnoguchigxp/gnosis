# Monitor データメンテナンス改善計画

## 目的

Tauri Monitor で Gnosis の運用データを安全に保守できる範囲を明確にし、未対応のデータ種別を後日実装できる粒度に分解する。

この計画では、Monitor を「なんでも直接編集する DB 管理画面」にはしない。Agent / CLI / MCP が使うデータを、現在の運用単位に合わせて確認、昇格、却下、再実行、無効化できる画面にする。

## 現状確認

現状の Monitor navigation は Dashboard / Queue / Graph / Memories の4面である。

- Dashboard: snapshot、timeline、KnowFlow task enqueue
- Queue: `topic_tasks` の一覧
- Graph: `entities` の一部編集、削除、relation 作成
- Memories: `experience_logs` と guidance 用の rule / skill CRUD

Tauri command と CLI には一部 CRUD があるが、画面に露出していない操作がある。特に relation delete、entity create、entity metadata/provenance/freshness 編集、queue retry/cancel/defer/delete は UI にない。

## データ分類

### 現在 UI で保守できるデータ

| データ | 保存先 table | 現在の UI | 不足 |
| --- | --- | --- | --- |
| Lessons | `experience_logs` | Memories / lessons | failure / success 以外の知識候補とはつながっていない |
| Rules / Skills | `entities`, `vibe_memories` | Memories / rules, skills | procedure / decision / risk / reference / command_recipe を扱えない |
| Graph entities | `entities` | Graph | create と詳細 metadata 編集が弱い |
| Graph relations | `relations` | Graph | create は限定的、delete/edit がない |
| KnowFlow queue | `topic_tasks` | Dashboard enqueue, Queue list | retry/cancel/defer/delete がない |

### 現行機能で使われているが UI で保守できないデータ

| データ | 保存先 table | 現状 | 必要な UI |
| --- | --- | --- | --- |
| Failure Firewall Golden Paths | `failure_firewall_golden_paths` | active-use 実装済み | candidate review、approve/reject、status/severity 更新 |
| Failure Firewall Patterns | `failure_firewall_patterns` | active-use 実装済み | false positive 管理、golden path 紐付け、status 更新 |
| Review cases | `review_cases` | review pipeline の記録 | case/outcome 閲覧、再レビュー、不要データ整理 |
| Review outcomes | `review_outcomes` | review pipeline の結果 | finding 単位の確認、Failure Firewall 連携 |
| KnowFlow corpus | `knowledge_topics`, `knowledge_claims`, `knowledge_relations`, `knowledge_sources` | 現行 repository と search surface で利用中 | topic/claim/source の閲覧、古さ判定、無効化、再収集 |
| Keyword evaluations | `knowflow_keyword_evaluations` | seed/eval 補助 | 評価履歴閲覧、失敗理由と再実行 |
| Raw memories | `vibe_memories` | guidance の保存先として利用 | raw memory 単位の閲覧、孤立データ整理 |
| Sync state | `sync_state` | ingestion cursor | cursor 閲覧、リセット、dry-run |

### 廃止候補

| データ | 保存先 table | 判断 |
| --- | --- | --- |
| Hook executions | `hook_executions` | hooks は廃止済みなら schema から削除候補 |
| Hook candidates | `hook_candidates` | hooks は廃止済みなら schema から削除候補 |

Hook tables は削除前に、現在のコードが read/write していないこと、履歴を残す必要がないこと、既存 DB の drop migration を許容できることを確認する。既存 migration file を書き換えるのではなく、新しい migration で drop する。

Phase 1 時点で hook tables がまだ存在する場合だけ deprecated badge を表示する。Phase 7 完了後は inventory から hook tables を消し、削除済みの migration note だけを残す。

## 設計判断

1. Monitor の保守単位は table 名ではなく運用概念に合わせる。
   - Failure Firewall
   - Review
   - KnowFlow Corpus
   - Graph
   - Queue
   - System State

2. destructive 操作は direct delete より先に status change を優先する。
   - `active -> archived`
   - `needs_review -> rejected`
   - `pending -> cancelled`
   - cursor reset は dry-run preview を必須にする。

3. KnowFlow corpus は現行データとして扱う。
   - `knowledge_claims` は検索 surface として使われている。
   - `knowledge_topics`, `knowledge_claims`, `knowledge_relations`, `knowledge_sources` を legacy 扱いで隠さない。
   - ただし UI 上の名称は `KnowFlow Corpus` にして、Graph の `entities/relations` と混同しない。

4. hooks は deprecated cleanup として別 PR に分ける。
   - schema export 削除
   - drop migration 追加
   - migration snapshot 更新
   - stale imports / docs / tests の削除
   - verify

## 変更操作ポリシー

Monitor からの write 操作は、対象ごとに許可する遷移を固定する。未定義の status 変更、raw SQL、任意 JSON patch は初期実装では禁止する。

| 領域 | 許可する変更 | 初期実装では禁止する変更 |
| --- | --- | --- |
| Failure Firewall | `needs_review -> active`, `needs_review -> rejected`, `active -> archived`, severity update, false positive increment | hard delete、任意 pattern rewrite |
| Review | outcome から candidate 作成、old case archive | outcome rewrite、finding rewrite |
| KnowFlow Corpus | mark stale、request refresh、mark merge candidate、preview 後の archive topic | hard delete、automatic merge |
| Graph | validated fields による entity create/update、relation create/delete | JSON validation なしの unrestricted metadata overwrite |
| Queue | failed/deferred task の retry を新 task 作成で行う、pending/deferred task cancel | running task delete、task payload の in-place mutation |
| Sync State | dry-run preview、明示 confirmation 後の cursor reset | blind cursor update |

Queue delete は first write pass では対象外にする。後で追加する場合も、documented age threshold より古い terminal task に限定し、audit row または exported backup を残す。

## マイグレーション安全性

DB schema cleanup、特に hook table removal は次の順序で実施する。

1. `rg "hook_executions|hook_candidates|hookExecutions|hookCandidates"` で runtime read/write references がないことを確認する。
2. hook rows が存在する場合、drop 前に export または snapshot を残す。
3. forward drop migration だけを追加する。既存 migration file は書き換えない。
4. 以前の table definitions と restore command を rollback note として残す。
5. `src/db/schema.ts`、Drizzle journal、Drizzle snapshot を同時に更新する。
6. 通常 local DB に適用する前に disposable database で migration を実行する。

## 実装計画

### フェーズ 1: インベントリと読み取り専用表示

目的: まず「何が存在するか」を Monitor から確認できるようにする。

対象ファイル:

- `src/scripts/monitor-data-inventory.ts`
- `apps/monitor/src-tauri/src/monitor/cli.rs`
- `apps/monitor/src-tauri/src/monitor/commands.rs`
- `apps/monitor/src/lib/monitor/types.ts`
- `apps/monitor/src/routes/*`

作業:

1. `monitor-data-inventory` CLI を追加し、主要 table の件数、最新更新日時、status breakdown を JSON で返す。
2. Tauri command `monitor_data_inventory` を追加する。
3. Dashboard または新規 Data view に inventory summary を表示する。
4. Hook tables は deprecated badge を表示する。
5. KnowFlow corpus は active badge を表示し、Graph とは別カテゴリにする。

受け入れ条件:

- `monitor_data_inventory` が `category`, `table`, `rowCount`, `latestUpdatedAt`, `statusCounts`, `maintenanceState` を含む JSON を返す。
- Monitor は CLI から返った全 categories を表示し、row count を hard-code しない。
- KnowFlow corpus は `maintenanceState: "active"` を持つ。
- Hook tables は、table がまだ存在する場合だけ `maintenanceState: "deprecated"` を持つ。

### フェーズ 2: Failure Firewall メンテナンス

目的: verify / commit approval 後に生成される成功・失敗候補を、低摩擦で昇格・却下できるようにする。

対象ファイル:

- `src/scripts/monitor-failure-firewall.ts`
- `apps/monitor/src/routes/failure-firewall/+page.svelte`
- `apps/monitor/src-tauri/src/monitor/cli.rs`
- `apps/monitor/src-tauri/src/monitor/commands.rs`

作業:

1. Golden Path と failure pattern を list / approve / reject / archive できる CLI を追加する。
2. `needs_review` 候補を先頭に出す。
3. candidate には source note、risk signals、severity、last matched review を表示する。
4. pattern の false positive count を調整できるようにする。
5. destructive delete は初期実装では提供せず、archive に限定する。

受け入れ条件:

- Failure Firewall candidate を Monitor から approve/reject できる。
- approve は `needs_review -> active`、reject は `needs_review -> rejected`、archive は `active -> archived` だけを許可する。
- CLI test が許可外遷移を拒否する。
- `review_task` / `agentic_search` は `active` データだけを参照する。

### フェーズ 3: レビューデータメンテナンス

目的: review records を Failure Firewall と知識登録の入力として確認できるようにする。

対象ファイル:

- `src/scripts/monitor-review-data.ts`
- `apps/monitor/src/routes/reviews/+page.svelte`

作業:

1. `review_cases` / `review_outcomes` の一覧と detail を追加する。
2. finding count、blocking reason、provider、createdAt で filter できるようにする。
3. outcome から Failure Firewall candidate または task note 候補を作れる導線を設ける。
4. 再レビュー実行は後続に回し、初期は閲覧と候補化に限定する。

受け入れ条件:

- `monitor-review-data` が provider、createdAt、blocking status、finding count で review cases を list できる。
- case を選択すると outcomes と finding summary を取得できる。
- Failure Firewall または task-note candidate を作る時、source review id が metadata に保存される。

### フェーズ 4: KnowFlow corpus メンテナンス

目的: active corpus としての `knowledge_*` を見える化し、古さと重複を管理する。

対象ファイル:

- `src/scripts/monitor-knowflow-corpus.ts`
- `apps/monitor/src/routes/knowflow-corpus/+page.svelte`
- `src/services/knowflow/knowledge/repository.ts`

作業:

1. topic / claim / relation / source を topic 単位で表示する。
2. claim confidence、source count、updatedAt、coverage を表示する。
3. topic lifecycle は metadata に `maintenanceState` を持たせる。初期値は `active`、許可値は `active`, `stale`, `refresh_requested`, `merge_candidate`, `archived` とする。
4. source URL の重複と dead source を検出する read-only check を追加する。
5. `search_knowledge` が参照する corpus であることを UI に明記する。

受け入れ条件:

- `monitor-knowflow-corpus` が claims、relations、sources、coverage、confidence、`maintenanceState` を含む topic detail を返す。
- topic は documented `maintenanceState` values の間だけを遷移できる。
- duplicate source と source-missing checks が machine-readable issue rows を返す。
- hard delete は公開しない。

### フェーズ 5: Graph メンテナンス補完

目的: 既存 Graph 画面を relation / entity 保守に耐える状態にする。

対象ファイル:

- `apps/monitor/src/routes/graph/+page.svelte`
- `src/scripts/monitor-memory-crud.ts`

作業:

1. entity create UI を追加する。
2. entity metadata / provenance / freshness / confidence / scope を JSON editor 付きで編集できるようにする。
3. relation list に delete action を追加する。
4. relation type を固定3種だけでなく、既存 DB の relation types から選べるようにする。
5. relation edit は first pass では入れない。relation の修正は delete + create で扱う。

受け入れ条件:

- Graph entities と relations の保守操作が CLI capability と一致する。
- relation を作ったが消せない状態を解消する。
- invalid entity metadata JSON は Tauri command 呼び出し前に reject される。

### フェーズ 6: Queue メンテナンス

目的: KnowFlow queue を見るだけでなく、安全に整備できるようにする。

対象ファイル:

- `src/scripts/monitor-tasks.ts`
- `src/scripts/enqueue-task.ts`
- `apps/monitor/src/routes/tasks/+page.svelte`

作業:

1. retry / cancel を追加する。
2. failed / deferred / stale running task を filter できるようにする。
3. retry は既存 task を mutate せず、新しい task を enqueue し、source task id を payload に残す。
4. cancel は `pending` / `deferred` のみ許可する。
5. queue action は audit metadata を残す。

受け入れ条件:

- failed / deferred task から retry すると、新しい task が作成される。
- pending / deferred task だけが cancelled に遷移できる。
- running task の cancel と delete は CLI test で拒否される。
- queue 操作後に snapshot が更新される。

### フェーズ 7: Hook schema 削除

目的: 廃止済み hooks の schema と migration surface を整理する。

対象ファイル:

- `src/db/schema.ts`
- `drizzle/*.sql`
- `drizzle/meta/_journal.json`
- `drizzle/meta/*_snapshot.json`
- stale imports / tests / docs

作業:

1. `rg "hook_executions|hook_candidates|hookExecutions|hookCandidates"` で参照を確認する。
2. 実行コードに read/write がないことを確認する。
3. drop migration を追加する。
4. `src/db/schema.ts` から hook table exports を削除する。
5. Drizzle snapshot と journal を更新する。
6. monitor inventory から deprecated badge を削除し、削除済み扱いに更新する。

受け入れ条件:

- schema から hook tables が消える。
- migration 適用後の DB に hook tables が残らない。
- hook rows が存在する場合、drop 前の export artifact または明示的な破棄判断が残る。
- disposable DB で migration apply が通る。
- verify が通る。

## 推奨順序

1. フェーズ 1: インベントリ
2. フェーズ 7: hook schema 削除
3. フェーズ 1 follow-up: migration 後に inventory から hook deprecated state を削除
4. フェーズ 2: Failure Firewall
5. フェーズ 5: Graph 補完
6. フェーズ 6: Queue メンテナンス
7. フェーズ 4: KnowFlow corpus
8. フェーズ 3: レビューデータ

Hook cleanup は小さく閉じられるため早めに実施する。KnowFlow corpus と Review data は設計判断が多いため、read-only visibility を先に入れてから編集操作を足す。

## 検証

各 phase の minimum verification:

```sh
bun run typecheck
bun test
bun run verify
```

Monitor UI を変更した phase は追加で以下を実行する。

```sh
bun run monitor:snapshot -- --json
cd apps/monitor && bun run check
```

DB schema を変更する phase は、migration SQL、`src/db/schema.ts`、Drizzle journal、snapshot の4点が揃っていることを確認する。

## 対象外

- Monitor を汎用 SQL editor にしない。
- Failure Firewall を primary MCP tool として増やさない。
- KnowFlow corpus を legacy と決め打ちで削除しない。
- Hook tables の既存 migration file を書き換えない。
