# Session 要約エンジン実装計画

## 目的

Session の対話ログを「ユーザー発言から次のユーザー発言直前まで」の単位に分割し、後続のナレッジ抽出で使える要約を永続化する。要約は raw transcript を置き換えず、会話の流れ、判断、実行コマンド、エラー、検証結果、変更ファイルを失わない圧縮ビューとして扱う。

## 非目的

- `record_task_note` への登録は行わない。
- `entities` / `relations` への graph 反映は行わない。
- `experience_logs` へ成功・失敗知識として登録しない。
- UI で raw transcript を削除・改変しない。
- 既存の `synthesizeKnowledge()` を無理に置き換えない。まず Session 要約専用の経路を追加する。

## 現状整理

- Session UI は `src/scripts/monitor-sessions.ts` を経由して `vibe_memories` と Codex JSONL を読み、`SessionSummary` / `SessionDetail` を返している。
- `vibe_memories` は raw chunk を保持しており、現行 schema では `memoryType` が `raw` に限定されている。
- `src/services/llm.ts` には `distillKnowledgeFromTranscript()` があるが、これは transcript から entity/relation を抽出する旧来の graph 合成寄りの処理であり、Session 単位の要約保存には責務が広すぎる。
- `src/services/synthesis.ts` は未合成の raw memory をまとめて graph に反映する処理で、ユーザー発言単位の会話要約ではない。
- `recordTaskNote()` は承認済み知識の登録面として使えるが、要約段階では呼び出さない。

## 設計方針

1. raw transcript は唯一の一次情報として残す。
2. 要約は別 table に保存し、再生成可能な派生データとして扱う。
3. 1 turn は「ユーザー発言を起点に、次のユーザー発言直前まで」とする。
4. CLI 実行結果やノウハウは本文から削らず、`evidence` と `actions` に構造化して残す。
5. Local LLM 未設定時は deterministic な turn 分割と evidence 抽出だけでも価値が出る状態にする。
6. Local LLM 設定後は turn summary と session summary が追加される。
7. LLM 出力は小さな JSON schema に限定し、Gemma 系でも壊れにくい単位で呼ぶ。
8. 要約は `sessionKey + transcriptHash + promptVersion` で idempotent に保存する。

## データモデル

`src/db/schema.ts` に以下を追加する。migration は `bun run db:generate` で生成し、生成 SQL を確認して必要なら手直しする。

### `session_summaries`

Session 全体の要約ジョブと結果を表す。

| column | type | required | note |
| --- | --- | --- | --- |
| `id` | uuid | yes | primary key |
| `sessionKey` | text | yes | UI 上の session id。Codex JSONL path や `vibe_memories.session_id` を正規化した値 |
| `source` | text | yes | `codex_jsonl` / `vibe_memory` / `antigravity` / `mixed` |
| `sourceId` | text | no | 元データ側の id |
| `sessionFile` | text | no | JSONL path |
| `memorySessionId` | text | no | `vibe_memories.session_id` |
| `transcriptHash` | text | yes | 対象 message 列から計算 |
| `promptVersion` | text | yes | 例: `session-summary-v1` |
| `status` | text | yes | `pending` / `running` / `succeeded` / `failed` / `stale` |
| `modelProvider` | text | no | `deterministic` / `local-llm` / `openai` / `bedrock` |
| `modelName` | text | no | 実行モデル名 |
| `summary` | text | no | Session 全体の短い要約 |
| `turnCount` | integer | yes | 分割された turn 数 |
| `messageCount` | integer | yes | 入力 message 数 |
| `metadata` | jsonb | yes | `{}` default |
| `error` | text | no | 失敗時の短い理由 |
| `createdAt` | timestamp | yes | default now |
| `updatedAt` | timestamp | yes | update 時に更新 |
| `completedAt` | timestamp | no | 成功・失敗時 |

制約:

- unique: `(sessionKey, transcriptHash, promptVersion)`
- index: `(sessionKey, createdAt desc)`
- index: `(status, createdAt desc)`

### `session_turn_summaries`

ユーザー発言単位の要約結果を表す。

| column | type | required | note |
| --- | --- | --- | --- |
| `id` | uuid | yes | primary key |
| `summaryId` | uuid | yes | `session_summaries.id` cascade delete |
| `turnIndex` | integer | yes | 0-based |
| `userMessageId` | text | no | 元 message id |
| `startedAt` | timestamp | no | turn 内最初の時刻 |
| `endedAt` | timestamp | no | turn 内最後の時刻 |
| `userIntent` | text | yes | ユーザー依頼・質問の要約 |
| `summary` | text | yes | AI の作業・結論まで含む要約 |
| `actions` | jsonb | yes | コマンド、ツール、変更ファイルなど |
| `evidence` | jsonb | yes | エラー、検証結果、重要ログ、ファイル参照 |
| `status` | text | yes | `deterministic` / `llm_succeeded` / `llm_failed` |
| `metadata` | jsonb | yes | token 推定、入力 hash など |
| `createdAt` | timestamp | yes | default now |
| `updatedAt` | timestamp | yes | update 時に更新 |

制約:

- unique: `(summaryId, turnIndex)`
- index: `(summaryId, turnIndex)`
- index: `(userMessageId)`

## 型定義

追加ファイル:

- `src/services/sessionSummary/types.ts`

主要型:

```ts
export type SessionSummaryStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "stale";

export type SessionTurnSummaryStatus =
  | "deterministic"
  | "llm_succeeded"
  | "llm_failed";

export interface SessionMessageInput {
  id?: string;
  role: "user" | "assistant" | "system" | "tool" | "log";
  content: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionTurnBlock {
  turnIndex: number;
  userMessageId?: string;
  userContent: string;
  messages: SessionMessageInput[];
  startedAt?: string;
  endedAt?: string;
  deterministicIntent: string;
  deterministicEvidence: SessionEvidence[];
  deterministicActions: SessionAction[];
}

export interface SessionAction {
  kind: "command" | "tool" | "file_change" | "test" | "navigation";
  label: string;
  detail?: string;
  status?: "unknown" | "succeeded" | "failed";
  metadata?: Record<string, unknown>;
}

export interface SessionEvidence {
  kind: "command_output" | "error" | "verification" | "file" | "decision" | "result";
  text: string;
  sourceMessageId?: string;
  metadata?: Record<string, unknown>;
}

export interface GeneratedTurnSummary {
  userIntent: string;
  summary: string;
  actions: SessionAction[];
  evidence: SessionEvidence[];
}
```

## 実装ファイル

### `src/services/sessionSummary/segmenter.ts`

責務:

- `SessionMessageInput[]` を `SessionTurnBlock[]` に分割する。
- `# AGENTS.md instructions for ...`、`<environment_context>`、長い system/bootstrap 文を要約入力から除外する。
- 除外した context は raw transcript には残し、turn summary には入れない。
- session 冒頭に user 以外の message がある場合は `preamble` として保持するが、基本的には最初の user turn に混ぜない。

分割ルール:

1. 時系列昇順に並べる。
2. `role === "user"` で新しい turn を開始する。
3. 次の user message までの assistant/tool/log を同じ turn に含める。
4. user message が存在しない session は `turnIndex=0` の system/log-only block として扱い、UI では要約不可または deterministic のみとする。

テスト観点:

- 最新順で渡されても昇順に正規化される。
- 複数 user turn が正しく分割される。
- AGENTS/environment context が入力 summary text に混ざらない。
- CLI output や file path を含む assistant message は残る。

### `src/services/sessionSummary/evidence.ts`

責務:

- LLM に渡す前に deterministic に重要断片を抽出する。
- LLM 失敗時も最低限の価値として保存する。

抽出対象:

- 実行コマンド: `bun run ...`, `npm ...`, `pnpm ...`, `git ...`, `rg ...`, `drizzle-kit ...`
- テスト結果: `pass`, `fail`, `verify passed`, `0 fail`, `svelte-check`, `typecheck`
- エラー: `Error:`, `failed`, `MCP_HOST_ERROR`, stack trace の先頭
- ファイルパス: `src/...`, `apps/...`, `docs/...`, 絶対 path
- ツール呼び出し: `agentic_search`, `review_task`, `record_task_note`
- 意思決定: 「別 table」「自動登録しない」「承認後に登録」などの assistant 最終結論

過剰な正規表現で意味判断しない。抽出は evidence の候補化に留め、意味の確定は要約またはナレッジ抽出で行う。

### `src/services/sessionSummary/prompt.ts`

責務:

- turn block を小さな JSON 出力に変換する prompt を生成する。
- `promptVersion` を export する。

入力:

- user message
- assistant/tool/log message の短縮版
- deterministic evidence/actions

出力 schema:

```json
{
  "userIntent": "string",
  "summary": "string",
  "actions": [
    {
      "kind": "command|tool|file_change|test|navigation",
      "label": "string",
      "detail": "string",
      "status": "unknown|succeeded|failed"
    }
  ],
  "evidence": [
    {
      "kind": "command_output|error|verification|file|decision|result",
      "text": "string"
    }
  ]
}
```

prompt 要件:

- 日本語で要約する。
- CLI の手順、コマンド、エラー、検証結果を削らない。
- 不明なことを補完しない。
- 最大 1 turn あたり `actions` 10 件、`evidence` 12 件程度に制限する。
- JSON 以外を返さない。

### `src/services/sessionSummary/llm.ts`

責務:

- `runPromptWithMemoryLoopRouter()` 経由で local/cloud LLM を呼ぶ。
- `taskKind: "distillation"` を使う。
- Local LLM 未設定時は deterministic result を返す。
- JSON parse に失敗した場合は deterministic result に fallback し、turn status を `llm_failed` にする。

推奨設定:

- `llmTimeoutMs: 180_000`
- `maxTokens: 900`
- 1 call 1 turn を基本にする。
- 長い turn は message 単位で切り詰め、deterministic evidence を優先して残す。

### `src/services/sessionSummary/repository.ts`

責務:

- `session_summaries` の upsert。
- `session_turn_summaries` の delete-and-insert または idempotent upsert。
- transcript hash の既存 summary 検索。
- status 更新。

API:

```ts
export async function findLatestSessionSummary(sessionKey: string): Promise<SessionSummaryRecord | null>;
export async function createRunningSessionSummary(input: CreateSessionSummaryInput): Promise<SessionSummaryRecord>;
export async function replaceTurnSummaries(summaryId: string, turns: PersistedTurnSummary[]): Promise<void>;
export async function markSessionSummarySucceeded(summaryId: string, input: CompleteSummaryInput): Promise<void>;
export async function markSessionSummaryFailed(summaryId: string, error: string): Promise<void>;
```

### `src/services/sessionSummary/engine.ts`

責務:

- Session detail の取得。
- transcript hash 計算。
- 既存 summary の再利用判定。
- turn 分割。
- deterministic evidence/actions 抽出。
- LLM 要約。
- DB 永続化。

API:

```ts
export async function summarizeSession(input: {
  sessionId: string;
  force?: boolean;
  dryRun?: boolean;
  provider?: "auto" | "deterministic" | "local" | "openai" | "bedrock";
}): Promise<SummarizeSessionResult>;
```

処理順:

1. `monitor-sessions` の session detail 取得ロジックを service から呼べる形にする。
2. message を昇順に正規化する。
3. context-only message を除外する。
4. transcript hash を計算する。
5. 既存の `succeeded` summary があり `force` なしなら返す。
6. `session_summaries.status = running` を作成する。
7. turn ごとに deterministic summary を作る。
8. provider が `deterministic` または local LLM 不可なら deterministic で保存する。
9. LLM 可能なら turn ごとに生成し、失敗 turn は deterministic に fallback する。
10. session 全体 summary を turn summaries から deterministic に組み立てる。余裕があれば最後に LLM で短縮する。
11. turn summaries を保存する。
12. parent summary を `succeeded` または `failed` に更新する。

## `monitor-sessions` のリファクタ

`src/scripts/monitor-sessions.ts` は CLI としてだけでなく service から再利用する。

変更:

- `listSessions(options)` を export。
- `getSessionDetail(sessionId, options)` を export。
- CLI entrypoint は末尾で `if (isMain(import.meta.url)) main()` 相当に分離する。
- `SessionMessage` 型は `src/services/sessionLogs/types.ts` または既存 `monitor/types.ts` と重複しない場所へ寄せる。

注意:

- 既存 UI の contract を壊さない。
- Antigravity/Codex JSONL の parser は要約 engine からも同じものを使う。

## CLI

追加ファイル:

- `src/scripts/session-summary.ts`

コマンド:

```bash
bun src/scripts/session-summary.ts summarize --session-id <id> --json
bun src/scripts/session-summary.ts summarize --session-id <id> --force --json
bun src/scripts/session-summary.ts summarize --session-id <id> --dry-run --json
bun src/scripts/session-summary.ts list --json
bun src/scripts/session-summary.ts show --summary-id <id> --json
bun src/scripts/session-summary.ts status --session-id <id> --json
```

`package.json` scripts:

```json
{
  "session:summary": "bun src/scripts/session-summary.ts"
}
```

CLI 出力:

- 成功時は `summaryId`, `sessionKey`, `status`, `turnCount`, `messageCount`, `modelProvider`, `modelName` を返す。
- 失敗時も JSON で `status: "failed"` と `error` を返す。
- `--dry-run` は DB に保存せず、turn 分割と deterministic evidence を返す。

## Monitor UI 連携

対象ファイル:

- `apps/monitor/src-tauri/src/monitor/cli.rs`
- `apps/monitor/src-tauri/src/monitor/commands.rs`
- `apps/monitor/src-tauri/src/lib.rs`
- `apps/monitor/src-tauri/permissions/monitor.toml`
- `apps/monitor/src/lib/monitor/types.ts`
- `apps/monitor/src/routes/sessions/+page.svelte`

追加 command:

- `monitor_session_summary(session_id: String)`
- `monitor_summarize_session(session_id: String, force: bool)`

UI:

- Session detail の右上に `要約` ボタンを追加する。
- 既存 summary がある場合は要約本文と turn summaries を表示する。
- 未生成なら「要約未生成」と表示し、ボタンで生成できる。
- deterministic only の場合は「LLM 未使用」と明示する。
- LLM 失敗 turn は raw transcript へ戻れるようにする。

## Local LLM 未設定時の価値

- turn 分割ができる。
- ユーザー依頼単位で会話を追える。
- コマンド、検証結果、エラー、変更ファイルの evidence を一覧化できる。
- 後続のナレッジ抽出 UI で、人間が候補化する材料として使える。

## Local LLM 設定後に増える価値

- turn ごとの自然言語要約が追加される。
- ユーザー意図と AI の最終結論が短く確認できる。
- 長い CLI output を evidence として残しつつ、重要箇所だけ読める。
- ナレッジ抽出 engine の入力 token を削減できる。

## テスト計画

追加テスト:

- `test/sessionSummary.segmenter.test.ts`
- `test/sessionSummary.evidence.test.ts`
- `test/sessionSummary.engine.test.ts`
- `test/sessionSummary.cli.test.ts`

重点ケース:

1. user -> assistant -> user の境界で 2 turn になる。
2. 最新順 message が昇順に正規化される。
3. AGENTS/environment context が要約対象から除外される。
4. CLI コマンド、失敗ログ、検証成功ログが evidence に残る。
5. LLM 未設定時に deterministic summary が保存される。
6. LLM JSON parse 失敗時に turn status が `llm_failed` になり、処理全体は継続する。
7. 同一 transcript hash の再実行で重複 row が増えない。
8. `--force` で再生成される。

検証コマンド:

```bash
bun run db:generate
bun run typecheck
bun run --cwd apps/monitor check
bun run verify:fast
```

## 実装順序

1. `session_summaries` / `session_turn_summaries` を `src/db/schema.ts` に追加する。
2. `bun run db:generate` で migration を生成し、SQL を確認する。
3. `monitor-sessions` の list/detail parser を export 可能に分離する。
4. `src/services/sessionSummary/types.ts` を追加する。
5. `segmenter.ts` を実装し、unit test を通す。
6. `evidence.ts` を実装し、unit test を通す。
7. `repository.ts` を実装する。
8. `prompt.ts` と `llm.ts` を実装する。
9. `engine.ts` を実装し、LLM なし dry-run を先に通す。
10. `src/scripts/session-summary.ts` を追加し、`--dry-run` / `summarize` / `show` を動かす。
11. Monitor Tauri command を追加する。
12. Sessions UI に要約 panel と生成ボタンを追加する。
13. Local LLM なしの `verify:fast` を通す。
14. Local LLM ありで 1 session を手動実行し、turn summary の品質を確認する。

## 完了条件

- raw transcript を保持したまま、別 table に要約が保存される。
- Session UI から要約を生成・閲覧できる。
- Local LLM 未設定でも turn 分割と evidence 抽出が動く。
- Local LLM 失敗時に処理全体が壊れず、失敗理由が保存される。
- CLI の重要手順・エラー・検証結果が summary から追跡できる。
- `bun run verify:fast` が通る。
