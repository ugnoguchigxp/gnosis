# Agentic Search と Memory Loop への集約計画

最終更新: 2026-04-30

## 目的

Gnosis の MCP 導線を、`activate_project` / `start_task` / `finish_task` の lifecycle 儀式から、実際に再利用可能な知識を取得・保存・蒸留する導線へ移行する。

新しい中心機能は `agentic_search` とする。`agentic_search` はユーザー依頼をタスク文脈として解釈し、構造化ナレッジと raw 会話記憶から必要なものだけを返す。`search_knowledge` は低レベル検索として残し、語句・ベクトル・metadata で近い候補を確認するデバッグ/検証用ツールに位置づける。

## 背景

現状の Agent-First tool surface は、作業開始時に `initial_instructions`、`activate_project`、`start_task`、作業終了時に `finish_task` を呼ぶ流れを推奨している。しかし、実装上の `start_task` は `title` / `intent` / `files` / `projectRoot` を `task_trace` として保存し、Hook event を発火するだけである。ユーザー依頼を要約して検索クエリ化したり、関連ナレッジを取得したりはしていない。

一方で、Gnosis には以下の再利用可能な基盤がすでにある。

- `vibe_memories`: raw な会話・ログ・レビュー finding を保存する非構造化記憶
- `entities`: rule / lesson / procedure / decision / risk などの構造化ナレッジ
- `synthesisTask`: 未処理の `vibe_memories` を LLM で蒸留して `entities` / `relations` に昇格する background task
- `search_knowledge`: `entities` に対する語句・ベクトル・applicability 検索
- `review_task`: レビュー時に project knowledge を注入できる実行導線

不足しているのは、Codex 会話ログを `vibe_memories` に入れる入口と、検索結果を Gemma4 が「今回使う / 使わない」に判定して圧縮する agentic retrieval gate である。

## 採用方針

1. `activate_project` / `start_task` / `finish_task` は primary MCP surface から削除する。
2. `initial_instructions` は起動儀式ではなく、最小限の利用方針を返す軽量ガイドに変更する。
3. 通常の知識取得入口は `agentic_search` に集約する。
4. `search_knowledge` は raw 候補確認用の低レベル検索として残す。
5. `review_task` は内部で `agentic_search` を使い、レビュー文脈に必要な知識だけを注入する。
6. Codex JSONL セッションを `vibe_memories` へ同期対象として追加する。
7. scheduled LLM / background worker が `vibe_memories` を蒸留し、再利用可能な `entities` に昇格する。
8. タスク開始・終了というイベントではなく、次回の実装・レビューに使える知識が増えたかを成功指標にする。

## 新しい公開ツール面

Primary tools:

| Tool | 役割 |
| :--- | :--- |
| `initial_instructions` | Gnosis の最小利用方針を返す。通常は `agentic_search` と `review_task` を案内するだけにする。 |
| `agentic_search` | ユーザー依頼を解釈し、`entities` / `vibe_memories` から必要な知識だけを返す。 |
| `search_knowledge` | 低レベル検索。語句・ベクトル・metadata で近い候補を確認する。LLM 判定はしない。 |
| `record_task_note` | ユーザーまたはエージェントが明示的に再利用可能な知見を保存する。 |
| `review_task` | コード/ドキュメントレビュー。内部で `agentic_search` を使う。 |
| `doctor` | DB、MCP tool visibility、automation、background worker、metadata drift を診断する。 |

削除または非公開化する tools:

| Tool | 方針 | 理由 |
| :--- | :--- | :--- |
| `activate_project` | 削除 | project activation 状態は実質使われていない。診断は `doctor`、知識取得は `agentic_search` に寄せる。 |
| `start_task` | 削除 | 現状は低情報量の `task_trace` 保存のみ。ユーザー依頼の要約・検索に使われていない。 |
| `finish_task` | 削除 | `learnedItems` がない完了ログは再利用価値が低い。知見保存は `record_task_note` と蒸留に寄せる。 |

## `initial_instructions` の再定義

現状の `initial_instructions` は `activate_project` を first call として案内している。新設計では、first call を強制しない。

返却内容は以下に絞る。

```json
{
  "defaultKnowledgeTool": "agentic_search",
  "rawSearchTool": "search_knowledge",
  "reviewTool": "review_task",
  "saveKnowledgeTool": "record_task_note",
  "rules": [
    "Use agentic_search before non-trivial implementation or review when project memory can affect the result.",
    "Use search_knowledge only when inspecting raw lexical/vector candidates.",
    "Use record_task_note only for reusable rules, lessons, decisions, risks, procedures, or command recipes.",
    "Use doctor for runtime and tool visibility diagnostics."
  ]
}
```

必要な制約:

- `initial_instructions` はセッション開始時に呼ばれてもよいが、重い DB summary は返さない。
- レビュー開始時の再実行は不要にする。レビューの知識注入は `review_task` が内部で行う。
- AGENTS.md / README / docs から `activate_project` first-call 前提を削除する。

## `agentic_search` の仕様

### 入力

```typescript
type AgenticSearchInput = {
  userRequest: string;
  repoPath?: string;
  files?: string[];
  changeTypes?: TaskChangeType[];
  technologies?: string[];
  intent?: 'plan' | 'edit' | 'debug' | 'review' | 'finish';
  includeRawMemory?: boolean;
  maxCandidates?: number;
  maxReturned?: number;
  localLlm?: {
    enabled?: boolean;
    required?: boolean;
    timeoutMs?: number;
  };
};
```

### 内部処理

1. `userRequest` から task summary を作る。
2. `files` / `changeTypes` / `technologies` が未指定なら、ユーザー依頼と repo path から推定する。
3. `entities` から広めに候補を取得する。
4. `includeRawMemory=true` または `entities` の信頼度が低い場合、`vibe_memories` から raw 候補も取得する。
5. Gemma4 が候補を `use` / `skip` / `maybe` に分類する。Gemma4 が失敗した場合は bonsai までの local fallback に留め、cloud fallback は使わない。
6. `use` と高信頼 `maybe` だけを短く要約して返す。
7. 使用した候補の reference count / last referenced を更新する。

### 出力

```typescript
type AgenticSearchResult = {
  taskSummary: string;
  decision: 'use_knowledge' | 'no_relevant_knowledge' | 'needs_clarification' | 'degraded';
  confidence: number;
  usedKnowledge: Array<{
    id: string;
    source: 'entity' | 'vibe_memory';
    kind?: string;
    category?: string;
    title: string;
    summary: string;
    reason: string;
    evidence?: Array<{ type?: string; uri?: string; value?: string }>;
  }>;
  skippedCount: number;
  maybeCount: number;
  gaps: string[];
  diagnostics: {
    entityCandidates: number;
    rawMemoryCandidates: number;
    localLlmUsed: boolean;
    degradedReasons: string[];
  };
  nextAction: 'proceed_with_context' | 'proceed_without_context' | 'refine_request' | 'retry_later';
};
```

### ローカル LLM gate

Gemma4 は検索後の filter/rerank/summarize に限定する。最初から全 memory を読ませない。

判定プロンプトは以下の契約にする。

- 入力: task summary、候補リスト、各候補の snippet / metadata / match reason
- 出力: strict JSON
- 各候補: `decision`, `confidence`, `reason`, `taskRelevantSummary`
- 失敗時: deterministic score fallback に戻す

`localLlm.required=true` の場合だけ、LLM 判定失敗を `degraded` ではなく error として扱う。

## `search_knowledge` の位置づけ

`search_knowledge` は残す。ただし、通常エージェントが最初に使うツールではなく、以下の用途に限定する。

- raw 候補を確認したい
- lexical / vector / metadata のスコアを見たい
- `agentic_search` が返さなかった候補をデバッグしたい
- filter / category / kind の動作確認をしたい

変更点:

- description で「通常は `agentic_search` を使う」と明記する。
- LLM filter は入れない。
- `task_trace` は検索対象から除外する。
- `includeContent=full` は明示指定時だけ許可する。

## Codex 会話ログ取り込み

### 取り込み対象

Codex はローカルに JSONL セッションを保持している。

- `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
- `~/.codex/session_index.jsonl`
- `~/.codex/archived_sessions/*.jsonl`

Gnosis は現在 `Claude Code` と `Antigravity` だけを同期しているため、`Codex` を第三の source として追加する。

### 追加する関数

対象ファイル:

- `src/services/ingest.ts`
- `src/services/sync.ts`
- `test/ingest.test.ts`

追加 API:

```typescript
export async function ingestCodexLogs(
  since?: Date,
  cursor: IngestCursor = {},
): Promise<IngestResult>
```

同期 source:

```typescript
{ id: 'codex_logs', label: 'Codex', ingest: ingestCodexLogs }
```

### 抽出ルール

Codex JSONL の `payload.type` を見て抽出する。

| payload.type | 取り扱い |
| :--- | :--- |
| `session_meta` | session id、cwd、thread id、timestamp を metadata に使う。本文 memory にはしない。 |
| `turn_context` | cwd / files / branch / environment が取れる場合 metadata に使う。 |
| `response_item` | user / assistant の自然文だけを抽出する。tool call / tool result は原則本文にしない。 |
| `event_msg` | 通常はスキップ。必要なら短い作業状態として metadata に保持する。 |

本文化する内容:

- ユーザー依頼
- assistant の実装方針、結論、レビュー finding、最終報告
- 失敗・成功・検証結果として再利用できる短い説明

本文化しない内容:

- 長い tool output
- shell command の全出力
- 巨大 diff
- secret-like な文字列
- 既存 secret filter が除外する内容

metadata:

```json
{
  "source": "Codex",
  "sourceId": "codex_logs",
  "sessionFile": "...",
  "sessionId": "...",
  "cwd": "...",
  "timestamp": "...",
  "role": "user|assistant",
  "kind": "codex_conversation",
  "dedupeKey": "..."
}
```

dedupe key は `sourceId + sessionFile + lineNumber + role + contentHash` を基本にする。既存の cursor offset と併用し、再取り込みで重複保存しない。

## Vibe Memory から Knowledge への蒸留

現行の `synthesizeKnowledge` は未処理 raw memory をまとめて LLM に渡している。Codex 取り込み後は量が増えるため、蒸留方針を明確化する。

対象ファイル:

- `src/services/synthesis.ts`
- `src/services/background/tasks/synthesisTask.ts`
- `src/services/background/runner.ts`
- `src/scripts/reflect.ts`
- `test/synthesis.test.ts`

改善点:

1. session / cwd / source ごとに batch を分ける。
2. Codex由来 memory は `cwd` 単位でまとめる。
3. LLM 出力は `rule`, `lesson`, `decision`, `procedure`, `risk`, `command_recipe` を優先する。
4. 単なる会話要約は `entities` に昇格しない。
5. 同じ意味の entity は dedupe / merge する。
6. 蒸留後の `vibe_memories.isSynthesized` 更新は、entity 保存成功後に行う。
7. 失敗した batch は `isSynthesized=false` のまま残し、次回 retry できるようにする。

蒸留対象として価値があるもの:

- ユーザーが明示した運用ルール
- 繰り返し発生した失敗と回避策
- 成功したコマンド手順
- repo 固有の設計判断
- review で実際に使われた観点
- tool / MCP / automation の実運用上の制約

蒸留対象から除外するもの:

- その場限りの進捗報告
- コマンド出力の羅列
- ファイル一覧だけの情報
- 一般的すぎる助言
- project 外の雑談

## Review との統合

`review_task` は現在も knowledge-aware review の中心機能として残す。ただし、知識取得を `search_knowledge` 直呼びではなく `agentic_search` に寄せる。

対象ファイル:

- `src/mcp/tools/agentFirst.ts`
- `src/services/review/orchestrator.ts`
- `src/services/review/types.ts`
- `test/mcp/tools/agentFirst.test.ts`
- `test/review-foundation.test.ts`

変更点:

1. `review_task` は `goal`, `target.filePaths`, `target.diff`, `repoPath` から `agentic_search` を呼ぶ。
2. `knowledgePolicy=required` は `agentic_search` の infra failure と no relevant knowledge を区別する。
3. `knowledgeUsed` は LLM gate 後に実際に採用された知識だけにする。
4. skipped candidates は count だけ返し、本文は返さない。
5. suggested notes は `record_task_note` ではなく、通常は `vibe_memories` 蒸留ループに委ねる。ユーザーが明示した場合のみ `record_task_note` を使う。

## Tool 削除計画

### Phase 1: 追加と並走

対象ファイル:

- `src/services/agentFirst.ts`
- `src/mcp/tools/agentFirst.ts`
- `src/mcp/tools/index.ts`
- `docs/mcp-tools.md`
- `test/mcp/tools/agentFirst.test.ts`
- `test/agentFirstSearch.test.ts`

作業:

1. `agentic_search` service と MCP tool を追加する。
2. `initial_instructions` を軽量返却に変更する。
3. `search_knowledge` description を raw search 用に変更する。
4. `activate_project` / `start_task` / `finish_task` は deprecated として残すが、`initial_instructions` と docs から推奨を外す。
5. `task_trace` を `search_knowledge` の検索対象から除外する。

受け入れ条件:

- `initial_instructions` が `activate_project` を first call として返さない。
- `agentic_search` が `userRequest` だけで動く。
- local LLM が使えない場合も deterministic fallback で返る。
- `search_knowledge` は LLM 判定なしの候補確認として動く。

### Phase 2: Codex 取り込み

対象ファイル:

- `src/services/ingest.ts`
- `src/services/sync.ts`
- `test/ingest.test.ts`
- `docs/configuration.md`
- `docs/daemon.md`

作業:

1. `ingestCodexLogs` を追加する。
2. `syncAllAgentLogs` に `codex_logs` source を追加する。
3. cursor / offset / mtime の差分同期を Claude / Antigravity と同じ契約で実装する。
4. Codex JSONL parser の単体テストを追加する。
5. sync script / LaunchAgent の docs に Codex source を追加する。

受け入れ条件:

- 新しい Codex JSONL から user / assistant の自然文だけを抽出できる。
- tool output や巨大 diff を本文保存しない。
- dedupe key により再実行で重複保存しない。
- `syncAllAgentLogs` の summary に Codex source が含まれる。

### Phase 3: 蒸留品質の強化

対象ファイル:

- `src/services/synthesis.ts`
- `src/services/llm.ts`
- `src/domain/schemas.ts`
- `src/services/graph.ts`
- `test/synthesis.test.ts`
- `test/llmService.test.ts`

作業:

1. Codex / Claude / Antigravity の source metadata を蒸留プロンプトに渡す。
2. LLM 出力 schema に `kind`, `category`, `purpose`, `applicability`, `evidence` を明示する。
3. low-value summary を entity 昇格しない filter を追加する。
4. entity 保存時に provenance と source memory ids を metadata に残す。
5. 同義 entity の dedupe / merge のテストを追加する。

受け入れ条件:

- raw 会話から `rule` / `lesson` / `decision` / `procedure` / `risk` が抽出される。
- 雑な会話要約が `reference` entity として大量生成されない。
- source memory と entity の関係が追跡できる。
- 失敗 batch が再実行可能な状態で残る。

### Phase 4: lifecycle tools の削除

対象ファイル:

- `src/services/agentFirst.ts`
- `src/mcp/tools/agentFirst.ts`
- `src/mcp/tools/index.ts`
- `docs/mcp-tools.md`
- `docs/hooks-guide.md`
- `docs/active-use-improvement-plan.md`
- `docs/agent-first-gnosis-refactoring-plan.md`
- `test/mcp/tools/agentFirst.test.ts`
- `test/agentFirstSearch.test.ts`

作業:

1. `activate_project`, `start_task`, `finish_task` を public MCP tool から削除する。
2. 関連 schema / handler / service を削除する。
3. `REQUIRED_PRIMARY_TOOLS` を新 surface に更新する。
4. Hook docs から `task.started` / `task.completed` を primary workflow として説明する箇所を削除または内部イベント扱いへ変更する。
5. `task_trace` entity の新規作成を停止する。
6. 既存 `task_trace` は migration で削除するか、deprecated archival data として検索対象外に固定する。

受け入れ条件:

- MCP tool list に lifecycle tools が出ない。
- `initial_instructions` / `agentic_search` / `search_knowledge` / `record_task_note` / `review_task` / `doctor` が primary tool として揃う。
- docs に `activate_project` first-call や `start_task before edits` が残らない。
- review flow は `initial_instructions` 再実行なしで `review_task` 単体から knowledge-aware に動く。

### Phase 5: 評価と運用監視

対象ファイル:

- `src/scripts/monitor-snapshot.ts`
- `apps/monitor/src/routes/+page.svelte`
- `scripts/doctor.ts`
- `scripts/observe-worker.ts`
- `test/runner.test.ts`

作業:

1. Monitor / doctor に以下の指標を追加する。
   - pending raw `vibe_memories`
   - synthesized count
   - Codex source last sync
   - synthesis last success / failure
   - agentic search local LLM fallback count
   - no relevant knowledge rate
2. background worker の `synthesis` task が定期実行されることを確認する。
3. `doctor` は lifecycle tool missing を warning にしない。

受け入れ条件:

- `bun run doctor` が Codex sync と synthesis loop の状態を説明する。
- `bun run monitor:snapshot` が raw memory / synthesized memory / source別 last sync を返す。
- `observe:worker` で synthesis の last success / failure が確認できる。

## データ移行

### 既存 `task_trace`

既存 `entities.type = 'task_trace'` は原則として再利用ナレッジではないため、検索対象から除外する。

選択肢:

1. 物理削除する。
2. `metadata.status = 'deprecated'` を付与する。
3. `scope = 'archived'` として検索対象外にする。

推奨は 1。ユーザーの方針は unused legacy surface を残さないことなので、Phase 4 で削除 migration を用意する。

### 既存 `vibe_memories`

既存 raw memory は保持する。`isSynthesized=false` のものは新しい synthesis policy で再処理できる。

## テスト計画

単体テスト:

```bash
bun test test/mcp/tools/agentFirst.test.ts
bun test test/agentFirstSearch.test.ts
bun test test/ingest.test.ts
bun test test/synthesis.test.ts
bun test test/runner.test.ts
```

統合確認:

```bash
bun run doctor
bun run monitor:snapshot
bun run src/scripts/sync.ts
bun run src/scripts/reflect.ts
bun run verify:fast
```

検索品質確認:

1. Codex JSONL に含まれる既知のユーザー運用ルールを取り込む。
2. `agentic_search` に同領域の依頼を渡す。
3. 関連 rule / lesson / decision が `usedKnowledge` に出ることを確認する。
4. 無関係な frontend / auth / db ルールが skip されることを確認する。

## 受け入れ条件

- `initial_instructions` が lifecycle workflow を案内しない。
- `agentic_search` が primary knowledge entrypoint として公開されている。
- `search_knowledge` が raw candidate search として明確に説明されている。
- Codex JSONL が `vibe_memories` の source として同期される。
- scheduled LLM / background worker が raw memory を `entities` に蒸留する。
- `review_task` が `agentic_search` 経由で実際に採用した knowledge だけを使う。
- lifecycle tools は public MCP surface から消える。
- docs から `activate_project` / `start_task` / `finish_task` 推奨が消える。
- `bun run verify:fast` が通る。

## 非目標

- Codex の全 tool output を丸ごと保存すること。
- raw 会話をそのまま primary knowledge として大量に返すこと。
- local LLM に全 memory を直接読ませること。
- project activation 状態を別途持つこと。
- task trace を再設計して温存すること。

## リスクと対策

| リスク | 対策 |
| :--- | :--- |
| Codex JSONL の形式変更 | parser を payload.type ごとに defensive に書き、未知型は skip する。 |
| raw memory が増えすぎる | cursor / dedupe / source filtering / synthesis batch size を設定可能にする。 |
| local LLM gate が遅い | maxCandidates と timeout を設定し、失敗時は deterministic fallback に戻す。 |
| 蒸留で低価値 entity が増える | kind/category filter と low-value summary rejection を入れる。 |
| lifecycle tool 削除で古いクライアント cache が混乱する | `doctor` の tool visibility 診断で stale metadata を明示する。 |
| review が knowledge なしで止まりすぎる | `knowledgePolicy` で infra failure と no relevant knowledge を分離する。 |

## 実装順

1. `agentic_search` を追加し、`initial_instructions` を軽量化する。
2. `search_knowledge` を raw search 位置づけに変更する。
3. Codex ingestion を追加する。
4. synthesis policy を強化する。
5. `review_task` を `agentic_search` に接続する。
6. lifecycle tools を削除する。
7. doctor / monitor / docs を新 surface に揃える。
