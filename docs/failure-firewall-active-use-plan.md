# Failure Firewall Active-Use Implementation Plan

最終更新: 2026-05-04

## 目的

Failure Firewall を、独自登録された Golden Path / failure pattern だけを読む検出器から、既存の `entity lesson / rule / procedure / risk / skill` を `review_task` と `agentic_search` の通常導線で自動参照する仕組みに変える。

ユーザーや agent が毎回 `failure_firewall` や `search_knowledge` を明示的に思い出さなくても、diff / task context から関係しそうな過去 lesson を薄く拾い、レビューや調査の判断材料として渡す。

この計画では Gemma4 に lesson の蒸留を任せない。`record_task_note` は引き続き正本の登録入口であり、Failure Firewall はその登録済み知識を読む側の layer として扱う。

## 判断

- 登録入口は増やさない。`record_task_note` と既存 `entities` / `experience_logs` を正本にする。
- raw lesson 由来の context は blocking に使わない。`needs_confirmation` または reviewer evidence に限定する。
- structured active rule / dedicated pattern は従来どおり `changes_requested` にできる。
- Gemma4 に `requiredSteps` / `appliesWhen` の生成を必須化しない。
- primary MCP tool は増やさない。`initial_instructions`, `agentic_search`, `search_knowledge`, `record_task_note`, `review_task`, `doctor` のままにする。
- 既存の `failure_firewall/run`, `failure_firewall/context`, `failure_firewall/suggest_learning_candidates` private host request は残す。

## 現状

既にあるもの:

- `src/services/failureFirewall/context.ts`
  - diff / task context から risk signals を作り、structured Golden Path / failure pattern candidate を返す。
- `src/services/failureFirewall/patternStore.ts`
  - seed, dedicated table, `metadata.goldenPath`, `metadata.failureFirewall`, `experience_logs` を読める。
- `src/services/review/tools/failureFirewall.ts`
  - reviewer internal tool `lookup_failure_firewall_context` がある。
- `src/services/review/orchestrator.ts`
  - `goal` に `failure_firewall` が含まれる場合は FastGate として `runFailureFirewallReview` を実行できる。
- `src/services/agenticSearch/runner.ts`
  - `knowledge_search` と `brave_search` を prefetch する。

足りないもの:

- ordinary `entity lesson / rule / procedure / risk / skill` を Firewall context として直接拾えない。
- 通常 `review_task` で Firewall context lookup が deterministic に走らない。LLM が internal tool を呼ぶかどうかに依存している。
- `agentic_search` の prefetch に Firewall context が入っていない。
- raw lesson 由来 context と active structured rule の blocking 境界が型とテストで固定されていない。

## 目標動作

### review_task

ユーザーは普通にレビューを依頼する。

```text
この diff をレビューしてください
```

`review_task` は内部で次を行う。

```text
diff取得
  -> buildFailureDiffFeatures
  -> lookupFailureFirewallContext
       - structured Golden Path / failure pattern
       - raw entity lesson evidence
  -> shouldUse=true の場合だけ reviewer context に短く注入
  -> LLM review
  -> finding が lesson を使った場合は knowledge_refs に source entity id を残す
```

raw lesson 由来の context は自動 blocker にしない。reviewer が具体的な diff 根拠を見つけた場合だけ finding になる。

### agentic_search

ユーザーは普通に実装相談や調査を依頼する。

```text
この auth middleware の変更方針を考えて
```

`agentic_search` は既存 prefetch に加えて、code / review / debug / plan 系の依頼だけ Failure Firewall context を薄く取得する。

```text
userRequest/files/changeTypes/technologies
  -> lookupFailureFirewallContext
  -> relevant lesson があれば tool result として LLM context に渡す
```

回答 schema は増やさない。ユーザー向け出力は自然文のままにする。

### explicit failure_firewall goal

`goal: failure_firewall` の場合は従来どおり FastGate として実行する。

```text
active structured rule / dedicated pattern -> changes_requested 可能
raw lesson evidence only -> needs_confirmation まで
```

## データ契約

### 正本

正本は `entities` と `experience_logs`。

対象 entity:

```text
entities.type in:
- lesson
- rule
- procedure
- risk
- skill
- command_recipe
- decision
```

ただし Firewall context として優先するのは `lesson`, `rule`, `procedure`, `risk`, `skill`。

読む metadata:

```ts
type EntityLessonMetadata = {
  kind?: string;
  category?: string;
  tags?: string[];
  files?: string[];
  evidence?: Array<{ type?: string; value?: string; uri?: string }>;
  riskSignals?: string[];
  failureFirewall?: {
    role?: 'golden_path' | 'failure_pattern' | 'reference';
    riskSignals?: string[];
    status?: 'active' | 'needs_review' | 'deprecated';
  };
};
```

`metadata.failureFirewall` は任意。付いていない ordinary lesson も候補にできる。

### Context output

`FailureFirewallContext` に `lessonCandidates` を追加する。

```ts
type FailureFirewallLessonCandidate = {
  id: string;
  title: string;
  kind: string;
  category?: string;
  content: string;
  tags: string[];
  files: string[];
  evidence: string[];
  riskSignals: string[];
  score: number;
  reason: string;
  source: 'entity' | 'experience';
  blocking: false;
};
```

`blocking` は raw lesson 由来では常に `false`。active structured rule と区別するために明示する。

`FailureFirewallContext`:

```ts
type FailureFirewallContext = {
  shouldUse: boolean;
  reason: string;
  riskSignals: string[];
  changedFiles: string[];
  lessonCandidates: FailureFirewallLessonCandidate[];
  goldenPathCandidates: GoldenPathCandidate[];
  failurePatternCandidates: FailurePatternCandidate[];
  suggestedUse: 'skip' | 'review_reference' | 'run_fast_gate' | 'generate_learning_candidates';
  degradedReasons: string[];
};
```

## Lesson candidate scoring

初期版は deterministic scoring のみ。

入力:

- diff riskSignals
- changedFiles
- languages
- frameworks / technologies
- taskGoal / userRequest
- entity type / metadata tags / metadata files / title / description

スコア:

```text
0.45 risk signal overlap
0.25 file overlap
0.15 entity kind weight
0.10 metadata.failureFirewall bonus
0.05 title/content weak text overlap
```

kind weight:

```text
procedure/rule/skill: Golden Path reference として強い
lesson/risk: recurrence reference として強い
decision/command_recipe: 補助。初期版では低め
```

候補上限:

- `maxLessonCandidates`: default 5, hard max 10
- context 注入時は title / id / reason / short content のみ
- full content は 600 chars で切る

## 実装ステップ

### Step 1: 型追加

対象:

- `src/services/failureFirewall/types.ts`

作業:

- `FailureFirewallLessonCandidate` を追加する。
- `FailureFirewallContext.lessonCandidates` を追加する。
- `LookupFailureFirewallContextInput.maxLessonCandidates` を追加する。

互換性:

- 既存 `goldenPathCandidates` / `failurePatternCandidates` は維持する。
- 既存 caller は `lessonCandidates` を無視しても壊れない。

テスト:

- 既存 `test/failureFirewallContext.test.ts` が壊れないこと。

### Step 2: raw lesson loader

対象:

- `src/services/failureFirewall/patternStore.ts`

追加:

```ts
export async function loadFailureLessonEvidence(input: {
  database?: typeof db;
  riskSignals: string[];
  changedFiles: string[];
  languages: string[];
  technologies?: string[];
  taskGoal?: string;
  limit?: number;
}): Promise<FailureFirewallLessonCandidate[]>
```

実装方針:

- `entities` から対象 type を読む。
- `metadata.tags`, `metadata.files`, `metadata.riskSignals`, `metadata.failureFirewall.riskSignals` を見る。
- DB 側の複雑な全文検索は初期版ではやらない。まず bounded rows を読み、TypeScript 側で score する。
- `metadata.failureFirewall.status === 'deprecated'` は除外する。
- score 0 の候補は返さない。

注意:

- ordinary lesson を `GoldenPath` / `FailurePattern` に変換しない。
- ここでは blocking 判定を作らない。

テスト:

- `entities(type=lesson)` が `lessonCandidates` に出る。
- `metadata.failureFirewall` がなくても `tags/files/title` で拾える。
- deprecated は出ない。

### Step 3: context lookup に統合

対象:

- `src/services/failureFirewall/context.ts`

作業:

- `lookupFailureFirewallContext` 内で `loadFailureLessonEvidence` を呼ぶ。
- `suggestedUse` 判定に `lessonCandidates` を入れる。

判定:

```text
docsOnly -> skip
riskSignals empty -> skip
failurePatternCandidates > 0 -> run_fast_gate
goldenPathCandidates > 0 -> review_reference
lessonCandidates > 0 -> review_reference
otherwise -> skip
```

reason:

- structured candidate の場合: current reason を維持
- lesson only の場合: `Matched raw lesson evidence for risk signals: ...`

テスト:

- raw lesson だけで `shouldUse=true`, `suggestedUse=review_reference`。
- docs-only は lesson lookup しても `skip`。

### Step 4: review_task 自動注入

対象:

- `src/services/review/orchestrator.ts`
- `src/services/review/systemContext.ts`
- 必要なら `src/services/review/types.ts`

作業:

- 通常 `runReviewAgenticCore` / knowledge-aware review の diff 取得後、LLM reviewer 実行前に `lookupFailureFirewallContext` を一度だけ呼ぶ。
- `shouldUse=true` の場合、reviewer prompt に short context を追加する。
- 既存 internal tool `lookup_failure_firewall_context` は残す。追加調査用。

context 文面:

```text
### Failure Firewall Context
Risk signals: ...
Relevant lessons:
- note/abc: Mutation後は query key を更新する (reason: tag overlap cache_invalidation)

Use these as confirmation evidence only. Raw lessons are not automatic blockers; a finding still needs concrete diff evidence.
```

出力境界:

- raw lesson だけで review status を `changes_requested` にしない。
- finding が具体的 diff 根拠を持つ場合は通常 finding として扱う。
- `knowledge_refs` には lesson entity id を入れる。

テスト:

- reviewer に渡る prompt に Failure Firewall context が含まれる。
- raw lesson context だけでは finding がない場合 `no_major_findings`。
- reviewer が lesson id を使った finding を返した場合、`knowledge_refs` が残る。

### Step 5: agentic_search prefetch

対象:

- `src/services/agenticSearch/runner.ts`
- `src/services/agenticSearch/types.ts`

作業:

- 既存 prefetch 後に `lookupFailureFirewallContext` を呼ぶ。
- `intent` が `plan`, `edit`, `debug`, `review` の場合だけ実行する。
- `files/changeTypes/technologies/userRequest` を渡す。
- `shouldUse=true` の場合だけ tool message として追加する。

tool trace:

- 新しい public tool は追加しない。
- `trace.toolCalls` には `failure_firewall_context` の内部 prefetch として残すか、別 field を増やさず system message だけにする。
- 初期版では trace schema を増やさず、system/tool message のみでよい。

context 文面:

```text
Failure Firewall found relevant raw lessons. Treat them as review/reference context, not as hard rules.
```

テスト:

- `agentic_search` の output schema が増えない。
- context がある場合に adapter history へ short context が入る。
- context lookup failure は degraded response にしない。best-effort。

### Step 6: FastGate 境界の固定

対象:

- `src/services/failureFirewall/index.ts`
- `src/services/failureFirewall/scorer.ts`
- `test/failureFirewall.test.ts`

作業:

- `runFailureFirewall` の `changes_requested` は structured active candidate だけで決まることを明記する。
- raw lesson candidates は `runFailureFirewall` の blocking match に混ぜない。

テスト:

- raw lesson evidence only の diff は `changes_requested` にならない。
- existing seed/dedicated pattern の cache invalidation test は従来どおり `changes_requested`。

### Step 7: docs 更新

対象:

- `docs/failure-firewall.md`
- `docs/mcp-tools.md` 必要最小限

作業:

- Failure Firewall は独自登録ではなく raw entity lesson を自動参照する layer と説明する。
- `record_task_note` が正本登録入口であることを明記する。
- Gemma4 蒸留を必須にしない方針を明記する。
- primary MCP tool を増やさない。

## 実装しないこと

- Gemma4 に raw lesson から active rule を自動生成させない。
- `record_task_note` に Firewall 専用必須 field を増やさない。
- lesson 由来 context を自動 blocking に使わない。
- 初期版で DB full-text search や embedding rerank を新設しない。
- `agentic_search` の user-facing response schema を増やさない。
- Failure Firewall primary MCP tool を追加しない。

## 受け入れ条件

機能:

- ordinary `entity lesson` が `lookupFailureFirewallContext` の `lessonCandidates` に出る。
- 通常 `review_task` で、ユーザーが明示検索しなくても relevant lesson context が reviewer に渡る。
- `agentic_search` で、code/review/debug/plan 系の依頼に relevant lesson context が補助材料として渡る。
- raw lesson だけでは `changes_requested` にならない。
- structured active failure pattern は従来どおり `changes_requested` にできる。

品質:

- context は bounded。最大 5 件、各 content は 600 chars 以下。
- context lookup failure は review / agentic_search 全体を失敗させない。
- 既存 primary MCP tool snapshot を壊さない。

テスト:

```bash
bun test test/failureFirewallContext.test.ts test/failureFirewall.test.ts
bun test test/mcp/tools/agentFirst.test.ts
bun test test/mcpToolsSnapshot.test.ts test/mcpContract.test.ts
bun run verify:fast
```

最終的な完了条件:

```bash
bun run verify
```

## 実装順

1. `types.ts` に `FailureFirewallLessonCandidate` を追加する。
2. `patternStore.ts` に `loadFailureLessonEvidence` を追加する。
3. `context.ts` で lesson candidates を返す。
4. `failureFirewallContext.test.ts` に ordinary lesson retrieval を追加する。
5. `review_task` に deterministic context injection を入れる。
6. review path のテストを追加する。
7. `agentic_search` に best-effort context prefetch を入れる。
8. agentic search path のテストを追加する。
9. raw lesson non-blocking の regression test を追加する。
10. docs を更新し、verify を通す。

## リスク

### ノイズが増える

対策:

- lessonCandidates は最大 5 件。
- score 0.25 未満は返さない。
- docs-only は skip。
- raw lesson は blocker にしない。

### lesson 検索が既存 agentic_search と重複する

対策:

- 価値は「別検索」ではなく「diff risk signals から自動で見ること」に置く。
- `agentic_search` の通常 `knowledge_search` 結果と混ぜすぎず、short context に限定する。

### Gemma4 に依存した蒸留に戻る

対策:

- 初期版では LLM を使わない。
- `metadata.failureFirewall` は任意。
- active 昇格は別フェーズ。

### DB query が重くなる

対策:

- 初期版は対象 type を限定する。
- hard limit を設ける。
- 必要になってから index / projection cache を検討する。

## 後続フェーズ

初期版が有効だった場合だけ、次を検討する。

- repeated accepted finding から active structured rule へ昇格する CLI。
- false positive feedback を lesson candidate score に反映する。
- dedicated table を登録先ではなく projection cache として再定義する。
- Monitor で `needs_review` lesson / Firewall candidate を確認・昇格する。
