# Session Knowledge Distillation Engine 実装計画

## 目的

Session の対話ログを「ユーザー発言から次のユーザー発言直前まで」の単位に分割し、
要約テキストを作ること自体ではなく、後続で再利用できる知識候補を抽出・保存する。

本計画の主目的は次の 2 点。

1. 知識として残すべき情報（lesson/rule/procedure）を候補化する。
2. 一過性・文脈依存・再利用不能な情報を除外する。

raw transcript は一次情報として保持し、抽出結果は派生データとして扱う。

## 非目的

- raw transcript の削除・改変。
- 既存 graph 合成 (`synthesizeKnowledge`) の即時置換。
- すべての候補を自動で durable knowledge に昇格すること。

## 設計原則

1. raw transcript は唯一の一次情報として残す。
2. 生成物は「読みやすい要約」ではなく「知識候補」を中心に保存する。
3. 1 turn は「ユーザー発言を起点に、次のユーザー発言直前まで」とする。
4. deterministic 抽出を先行し、LLM は候補の圧縮と分類に限定する。
5. 候補は `lesson` / `rule` / `procedure` の 3 種へ分類する。
6. 各候補に keep/drop 判定理由を残し、判定根拠を追跡可能にする。
7. Local LLM 未設定でも deterministic 抽出だけで候補化を成立させる。
8. `sessionKey + transcriptHash + promptVersion` で idempotent に保存する。
9. 実行は直接呼び出しではなく `background_tasks` キューへ投入し、ワーカーで順次処理する。

## Keep / Drop 判定基準

### keep 条件（1 つ以上を満たす）

- 他タスクへ転用可能（再利用性がある）。
- 失敗回避または成功再現に直接効く。
- 判断基準として一般化できる。
- 手順として再実行可能。

### drop 条件（いずれかを満たす）

- その場の雑談・感想・進行メモのみ。
- 実行環境固有で一般化不能（例: 単発の一時パスのみ）。
- 根拠のない推測や未検証結論。
- 同一内容の重複。

## 知識分類ルール

- `lesson`: 成功/失敗の結果から得た再利用可能な学び。
- `rule`: 守るべき制約、判断基準、運用ルール。
- `procedure`: 再現可能な手順（前提、手順、検証を含む）。

補足:
- 分類不能な候補は `candidate` として一時保存し、昇格対象外にする。
- `rule` と `procedure` を混在させない。規範は `rule`、操作列は `procedure`。

## データモデル

`src/db/schema.ts` に以下を追加する。migration は `bun run db:generate` で生成し、必要に応じて SQL を手修正する。

### `session_distillations`

Session 全体の抽出ジョブを表す。

| column | type | required | note |
| --- | --- | --- | --- |
| `id` | uuid | yes | primary key |
| `sessionKey` | text | yes | UI session id 正規化値 |
| `transcriptHash` | text | yes | 対象 message 列ハッシュ |
| `promptVersion` | text | yes | 例: `session-distill-v1` |
| `status` | text | yes | `pending` / `running` / `succeeded` / `failed` / `stale` |
| `modelProvider` | text | no | `deterministic` / `local-llm` / `openai` / `bedrock` |
| `modelName` | text | no | 実行モデル名 |
| `turnCount` | integer | yes | 分割 turn 数 |
| `messageCount` | integer | yes | 入力 message 数 |
| `keptCount` | integer | yes | keep された候補数 |
| `droppedCount` | integer | yes | drop された候補数 |
| `metadata` | jsonb | yes | `{}` default |
| `error` | text | no | 失敗理由 |
| `createdAt` | timestamp | yes | default now |
| `updatedAt` | timestamp | yes | update 時に更新 |
| `completedAt` | timestamp | no | 成功・失敗時 |

制約:

- unique: `(sessionKey, transcriptHash, promptVersion)`
- index: `(sessionKey, createdAt desc)`
- index: `(status, createdAt desc)`

### `session_knowledge_candidates`

turn 単位で抽出された知識候補を表す。

| column | type | required | note |
| --- | --- | --- | --- |
| `id` | uuid | yes | primary key |
| `distillationId` | uuid | yes | `session_distillations.id` cascade delete |
| `turnIndex` | integer | yes | 0-based |
| `kind` | text | yes | `lesson` / `rule` / `procedure` / `candidate` |
| `title` | text | yes | 候補の短い見出し |
| `statement` | text | yes | 知識本文 |
| `keep` | boolean | yes | keep/drop |
| `keepReason` | text | yes | 判定理由 |
| `evidence` | jsonb | yes | 根拠ログ・コマンド・結果 |
| `actions` | jsonb | yes | 関連操作 |
| `confidence` | real | yes | 0.0-1.0 |
| `status` | text | yes | `deterministic` / `llm_succeeded` / `llm_failed` |
| `promotedNoteId` | text | no | `record_task_note` 登録時の id |
| `createdAt` | timestamp | yes | default now |
| `updatedAt` | timestamp | yes | update 時に更新 |

制約:

- index: `(distillationId, turnIndex)`
- index: `(kind, keep)`
- index: `(promotedNoteId)`

## 型定義

追加ファイル:

- `src/services/sessionSummary/types.ts`

主要型（抜粋）:

```ts
export type KnowledgeKind = "lesson" | "rule" | "procedure" | "candidate";

export interface KnowledgeCandidate {
  turnIndex: number;
  kind: KnowledgeKind;
  title: string;
  statement: string;
  keep: boolean;
  keepReason: string;
  evidence: SessionEvidence[];
  actions: SessionAction[];
  confidence: number;
  status: "deterministic" | "llm_succeeded" | "llm_failed";
}
```

## 実装ファイル

### `src/services/sessionSummary/segmenter.ts`

責務:

- `SessionMessageInput[]` を `SessionTurnBlock[]` に分割する。
- `# AGENTS.md instructions for ...`、`<environment_context>`、長い bootstrap 文を抽出対象から除外する。
- session 冒頭の preamble は保持するが、知識候補化に混ぜない。

### `src/services/sessionSummary/evidence.ts`

責務:

- deterministic に候補根拠を抽出する。
- LLM 失敗時も keep/drop 判定可能な最小情報を残す。

抽出対象:

- 実行コマンド、テスト結果、エラー、検証結果、変更ファイル、ツール呼び出し、意思決定。

注意:

- 過剰な正規表現で意味を確定しない。
- 意味確定は `candidate` 生成フェーズで行う。

### `src/services/sessionSummary/candidate.ts`（新規）

責務:

- evidence/actions と turn 文脈から知識候補を生成する。
- keep/drop と kind を deterministic で一次判定する。

出力:

- `KnowledgeCandidate[]`

### `src/services/sessionSummary/prompt.ts`

責務:

- turn ごとの候補圧縮用プロンプトを生成する。
- `promptVersion` を export する。

出力 schema（LLM には JSON のみ許可）:

```json
{
  "candidates": [
    {
      "kind": "lesson|rule|procedure|candidate",
      "title": "string",
      "statement": "string",
      "keep": true,
      "keepReason": "string",
      "confidence": 0.0,
      "evidence": [{ "kind": "result", "text": "string" }]
    }
  ]
}
```

要件:

- 日本語で出力する。
- 不明なことを補完しない。
- 候補は 1 turn あたり最大 8 件。
- keep=false 候補も理由付きで返す。

### `src/services/sessionSummary/llm.ts`

責務:

- `runPromptWithMemoryLoopRouter()` 経由で LLM を呼ぶ。
- `taskKind: "distillation"` を使う。
- Local LLM 未設定時は deterministic のみで完了する。
- JSON parse 失敗時は deterministic 結果へ fallback し、status を `llm_failed` にする。

### `src/services/sessionSummary/repository.ts`

責務:

- `session_distillations` の upsert。
- `session_knowledge_candidates` の replace/upsert。
- `transcriptHash` ベースの再利用判定。
- status 更新。

### `src/services/sessionSummary/promotion.ts`（新規）

責務:

- keep=true かつ `kind in (lesson, rule, procedure)` の候補を `record_task_note` へ昇格する。
- `dryRun` では DB 保存のみ、昇格はしない。

昇格ポリシー:

- `lesson` -> `kind: "lesson"`
- `rule` -> `kind: "rule"`
- `procedure` -> `kind: "procedure"`

## エンジン

### `src/services/sessionSummary/engine.ts`

API:

```ts
export async function distillSessionKnowledge(input: {
  sessionId: string;
  force?: boolean;
  dryRun?: boolean;
  provider?: "auto" | "deterministic" | "local" | "openai" | "bedrock";
  promote?: boolean;
}): Promise<DistillSessionResult>;
```

処理順:

1. session detail 取得。
2. message を昇順正規化。
3. context-only message を除外。
4. transcript hash 計算。
5. 既存成功ジョブ再利用判定（`force` なし）。
6. `session_distillations` を `running` で作成。
7. turn 分割。
8. deterministic evidence/actions 抽出。
9. deterministic 候補生成（keep/drop 一次判定）。
10. LLM 利用可能なら候補を圧縮・再分類。
11. 候補を保存。
12. `promote=true` なら昇格対象を `record_task_note` 登録。
13. parent を `succeeded` / `failed` に更新。

## CLI

追加ファイル:

- `src/scripts/session-summary.ts`（キュー投入専用）

コマンド:

```bash
bun src/scripts/session-summary.ts enqueue --session-id <id> --json
bun src/scripts/session-summary.ts enqueue --session-id <id> --force --json
bun src/scripts/session-summary.ts enqueue --session-id <id> --promote --json
bun src/scripts/session-summary.ts list --json
bun src/scripts/session-summary.ts show --distillation-id <id> --json
bun src/scripts/session-summary.ts status --session-id <id> --json
```

`package.json` scripts:

```json
{
  "session:summary": "bun src/scripts/session-summary.ts"
}
```

出力:

- `distillationId`, `sessionKey`, `status`, `turnCount`, `keptCount`, `droppedCount`, `promotedCount`。
- 失敗時も JSON (`status: "failed"`, `error`)。
- `enqueue` は `taskId`, `queued`, `status: "pending"` を返す。

## Monitor UI 連携

対象ファイル:

- `apps/monitor/src-tauri/src/monitor/cli.rs`
- `apps/monitor/src-tauri/src/monitor/commands.rs`
- `apps/monitor/src-tauri/src/lib.rs`
- `apps/monitor/src-tauri/permissions/monitor.toml`
- `apps/monitor/src/lib/monitor/types.ts`
- `apps/monitor/src/routes/sessions/+page.svelte`

追加 command:

- `monitor_session_distillation(session_id: String)`
- `monitor_distill_session_knowledge(session_id: String, force: bool, promote: bool)`

UI 要件:

- 「要約」ではなく「知識抽出」ボタンを設置。
- ボタン押下時は即時抽出ではなくキュー投入 (`session_distillation`) を行う。
- `keep` 候補と `drop` 候補を分離表示。
- `lesson/rule/procedure` を明示表示。
- `promoted` 状態（登録済み/未登録）を表示。
- LLM 未使用・LLM 失敗を明示。

## Local LLM 未設定時の価値

- turn 分割。
- deterministic 候補抽出。
- keep/drop の一次判定。
- 人間レビューによる昇格判断材料の提供。

## Local LLM 設定後に増える価値

- 候補本文の圧縮品質向上。
- kind 判定の精度向上。
- evidence を保持したまま候補ノイズ低減。

## テスト計画

追加テスト:

- `test/sessionSummary.segmenter.test.ts`
- `test/sessionSummary.evidence.test.ts`
- `test/sessionSummary.candidate.test.ts`
- `test/sessionSummary.engine.test.ts`
- `test/sessionSummary.promotion.test.ts`
- `test/sessionSummary.cli.test.ts`

重点ケース:

1. user 境界で turn 分割が正しい。
2. bootstrap/context が候補生成に混ざらない。
3. コマンド・エラー・検証結果が evidence に残る。
4. keep/drop 判定が基準に一致する。
5. LLM 未設定時に deterministic 候補のみで完了する。
6. LLM parse 失敗時に `llm_failed` で継続する。
7. 同一 hash 再実行で重複行が増えない。
8. `--promote` 時のみ `record_task_note` が呼ばれる。

検証コマンド:

```bash
bun run db:generate
bun run typecheck
bun run --cwd apps/monitor check
bun run verify:fast
```

## 実装順序

1. `session_distillations` / `session_knowledge_candidates` を schema 追加。
2. migration 生成と SQL 確認。
3. `monitor-sessions` を service 再利用可能に分離。
4. `types.ts` / `segmenter.ts` / `evidence.ts` 実装。
5. `candidate.ts` 実装。
6. `repository.ts` 実装。
7. `prompt.ts` / `llm.ts` 実装。
8. `engine.ts` 実装（まず deterministic）。
9. `promotion.ts` 実装。
10. CLI 追加（`distill`, `promote`）。
11. `background/runner` に `session_distillation` タスクを追加し、キュー経由処理へ切替。
12. Monitor command/UI 追加。
13. `verify:fast` 実行。

## 完了条件

- raw transcript を保持したまま、知識候補が別 table に保存される。
- keep/drop 判定と理由が候補ごとに保存される。
- `lesson/rule/procedure` 分類が出力される。
- `--promote` により `record_task_note` へ昇格登録できる。
- Local LLM 未設定でも deterministic 候補抽出が動く。
- LLM 失敗時に処理全体が壊れない。
- `bun run verify:fast` が通る。
