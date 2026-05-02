# Session ナレッジ抽出エンジン実装計画

## 目的

既存の Session 蒸留結果（`session_distillations` / `session_knowledge_candidates`）から、
`record_task_note` に登録する価値がある候補を選別・承認・登録できる運用導線を作る。

主目的:

1. 候補の一覧・承認・却下・登録を安定運用できること。
2. 不要なテーブル増設や重複実装を避け、既存蒸留基盤を再利用すること。
3. KnowFlow と競合しないよう、抽出実行はキュー経由で順次処理すること。

## 非目的

- raw transcript から直接抽出する新エンジンを作ること。
- `record_task_note` を自動実行して無承認登録すること。
- graph / `experience_logs` を直接更新すること。
- 既存蒸留テーブルと同等責務の新規テーブルを作ること。

## 現状との整合

本計画は現行実装を前提にする。

- 蒸留保存: `session_distillations` / `session_knowledge_candidates`
- 候補属性: `kind`, `keep`, `keepReason`, `status`, `promotedNoteId`, `evidence`, `actions`
- 実行経路: `session-summary enqueue` -> `background_tasks` -> `background/runner`
- 登録API: `recordTaskNote()`

このため、`session_summaries` / `session_turn_summaries` や
`session_knowledge_extraction_runs` の新設は行わない。

## 設計方針

1. 抽出は既存 `session_knowledge_candidates` を再利用する。
2. 承認・却下・登録は「候補の状態遷移」として扱う。
3. 登録実行は明示操作時のみ `recordTaskNote()` を呼ぶ。
4. 抽出実行は必ずキュー投入し、ワーカーで順次処理する。
5. Local LLM 未設定でも deterministic 候補で運用できるようにする。
6. 新しい候補種別の増設は最小化し、まず `lesson/rule/procedure/candidate` で運用する。

## 候補種別ポリシー

初期運用の kind は既存スキーマに合わせる。

- `lesson`
- `rule`
- `procedure`
- `candidate`

`risk` / `command_recipe` / `reference` の追加は後続検討とし、
初期は `candidate` で受けて承認時に `record_task_note.kind` へマッピングする。

## 状態遷移

候補ステータスは専用列で運用する（`approvalStatus` / `rejectionReason` / `recordError`）。

1. 抽出直後: `status = deterministic | llm_succeeded | llm_failed`
2. 承認: `approvalStatus = approved`
3. 却下: `approvalStatus = rejected`, `rejectionReason` 設定
4. 登録成功: `promotedNoteId` 設定
5. 登録失敗: `recordError` 記録

## キュー実行方針

抽出処理は直接呼び出し禁止。

- CLI: `session-summary enqueue --session-id ...`
- 実行: `background_tasks` の `session_distillation` をワーカーが処理
- UI: 「知識抽出」ボタンは enqueue のみ行う

これにより KnowFlow と同じ実行レーンで直列化し、競合を抑える。

## 実装スコープ

### 1. Approval/Record サービス追加

追加:
- `src/services/sessionKnowledge/approval.ts`

責務:
- 候補の承認情報を metadata に記録
- `recordTaskNote()` 実行
- 成功時 `promotedNoteId` 更新
- 失敗時 `metadata.recordError` 保存

### 2. Repository 拡張

対象:
- `src/services/sessionSummary/repository.ts`

追加API（例）:

```ts
listCandidatesBySession(sessionKey: string)
approveCandidate(candidateId: string)
rejectCandidate(candidateId: string, reason: string)
markCandidateRecordResult(candidateId: string, result: { promotedNoteId?: string; error?: string })
```

### 3. CLI 追加

追加ファイル:
- `src/scripts/session-knowledge.ts`

コマンド:

```bash
bun src/scripts/session-knowledge.ts list --session-id <id> --json
bun src/scripts/session-knowledge.ts approve --candidate-id <id> --json
bun src/scripts/session-knowledge.ts reject --candidate-id <id> --reason "..." --json
bun src/scripts/session-knowledge.ts record --candidate-id <id> --json
```

### 4. Monitor UI 追加

対象:
- `apps/monitor/src/routes/sessions/+page.svelte`
- Tauri command 配線一式

UI要件:
- 候補一覧表示（kind, keep, keepReason, evidence, status）
- 承認/却下/登録ボタン
- キュー投入状態と最終登録結果の表示
- Session サブメニューに `Summarize` タブを設け、セッション別の要約一覧（distillation list）を表示

## `record_task_note` マッピング

初期マッピング:

| candidate field | recordTaskNote field |
| --- | --- |
| `title` + `statement` | `content` |
| `kind` | `kind`（`candidate` は `observation` にフォールバック） |
| `confidence` | `confidence` |
| `evidence` | `evidence` |
| `metadata` | `metadata`（`sessionKey`, `distillationId`, `candidateId`） |
| source | `task` |

## テスト計画

追加:
- `test/sessionKnowledge.approval.test.ts`
- `test/sessionKnowledge.cli.test.ts`
- `test/sessionKnowledge.repository.test.ts`

重点:
1. `record` は明示呼び出し時のみ実行される。
2. `promotedNoteId` が保存される。
3. 失敗時に `metadata.recordError` が保存される。
4. `candidate` kind のフォールバックマッピングが動作する。
5. queue 実行と干渉せず UI から一覧参照できる。

## 実装順序

1. `sessionSummary/repository.ts` に候補操作APIを追加。
2. `sessionKnowledge/approval.ts` を追加。
3. `session-knowledge.ts` CLI を追加。
4. Monitor Tauri command を追加。
5. Sessions UI に承認/却下/登録操作を追加。
6. テスト追加。
7. `bun run typecheck` / `bun run --cwd apps/monitor check` / `bun run verify:fast`。

## 完了条件

- 既存 `session_knowledge_candidates` を使って候補運用できる。
- 抽出実行はキュー経由で運用される。
- 承認なしで `record_task_note` が実行されない。
- 承認・却下・登録が CLI/UI で操作できる。
- 登録結果（成功/失敗）を候補行から追跡できる。
- `bun run verify:fast` が通る。
