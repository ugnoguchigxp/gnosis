# Session 要約からのナレッジ抽出エンジン実装計画

## 目的

Session 要約エンジンが保存した `session_summaries` / `session_turn_summaries` から、再利用価値のある知識候補を抽出し、人間の承認を経て `record_task_note` に登録できる導線を作る。抽出対象は教訓、追加するべきルール、手続き、リスク、コマンドレシピ、参照情報とする。

## 非目的

- raw transcript から直接ナレッジ抽出しない。入力は要約 table を基本にする。
- 候補を自動で `record_task_note` に登録しない。
- `experience_logs` や graph table を直接更新しない。
- 既存の `recordTaskNote()` の保存責務を複製しない。
- 初期実装では高度な vector 類似検索や graph reasoning を必須にしない。

## 前提

- Session 要約エンジンが先に実装され、turn summary と evidence が保存されている。
- `recordTaskNote()` は承認済みの知識登録 API として使う。
- Local LLM 未設定時も、既存 summary と deterministic evidence を人間が見て候補化できる UI を用意する。
- Local LLM 設定後は、候補抽出と分類を自動生成できる。

## 設計方針

1. ナレッジ候補は別 table に保存し、承認前の draft として扱う。
2. 抽出と登録を分離する。
3. 1 候補には必ず evidence を紐づける。
4. `record_task_note` に渡せる payload を候補 row に保持し、登録時の変換を透明にする。
5. Local LLM は draft 生成に使い、承認判断は UI または明示 CLI に残す。
6. Gemma 系でも壊れにくいように、summary chunk ごとに少数候補だけを返させる。
7. 重複判定は初期実装では deterministic hash と既存候補比較を中心にし、vector 類似は後続拡張にする。

## 抽出するナレッジ種別

| kind | 用途 | 例 |
| --- | --- | --- |
| `lesson` | 失敗・成功から得た教訓 | MCP host が落ちる場合は runtime evidence を先に確認する |
| `rule` | 今後守るべき運用ルール | 要約からの候補は承認なしに登録しない |
| `procedure` | 再実行可能な手順 | Session UI の検証は `bun run --cwd apps/monitor check` を含める |
| `risk` | 見落とすと問題になる注意点 | 要約時に CLI output を削るとノウハウが消える |
| `command_recipe` | コマンドと使いどころ | `bun run verify:fast` で軽量検証する |
| `reference` | 後で参照したい事実 | `vibe_memories` は raw memory を保持する |

## データモデル

### `session_knowledge_extraction_runs`

抽出 run の状態を表す。

| column | type | required | note |
| --- | --- | --- | --- |
| `id` | uuid | yes | primary key |
| `summaryId` | uuid | yes | `session_summaries.id` |
| `summaryHash` | text | yes | 入力 turn summaries から計算 |
| `promptVersion` | text | yes | 例: `session-knowledge-v1` |
| `status` | text | yes | `pending` / `running` / `succeeded` / `failed` |
| `modelProvider` | text | no | `deterministic` / `local-llm` / `openai` / `bedrock` |
| `modelName` | text | no | 実行モデル名 |
| `candidateCount` | integer | yes | default 0 |
| `approvedCount` | integer | yes | default 0 |
| `recordedCount` | integer | yes | default 0 |
| `metadata` | jsonb | yes | `{}` default |
| `error` | text | no | 失敗理由 |
| `createdAt` | timestamp | yes | default now |
| `updatedAt` | timestamp | yes | update 時に更新 |
| `completedAt` | timestamp | no | 成功・失敗時 |

制約:

- unique: `(summaryId, summaryHash, promptVersion)`
- index: `(summaryId, createdAt desc)`
- index: `(status, createdAt desc)`

### `session_knowledge_candidates`

承認前後のナレッジ候補を表す。

| column | type | required | note |
| --- | --- | --- | --- |
| `id` | uuid | yes | primary key |
| `runId` | uuid | yes | `session_knowledge_extraction_runs.id` cascade delete |
| `summaryId` | uuid | yes | `session_summaries.id` |
| `turnSummaryId` | uuid | no | 元 turn。session 横断候補なら null |
| `kind` | text | yes | `lesson` / `rule` / `procedure` / `risk` / `command_recipe` / `reference` |
| `category` | text | no | `workflow` / `testing` / `mcp` など `record_task_note` に合わせる |
| `title` | text | yes | UI 表示用 |
| `content` | text | yes | 登録候補本文 |
| `rationale` | text | no | なぜ候補化したか |
| `evidence` | jsonb | yes | turn summary evidence への参照と短い引用 |
| `files` | jsonb | yes | 関連ファイル path 配列 |
| `tags` | jsonb | yes | tag 配列 |
| `confidence` | real | no | 0-1 |
| `contentHash` | text | yes | kind + normalized content |
| `duplicateOf` | uuid | no | 重複候補 |
| `status` | text | yes | `draft` / `approved` / `rejected` / `recorded` / `failed` |
| `rejectionReason` | text | no | reject 時 |
| `recordTaskNotePayload` | jsonb | no | 登録に使う payload |
| `recordTaskNoteResult` | jsonb | no | 登録結果 |
| `recordTaskNoteEntityId` | text | no | 登録済み entity id |
| `createdAt` | timestamp | yes | default now |
| `updatedAt` | timestamp | yes | update 時に更新 |
| `recordedAt` | timestamp | no | 登録時 |

制約:

- unique: `(runId, contentHash)`
- index: `(summaryId, status)`
- index: `(kind, status)`
- index: `(contentHash)`

## 型定義

追加ファイル:

- `src/services/sessionKnowledge/types.ts`

主要型:

```ts
export type SessionKnowledgeKind =
  | "lesson"
  | "rule"
  | "procedure"
  | "risk"
  | "command_recipe"
  | "reference";

export type SessionKnowledgeCandidateStatus =
  | "draft"
  | "approved"
  | "rejected"
  | "recorded"
  | "failed";

export interface KnowledgeCandidateDraft {
  kind: SessionKnowledgeKind;
  category?: string;
  title: string;
  content: string;
  rationale?: string;
  evidence: KnowledgeEvidenceRef[];
  files: string[];
  tags: string[];
  confidence?: number;
}

export interface KnowledgeEvidenceRef {
  turnIndex?: number;
  turnSummaryId?: string;
  kind: string;
  text: string;
  source?: string;
}
```

## 実装ファイル

### `src/services/sessionKnowledge/prompt.ts`

責務:

- turn summaries からナレッジ候補を抽出する prompt を生成する。
- `promptVersion` を export する。

入力:

- session summary
- turn summaries
- actions/evidence
- 既存候補の title/contentHash

出力 schema:

```json
{
  "candidates": [
    {
      "kind": "lesson|rule|procedure|risk|command_recipe|reference",
      "category": "workflow|testing|mcp|debugging|coding_convention|security|performance|reference",
      "title": "string",
      "content": "string",
      "rationale": "string",
      "evidence": [
        {
          "turnIndex": 0,
          "kind": "verification|error|command_output|decision|file|result",
          "text": "string"
        }
      ],
      "files": ["string"],
      "tags": ["string"],
      "confidence": 0.0
    }
  ]
}
```

prompt 要件:

- Session 固有すぎる進捗報告は候補化しない。
- 再利用できる判断、手順、ルール、失敗回避だけ候補化する。
- 根拠のない一般論を作らない。
- evidence のない候補は返さない。
- 1 chunk あたり最大 5 件。
- 日本語で返す。
- JSON 以外を返さない。

### `src/services/sessionKnowledge/chunker.ts`

責務:

- `session_turn_summaries` を LLM 入力サイズに合わせて chunk 化する。
- 各 chunk は user intent、summary、actions、evidence を含む。
- turn 境界をまたいだ大きな文脈が必要な場合でも、最大 5-8 turn 程度に制限する。

方針:

- CLI output 全文ではなく `evidence` を優先する。
- `command_recipe` 抽出に必要な command と結果は残す。
- `risk` 抽出に必要な error と回避策は残す。

### `src/services/sessionKnowledge/extractor.ts`

責務:

- summary run を作成する。
- chunk ごとに LLM を呼び候補を得る。
- JSON parse 失敗時はその chunk を failed metadata に記録し、他 chunk は継続する。
- deterministic fallback として、明示的な `record_task_note` 言及や `教訓` / `ルール` / `手順` といった user request を候補化できるようにする。

API:

```ts
export async function extractKnowledgeCandidates(input: {
  summaryId: string;
  force?: boolean;
  dryRun?: boolean;
  provider?: "auto" | "deterministic" | "local" | "openai" | "bedrock";
}): Promise<ExtractKnowledgeCandidatesResult>;
```

### `src/services/sessionKnowledge/dedupe.ts`

責務:

- 候補の重複を検出する。
- 初期実装では deterministic に限定する。

ルール:

- `contentHash = sha256(kind + normalized(content))`
- 同一 run 内の重複を除外する。
- 同一 summary 内の既存候補と重複したら `duplicateOf` を設定する。
- `recorded` 済み候補と同一なら draft を作らないか、`duplicateOf` 付きで作る。

後続拡張:

- `search_knowledge` または embedding 類似検索で既存 knowledge との近似重複を検出する。
- ただし初期実装では raw candidate score 依存にしない。

### `src/services/sessionKnowledge/repository.ts`

責務:

- extraction run の作成・更新。
- candidates の保存。
- status transition。
- `recordTaskNotePayload` / result の保存。

API:

```ts
export async function createExtractionRun(input: CreateExtractionRunInput): Promise<ExtractionRunRecord>;
export async function replaceDraftCandidates(runId: string, candidates: KnowledgeCandidateDraft[]): Promise<void>;
export async function listCandidates(input: { summaryId?: string; runId?: string; status?: string }): Promise<KnowledgeCandidateRecord[]>;
export async function approveCandidate(candidateId: string): Promise<KnowledgeCandidateRecord>;
export async function rejectCandidate(candidateId: string, reason: string): Promise<KnowledgeCandidateRecord>;
export async function markCandidateRecorded(candidateId: string, result: RecordTaskNoteResult): Promise<void>;
```

### `src/services/sessionKnowledge/approval.ts`

責務:

- approved candidate を `recordTaskNote()` payload に変換する。
- 明示的な登録操作時だけ `recordTaskNote()` を呼ぶ。
- 成功時は candidate を `recorded` にする。
- 失敗時は candidate を `failed` にし、error を metadata に残す。

payload mapping:

| candidate | `recordTaskNote` |
| --- | --- |
| `kind` | `kind` |
| `category` | `category` |
| `title` | `title` |
| `content` | `content` |
| `tags` | `tags` |
| `files` | `files` |
| `evidence` | `evidence` |
| `confidence` | `confidence` |
| source | `task` |
| metadata | `{ source: "session_knowledge", summaryId, candidateId, runId }` |

注意:

- `failure-firewall` や `golden-path` tag を勝手に付けない。候補内容から明示的に必要な場合だけ使う。
- `recordTaskNote()` の戻り値に `saved: false` がある場合は `failed` として扱う。

## CLI

追加ファイル:

- `src/scripts/session-knowledge.ts`

コマンド:

```bash
bun src/scripts/session-knowledge.ts extract --summary-id <id> --json
bun src/scripts/session-knowledge.ts extract --summary-id <id> --dry-run --json
bun src/scripts/session-knowledge.ts list --summary-id <id> --json
bun src/scripts/session-knowledge.ts approve --candidate-id <id> --json
bun src/scripts/session-knowledge.ts reject --candidate-id <id> --reason "..." --json
bun src/scripts/session-knowledge.ts record --candidate-id <id> --json
```

`package.json` scripts:

```json
{
  "session:knowledge": "bun src/scripts/session-knowledge.ts"
}
```

status transition:

1. `extract` creates `draft`.
2. `approve` changes `draft` to `approved`.
3. `reject` changes `draft` or `approved` to `rejected`.
4. `record` requires `approved`, calls `recordTaskNote()`, then changes to `recorded`.
5. `record` failure changes to `failed`.

## Monitor UI 連携

対象ファイル:

- `apps/monitor/src-tauri/src/monitor/cli.rs`
- `apps/monitor/src-tauri/src/monitor/commands.rs`
- `apps/monitor/src-tauri/src/lib.rs`
- `apps/monitor/src-tauri/permissions/monitor.toml`
- `apps/monitor/src/lib/monitor/types.ts`
- `apps/monitor/src/routes/sessions/+page.svelte`

追加 command:

- `monitor_extract_session_knowledge(summary_id: String, force: bool)`
- `monitor_list_session_knowledge(summary_id: String)`
- `monitor_approve_session_knowledge(candidate_id: String)`
- `monitor_reject_session_knowledge(candidate_id: String, reason: String)`
- `monitor_record_session_knowledge(candidate_id: String)`

UI:

- Session 要約 panel の下に `Knowledge candidates` panel を追加する。
- candidate card には kind、title、content、confidence、evidence、files、status を表示する。
- `承認`、`却下`、`登録` ボタンを分ける。
- `登録` は `approved` の候補だけ有効にする。
- evidence クリックで該当 turn summary にスクロールする。
- raw transcript へのリンクも残す。

## Local LLM 未設定時の価値

- deterministic evidence から人間が候補を判断できる。
- `record_task_note` 用 payload の手動作成 UI として使える。
- 既存 summary を読んで、承認・登録ワークフローだけ先に運用できる。

## Local LLM 設定後に増える価値

- 候補の自動 draft 生成。
- `lesson` / `rule` / `procedure` / `risk` / `command_recipe` の分類。
- evidence 付き payload の自動作成。
- 長い session でも chunk 単位で候補抽出できる。

## OpenAI / Bedrock を使う場合に増える価値

- 長い session summary をまとめて評価しやすい。
- 重複・抽象化・ルール化の品質が上がる。
- 最終的な候補数を少なく絞りやすい。

ただし初期実装では provider を固定しない。`runPromptWithMemoryLoopRouter()` の既存経路を使い、local-first を維持する。

## テスト計画

追加テスト:

- `test/sessionKnowledge.prompt.test.ts`
- `test/sessionKnowledge.chunker.test.ts`
- `test/sessionKnowledge.extractor.test.ts`
- `test/sessionKnowledge.dedupe.test.ts`
- `test/sessionKnowledge.approval.test.ts`
- `test/sessionKnowledge.cli.test.ts`

重点ケース:

1. evidence のない候補を保存しない。
2. 進捗報告だけの turn から候補を作らない。
3. コマンドと検証結果を `command_recipe` として候補化できる。
4. 「今後守るべき」内容を `rule` として候補化できる。
5. 同一 contentHash の候補が重複保存されない。
6. `approve` / `reject` / `record` の status transition が正しい。
7. `record` は `approved` 以外では失敗する。
8. `recordTaskNote()` の失敗が candidate に保存される。
9. LLM parse 失敗時に run が failed または partial failed として残り、summary は壊れない。

検証コマンド:

```bash
bun run db:generate
bun run typecheck
bun run --cwd apps/monitor check
bun run verify:fast
```

## 実装順序

1. 要約エンジンの table と CLI を先に実装し、1 session の summary を保存できる状態にする。
2. `session_knowledge_extraction_runs` / `session_knowledge_candidates` を `src/db/schema.ts` に追加する。
3. `bun run db:generate` で migration を生成し、SQL を確認する。
4. `src/services/sessionKnowledge/types.ts` を追加する。
5. `chunker.ts` を実装し、turn summary chunk の unit test を通す。
6. `prompt.ts` を実装し、schema と制約を test する。
7. `dedupe.ts` を実装する。
8. `repository.ts` を実装する。
9. `extractor.ts` を deterministic provider で実装し、LLM なし dry-run を通す。
10. `extractor.ts` に `runPromptWithMemoryLoopRouter()` 呼び出しを追加する。
11. `approval.ts` を実装し、`recordTaskNote()` を mock した test を通す。
12. `src/scripts/session-knowledge.ts` を追加する。
13. Monitor Tauri command を追加する。
14. Sessions UI に Knowledge candidates panel を追加する。
15. Local LLM なしで `verify:fast` を通す。
16. Local LLM ありで 1 summary から候補抽出し、承認前で止まることを確認する。
17. 1 candidate を明示的に `record` し、`record_task_note` の戻り値が保存されることを確認する。

## 完了条件

- 要約 table からナレッジ候補を抽出できる。
- 候補は evidence 付きで保存される。
- 候補は承認なしに登録されない。
- CLI と UI の両方から候補の一覧、承認、却下、登録ができる。
- `record_task_note` への payload と結果が candidate row から追跡できる。
- Local LLM 未設定でも approval workflow が使える。
- Local LLM 失敗時も summary と既存候補が壊れない。
- `bun run verify:fast` が通る。
