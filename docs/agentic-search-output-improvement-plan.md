# Agentic Search Output Improvement Plan

## Goal

`agentic_search` の返答を、関連知識の単純な列挙から、実作業に使える判断材料へ引き上げる。

完了条件は以下。

- `debug` / `review` intent で、採用知識ごとに次に確認する具体項目が返る。
- `usedKnowledge` は既存フィールドを保ったまま、後方互換の追加フィールドで実用性を上げる。
- OpenAI 優先時は p95 latency と token usage をログで確認できる。
- Gemma4 経路で JSON が崩れても、`required=false` では degraded 停止しない。

## Current State

すでに以下は実装済み。

- `src/config.ts`: `GNOSIS_AGENTIC_SEARCH_PREFER_CLOUD` による OpenAI 優先切替。
- `src/services/agentFirst.ts`: LLM 分類対象を最大 8 件に制限する `llmClassificationCandidates`。
- `src/services/agentFirst.ts`: 1st pass の分類プロンプト簡素化。
- `src/services/agentFirst.ts`: `repair-json` pass と thought output 回復。
- `src/services/agentFirst.ts`: `GNOSIS_AGENTIC_SEARCH_LOG_FILE` への JSONL ログ出力。
- `src/services/agentFirst.ts`: 推定 token ログ (`estimatedPromptTokens`, `estimatedOutputTokens`)。

実測上、OpenAI 優先では同系クエリが約 8 秒で返り、Gemma4 経路は 80-90 秒台または timeout になりやすい。

## Review Findings

1. 出力契約がまだ実作業に薄い。
- 現在の `usedKnowledge` は `id/source/kind/category/title/summary/reason` が中心で、調査時に必要な `nextCheck` や `verificationCommand` がない。

2. `debug` intent の扱いが検索と分類に閉じている。
- root cause 候補、確認先、成功条件を返す契約がないため、LLM が正しく分類しても「次に何をするか」へつながりにくい。

3. `usedKnowledge` の拡張は後方互換で進める必要がある。
- MCP tool の入力 schema は `src/mcp/tools/agentFirst.ts` にあるが、出力は呼び出し側が暗黙に読む可能性がある。既存フィールドの rename/delete は避ける。

4. strict token usage はまだ未実装。
- 現状は文字数ベース推定のみ。OpenAI API の `usage` は `cloudProvider` から上位へ伝播していない。

5. 「知識が少ない」だけではない。
- 知識候補があっても、分類結果が `skip/maybe` に寄ると実用的な出力にならない。SystemContext と selection policy の両方を直す必要がある。

## Proposed Output Contract

既存の `usedKnowledge` 要素に、後方互換で以下を追加する。

```ts
type AgenticUsedKnowledgeV2 = {
  id: string;
  source: 'entity' | 'vibe_memory';
  kind?: string;
  category?: string;
  title: string;
  summary: string;
  reason: string;
  whyNow?: string;
  nextCheck?: string;
  verificationCommand?: string;
  expectedImpact?: string;
};
```

フィールドの意味。

- `whyNow`: このタスクで採用する理由。
- `nextCheck`: 次に見るべきファイル、設定、ログ、または観測点。
- `verificationCommand`: 実行可能な確認コマンド。なければ省略可。
- `expectedImpact`: 確認または適用した場合に改善されること。

### Contract Rules

- V2 は既存フィールドの追加のみを行う。既存フィールドの削除、rename、型変更は禁止する。
- `GNOSIS_AGENTIC_SEARCH_OUTPUT_V2=false` の場合、selection policy と返却 shape は現行互換を維持する。
- `GNOSIS_AGENTIC_SEARCH_OUTPUT_V2=true` の場合のみ、optional V2 fields と intent-aware selection を有効化する。
- V2 fields が空でも `agentic_search` 自体は失敗させない。ただし evaluation gate では不合格にする。
- downstream caller は `outputVersion: 2` が存在する場合だけ V2 fields を読む。

### Field Requirements

- `debug`: `usedKnowledge` の最低 1 件は `whyNow` と `nextCheck` を持つ。
- `debug`: `verificationCommand` は advisory text として扱う。自動実行しない。
- `review`: `usedKnowledge` の最低 1 件は `whyNow` と `expectedImpact` を持つ。
- `plan` / `edit`: `usedKnowledge` の最低 1 件は `whyNow` を持つ。
- LLM 出力が不完全な場合、deterministic 補完で `whyNow` / `nextCheck` を生成してよい。

## Intent Policy

### `debug`

必須出力。

- `whyNow`
- `nextCheck`
- 可能なら `verificationCommand`

採用方針。

- `use` が 1 件未満なら、`maybe` の高スコア候補を 1 件昇格する。
- `error`, `degraded`, `timeout`, `json`, `mcp`, `doctor`, `log`, `runtime` に関係する候補を加点する。
- 一般的な lint / workflow / ticketing ルールは減点する。

### `review`

必須出力。

- `whyNow`
- `expectedImpact`

採用方針。

- `risk`, `testing`, `security`, `architecture`, `mcp` を優先する。
- Failure Firewall hint がある場合は `failureFirewall.suggestedUse` と矛盾しない。

### `plan` / `edit`

必須出力。

- `whyNow`

採用方針。

- `files`, `changeTypes`, `technologies` の一致を優先する。

## Implementation Plan

### Phase 1: Output V2 Without Breaking Existing Callers

1. `AgenticLlmDecision` に optional fields を追加する。
- `whyNow`
- `nextCheck`
- `verificationCommand`
- `expectedImpact`

2. `normalizeAgenticLlmDecisions` で optional fields を取り込む。
- 文字列だけ採用し、長さは `truncateText` で制限する。

3. `usedKnowledge` mapping で optional fields を返す。
- 既存フィールドは削除・rename しない。

4. `test/agentFirstSearch.test.ts` に debug intent の V2 出力テストを追加する。

### Phase 2: Prompt Contract Upgrade

1. classification prompt に intent-specific instruction を追加する。
- `debug`: `nextCheck` を必ず埋める。
- `review`: `expectedImpact` を必ず埋める。

2. ただし prompt は短く保つ。
- 候補は現行通り `i/id/title/summary(short)` に限定する。
- schema 例は V2 fields を含めるが、説明文を増やしすぎない。

3. `repair-json` prompt も V2 schema に合わせる。

### Phase 3: Selection Policy

1. `debug` / `review` の `maxReturned` 下限を 2 にする。
- ユーザー指定が 1 の場合だけ尊重するかは実装時に決める。

2. `debug` で `use` が少ない場合の補完を実装する。
- `maybe` かつ confidence >= 0.55 の候補を最大 1 件昇格する。
- 昇格理由は `reason` に明記する。

3. 一般論ノイズの減点を入れる。
- `lint`, `boy scout`, `ticket`, `kanban` だけで一致している候補は debug で下げる。

4. 閾値を固定する。
- `debug` の昇格しきい値は `confidence >= 0.55` かつ deterministic score 上位 5 件以内。
- 同点時は `score desc`, `referenceCount desc`, `createdAt desc` の順に決める。
- ユーザーが `maxReturned=1` を明示した場合は下限 2 への引き上げを行わない。

### Phase 4: Strict Token Usage Logging

1. `src/services/review/llm/types.ts` に usage 型を追加する。

```ts
type LLMUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};
```

2. `LLMGenerateResult` に `usage?: LLMUsage` を追加する。

3. `src/services/review/llm/cloudProvider.ts` で OpenAI/Azure payload の `usage` を拾う。

4. `src/scripts/ask-llm.ts` は stdout の本文を壊さない。
- usage は JSON output のときだけ含めるか、別ログ (`GNOSIS_LLM_USAGE_LOG_FILE`) に書く。
- `memoryLoopLlmRouter` が stdout text を期待しているため、本文に usage を混ぜない。

5. `agentic_search` ログへ厳密 usage を出す。
- usage がなければ現行の estimated token を出す。

### Usage Log Schema

`GNOSIS_LLM_USAGE_LOG_FILE` を使う場合は JSONL とし、1 行は以下の形にする。

```ts
type LlmUsageLogEvent = {
  ts: string;
  task: 'agentic_search';
  routeAlias: 'openai' | 'azure-openai' | 'bedrock' | 'gemma4' | 'bonsai';
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  estimatedPromptTokens?: number;
  estimatedOutputTokens?: number;
  requestId?: string;
};
```

ログ制約。

- prompt 本文、candidate summary、API key、tool result は usage log に出さない。
- strict usage が取れない provider では estimated fields のみ出す。
- streaming / non-streaming の差は usage が取れる場合だけ記録する。
- rotation はこのタスクでは実装しない。LaunchAgent 運用時は既存ログ運用と同じ扱いにする。

## Command Safety

`verificationCommand` は実行提案であり、自動実行対象ではない。

- shell metacharacter を含む複雑な command は避ける。
- 破壊的操作 (`rm`, `git reset`, `git checkout --`, DB delete/update) は出さない。
- repo root 前提の read-only command を優先する。
- 例: `bun test test/agentFirstSearch.test.ts`, `tail -n 100 /tmp/gnosis-agentic-search.log`, `rg -n "agenticSearch" src/services/agentFirst.ts`。

### Phase 5: Evaluation Gate

ベンチ対象クエリ。

- `MCP host integration settings and available tools for gnosis mcp server`
- `How to debug agentic_search degraded JSON parse error in gnosis mcp tools`
- `review_task mcp tooling and gnosis doctor diagnostics for runtime health`
- `KnowFlow worker queue health and monitor snapshot diagnostics`
- `OpenAI token usage logging for memoryLoop router`

合格基準。

- OpenAI 優先 p95 latency <= 20s。
- token usage は 10-run average で 1 回あたり 3,000 total tokens 以下を目安にする。
- `degradedReasons` が空、または fallback 理由が明示される。
- `debug` intent の `usedKnowledge` は最低 1 件が `nextCheck` を持つ。
- strict usage または estimated usage が必ずログに出る。
- `bun test test/agentFirstSearch.test.ts` が通る。

失敗条件。

- V2 有効時に既存フィールドが消える。
- `debug` intent で `nextCheck` が 0 件になる。
- OpenAI 優先 p95 latency が 30s を超える。
- 10-run 中 2 回以上 timeout または degraded 停止する。
- usage log に prompt 本文または候補本文が混入する。

## Rollout

1. `GNOSIS_AGENTIC_SEARCH_OUTPUT_V2=true` で V2 出力を有効化する。
2. 既存出力との差分を JSONL ログで確認する。
3. MCP host を再起動して実クエリを 10 回流す。
4. Gate を満たしたら V2 をデフォルト化する。
5. 旧経路削除は別PRまたは別タスクで行う。

Rollback 条件。

- Gate の失敗条件に該当したら `GNOSIS_AGENTIC_SEARCH_OUTPUT_V2=false` に戻す。
- OpenAI usage が取れない場合でも rollback しない。estimated usage ログが出ていれば続行する。
- 返却 shape の後方互換が崩れた場合は即 rollback する。

## Commands

```bash
bun test test/agentFirstSearch.test.ts
```

```bash
launchctl setenv MEMORY_LOOP_ALLOW_CLOUD true
launchctl setenv MEMORY_LOOP_CLOUD_PROVIDER openai
launchctl setenv GNOSIS_AGENTIC_SEARCH_PREFER_CLOUD true
launchctl setenv GNOSIS_AGENTIC_SEARCH_LOG_FILE /tmp/gnosis-agentic-search.log
launchctl kickstart -k gui/$(id -u)/com.gnosis.mcp-host
```

```bash
tail -n 100 /tmp/gnosis-agentic-search.log
```
