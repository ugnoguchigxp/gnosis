# Failure Firewall Active-Use Implementation Plan

最終更新: 2026-04-30

## 目的

Failure Firewall を「単体 CLI でたまに走る検出器」ではなく、Agentic Search、`review_task`、verify 後の知識登録ループから自然に使える機能にする。

CLI は UX として残す。ただし、実行本体は Gnosis MCP shared host / daemon の in-process service に寄せる。`bun run failure-firewall` は既定で host へ private request を送る薄い client とし、長寿命 Bun runtime を追加で残さない。

この計画は、既存の primary MCP tool surface を増やさず、以下の3点を実装する。

- Agentic Search が、必要そうな場合だけ Failure Firewall / Golden Path context を候補として提示する。
- `review_task` の reviewer が、必要と判断した場合だけ Failure Firewall context を参照できる。
- 実装完了、verify 合格、ユーザーの commit 承認が揃ったタイミングで、成功パターンと失敗パターンの登録候補を作る。
- CLI から使う場合も、既定では Gnosis MCP host 経由で実行し、単発 CLI process は結果を受け取ったら終了する。

## 前提

- primary MCP tools は `initial_instructions`, `agentic_search`, `search_knowledge`, `record_task_note`, `review_task`, `doctor` の6件を維持する。
- Failure Firewall は primary MCP tool にしない。
- Failure Firewall / Golden Path context は常時実行ではなく、agent が必要と判断した場合だけ参照する。
- `initial_instructions` には、Failure Firewall / Golden Path context が必要時に使えることだけを短く説明する。常時 preflight や mandatory review として案内しない。
- CLI は利用入口として維持するが、既定実行は MCP host daemon へ委譲する。host がない場合に一時 Bun runtime を裏で残す挙動は避ける。
- host がない環境で直接実行したい場合は、明示的な `--direct` または `GNOSIS_FAILURE_FIREWALL_DIRECT=1` の debug fallback に限定する。
- 登録前には関連 verify gate が通っている必要がある。
- 完了報告前には、変更差分をセルフレビューし、改善点を潰してから verify を実行する。
- 成功パターンと失敗パターンは pair として扱う。ただし自動で active にせず、初期 status は `needs_review` を基本にする。

## 現状の課題

### 1. 実行導線が孤立している

現状の `bun run failure-firewall` と `review_task` の `goal: failure_firewall` は存在するが、通常の Agentic Search / review flow から「今回参照すべきか」を判断する導線が弱い。

その結果、Failure Firewall を使うには人間または agent が明示的に思い出す必要がある。

加えて、単体 CLI をそのまま実行本体にすると、Bun runtime / DB pool / local LLM 経路の lifecycle が CLI ごとに分散しやすい。Gnosis には shared MCP host があるため、既定実行はこの daemon に集約した方が運用上合理的である。

### 2. Golden Path の育成ループが未実装

`record_task_note` で procedure / rule / lesson は保存できるが、それを Failure Firewall 用の Golden Path / failure pattern に候補化し、verify 済みの事実と結びつける処理がない。

そのため、seed pattern 以上に賢くなりにくい。

### 3. `knowledgeSource` 指定が実行時に効かない

`runFailureFirewallReview` は `goal` から `--knowledge-source` を解釈しているが、`runFailureFirewall` から `loadFailureKnowledge` へ `knowledgeSource` を渡していない。`dedicated` / `hybrid` を指定しても、期待どおり切り替わらない可能性がある。

対象:

- `src/services/failureFirewall/index.ts`
- `test/failureFirewall.test.ts`

### 4. docs に旧 lifecycle 前提が残っている

`docs/failure-firewall.md` には `start_task` / `finish_task` を前提にした登録フローが残っている。現行の primary MCP surface では、登録は `record_task_note` と review / verify 後の明示候補生成に寄せる。

## 目標アーキテクチャ

```text
User task / code diff
  |
  v
agentic_search
  |
  +--> normal task-aware knowledge
  +--> optional Failure Firewall context suggestion
       - shouldUse: boolean
       - matched risk signals
       - likely Golden Path candidates
       - likely failure pattern candidates
       - suggested reviewer use
  |
  v
implementation
  |
  v
self-review
  |
  v
verify
  |
  v
review_task
  |
  +--> reviewer internal tool: lookup_failure_firewall_context
       - called only when reviewer judges it relevant
       - not a primary MCP tool
       - returns bounded Golden Path / failure evidence
  |
  v
user commit approval
  |
  v
suggest success/failure learning candidates
  |
  v
record_task_note / needs_review storage
  |
  v
later promotion to active Golden Path / failure pattern

CLI
  |
  v
bun run failure-firewall
  |
  +--> default: send private request to Gnosis MCP host
  |         - no extra long-lived Bun runtime
  |         - shared DB pool / shared service lifecycle
  |
  +--> explicit debug fallback: --direct
            - runs in the CLI process
            - closes DB pool before exit
```

## Runtime 方針

Failure Firewall は次の3つの入口を持つ。

| 入口 | 役割 | 実行本体 |
| :--- | :--- | :--- |
| Agentic Search | 必要時の context 提案 | in-process service |
| `review_task` | reviewer が必要時に参照する内部 tool | in-process service |
| `bun run failure-firewall` | 人間・agent 向け CLI UX | 既定は MCP host private request |

MCP host に載せる機能は primary MCP tool ではない。`tools/list` には出さず、host protocol の private request として扱う。

想定 request:

```ts
type FailureFirewallRunHostInput = {
  repoPath?: string;
  rawDiff?: string;
  mode?: 'fast' | 'with_llm';
  diffMode?: 'git_diff' | 'worktree';
  knowledgeSource?: 'entities' | 'dedicated' | 'hybrid';
};

type LookupFailureFirewallContextInput = {
  repoPath?: string;
  rawDiff?: string;
  taskGoal?: string;
  files?: string[];
  changeTypes?: string[];
  technologies?: string[];
  maxGoldenPaths?: number;
  maxFailurePatterns?: number;
  knowledgeSource?: 'entities' | 'dedicated' | 'hybrid';
};

type SuggestFailureFirewallLearningCandidatesInput = {
  repoPath?: string;
  rawDiff: string;
  verifyCommand: string;
  verifyPassed: boolean;
  commitApprovedByUser: boolean;
  reviewFindings?: Array<{
    title: string;
    severity: string;
    accepted?: boolean;
    filePath?: string;
    evidence?: string;
  }>;
  knowledgeSource?: 'entities' | 'dedicated' | 'hybrid';
};

type FailureFirewallHostRequest =
  | {
      type: 'failure_firewall/context';
      input: LookupFailureFirewallContextInput;
    }
  | {
      type: 'failure_firewall/run';
      input: FailureFirewallRunHostInput;
    }
  | {
      type: 'failure_firewall/suggest_learning_candidates';
      input: SuggestFailureFirewallLearningCandidatesInput;
    };
```

host protocol に流す input は JSON-safe DTO に限定する。`RunFailureFirewallOptions` のように `database`, `llmService`, `now` などの process-local dependency や function を含む型を、そのまま socket request に使ってはいけない。

CLI の既定挙動:

1. `GNOSIS_MCP_HOST_SOCKET_PATH` または repo default の `.gnosis/mcp-host.sock` に接続する。
2. host が健康なら private request を送信し、結果を JSON または Markdown で表示して終了する。
3. host がない場合は、勝手に long-lived Bun process を残さない。`scripts/setup-automation.sh load` または `bun run mcp:host` を案内する。
4. `--direct` 指定時だけ、従来どおり CLI process 内で実行する。この場合は `closeDbPool()` を必ず呼んで終了する。

初期実装では `--start-host` は作らない。host 起動を CLI が暗黙に行うと process lifecycle が再び分散するため、まずは「host 未起動なら案内して終了」に固定する。必要性が明確になった場合だけ、明示的な起動オプションを別 PR で検討する。

## データ契約

### Failure Firewall Context

`agentic_search` と `review_task` の内部参照で共通利用する。

```ts
type FailureFirewallContext = {
  shouldUse: boolean;
  reason: string;
  riskSignals: string[];
  changedFiles: string[];
  goldenPathCandidates: Array<{
    id: string;
    title: string;
    source: 'seed' | 'entity' | 'experience' | 'dedicated';
    pathType: string;
    appliesWhen: string[];
    requiredSteps: string[];
    allowedAlternatives: string[];
    score: number;
  }>;
  failurePatternCandidates: Array<{
    id: string;
    title: string;
    source: 'seed' | 'entity' | 'experience' | 'dedicated' | 'review_outcome';
    patternType: string;
    severity: 'error' | 'warning' | 'info';
    requiredEvidence: string[];
    score: number;
  }>;
  suggestedUse:
    | 'skip'
    | 'review_reference'
    | 'run_fast_gate'
    | 'generate_learning_candidates';
  degradedReasons: string[];
};
```

### Learning Candidate

verify 合格とユーザー commit 承認の後に作る。保存先はまず `record_task_note` 相当の entity で、dedicated table への昇格は別フェーズにする。

```ts
type FailureFirewallLearningCandidate = {
  candidateId: string;
  status: 'needs_review';
  sourceEvent: 'verified_commit_approval';
  verifyCommand: string;
  commitApprovedByUser: true;
  successPattern?: {
    kind: 'procedure' | 'skill' | 'rule' | 'decision';
    title: string;
    content: string;
    goldenPath: {
      pathType: string;
      appliesWhen: string[];
      requiredSteps: string[];
      allowedAlternatives: string[];
      blockWhenMissing: string[];
      riskSignals: string[];
    };
  };
  failurePattern?: {
    kind: 'risk' | 'lesson' | 'rule';
    title: string;
    content: string;
    failureFirewall: {
      patternType: string;
      severity: 'error' | 'warning' | 'info';
      riskSignals: string[];
      matchHints: string[];
      requiredEvidence: string[];
      goldenPathCandidateId?: string;
    };
  };
};
```

## Phase 0: 現状修正と docs の前提整理

目的: 以降の実装前に、既存の指定が正しく効く状態へ揃える。

対象ファイル:

- `src/services/failureFirewall/index.ts`
- `test/failureFirewall.test.ts`
- `src/mcp/tools/agentFirst.ts`
- `test/mcp/tools/agentFirst.test.ts`
- `docs/failure-firewall.md`
- `docs/failure-firewall-active-use-plan.md`

実装手順:

1. `runFailureFirewall` 内の `loadFailureKnowledge` 呼び出しへ `knowledgeSource: options.knowledgeSource` を渡す。
2. `failure_firewall --knowledge-source dedicated` が dedicated だけを読む regression test を追加する。
3. `docs/failure-firewall.md` の `start_task` / `finish_task` 前提を、`agentic_search`, `review_task`, `record_task_note`, verify 後候補生成へ置き換える。
4. `initial_instructions` に、Failure Firewall / Golden Path context は必要時に使える補助機能であり、常時 preflight ではないことを短く入れる。
5. `bun run failure-firewall -- --help` と `bun run failure-firewall -- --json --mode worktree` の現状を確認する。

受け入れ条件:

- `--knowledge-source dedicated|hybrid` が実行結果に反映される。
- docs に lifecycle tool を前提にした登録導線が残らない。
- `initial_instructions` は Failure Firewall の存在を説明するが、文量は増やしすぎない。
- 既存の `failureFirewall.test.ts` が通る。

検証:

```bash
bun test test/failureFirewall.test.ts
bun run failure-firewall -- --help
bun run failure-firewall -- --json --mode worktree
```

## Phase 0.5: MCP host private request 化

目的: CLI UX は残しつつ、既定実行を shared MCP host / daemon に集約する。

対象ファイル:

- `src/mcp/hostProtocol.ts`
- `src/mcp/host.ts`
- `src/services/failureFirewall/index.ts`
- `src/services/failureFirewall/context.ts`
- `src/services/failureFirewall/learningCandidates.ts`
- `src/services/failureFirewall/cli.ts`
- `src/scripts/failure-firewall.ts`
- `test/failureFirewallHost.test.ts`
- `test/failureFirewall.test.ts`
- `test/mcpStdioIntegration.test.ts`

実装手順:

1. `hostProtocol` に private request type と JSON-safe input DTO を追加する。
2. `host.ts` で `failure_firewall/context`, `failure_firewall/run`, `failure_firewall/suggest_learning_candidates` を dispatch する。
3. host request handler は DTO を service options に変換する。socket 越しに `database`, `llmService`, `now` などの process-local dependency を渡さない。
4. `cli.ts` の既定実行を host request に変更する。
5. host 未起動時は direct 実行へ自動 fallback しない。起動方法を stderr に出して non-zero で終了する。
6. `--direct` または `GNOSIS_FAILURE_FIREWALL_DIRECT=1` の場合だけ CLI process 内で実行する。
7. direct path は `finally { closeDbPool() }` を維持する。
8. `--help` は host 接続なしで usage だけ返す。

受け入れ条件:

- `bun run failure-firewall -- --help` は host なしでも即時終了する。
- host 起動中の `bun run failure-firewall -- --json --mode worktree` は host request 経由で結果を返す。
- host 未起動で `--direct` なしの場合、long-lived Bun process を起動せず、起動手順を案内して終了する。
- `--direct` 指定時だけ従来の direct 実行ができる。
- `tools/list` に Failure Firewall 用 primary tool は増えない。
- host request DTO は JSON serializable な値だけを受け取る。

検証:

```bash
bun test test/failureFirewallHost.test.ts test/failureFirewall.test.ts test/mcpStdioIntegration.test.ts
bun run failure-firewall -- --help
bun run failure-firewall -- --direct --json --mode worktree
```

host 経由の受け入れ判定は `test/failureFirewallHost.test.ts` に集約する。テストは temp socket で host を起動し、Failure Firewall private request を送ってから shutdown request で終了する。手動で host を起動する場合も temp socket を使い、確認後に必ず shutdown する。

## Phase 1: Failure Firewall Context Service

目的: Agentic Search と `review_task` が共通で使える、軽量で副作用のない context lookup を作る。

対象ファイル:

- `src/services/failureFirewall/context.ts`
- `src/services/failureFirewall/types.ts`
- `src/services/failureFirewall/diffFeatures.ts`
- `src/services/failureFirewall/patternStore.ts`
- `test/failureFirewallContext.test.ts`

実装手順:

1. `lookupFailureFirewallContext(input)` を追加する。
2. `rawDiff` がある場合は `buildFailureDiffFeatures(rawDiff)` を使う。
3. `rawDiff` がない場合は `files`, `changeTypes`, `technologies`, `taskGoal` から軽量 risk signal を推定する。
4. `loadFailureKnowledge` から Golden Path / failure pattern を取得し、risk signal、language、framework、file path で候補を絞る。
5. 返却件数は Golden Path 最大5件、failure pattern 最大3件に制限する。
6. `shouldUse=false` の場合も、理由を返す。
7. DB または dedicated table が読めない場合は seed へ fallback し、`degradedReasons` に理由を入れる。

受け入れ条件:

- docs-only 変更では `shouldUse=false` になる。
- mutation/auth/db/schema などの risk signal がある場合、該当 seed または registered Golden Path が候補に出る。
- context lookup は保存や review finding 生成を行わない。
- local LLM を使わずに短時間で返る。

検証:

```bash
bun test test/failureFirewallContext.test.ts test/failureFirewall.test.ts
```

## Phase 2: Agentic Search への任意候補統合

目的: `agentic_search` が、必要そうな場合だけ Failure Firewall / Golden Path context を提案できるようにする。

対象ファイル:

- `src/services/agentFirst.ts`
- `src/mcp/tools/agentFirst.ts`
- `test/agentFirstSearch.test.ts`
- `test/mcp/tools/agentFirst.test.ts`
- `docs/mcp-tools.md`

実装手順:

1. `agenticSearch` の出力に optional field を追加する。

```ts
failureFirewall?: {
  shouldUse: boolean;
  reason: string;
  suggestedUse: FailureFirewallContext['suggestedUse'];
  riskSignals: string[];
  goldenPathCandidates: Array<{ id: string; title: string; score: number }>;
  failurePatternCandidates: Array<{ id: string; title: string; severity: string; score: number }>;
};
```

2. `changeTypes`, `files`, `technologies`, `userRequest` が code/review/security/db/auth/cache などに該当する場合だけ `lookupFailureFirewallContext` を呼ぶ。
3. `agentic_search` の main decision は今までどおり knowledge retrieval の結果で決める。Failure Firewall context は補助情報として扱う。
4. `initial_instructions` の方針どおり、Failure Firewall を常時 preflight として案内しない。
5. MCP schema snapshot が変わる場合は `test/mcpToolsSnapshot.test.ts` を更新する。

受け入れ条件:

- Agentic Search は通常タスクで Failure Firewall を押し付けない。
- 該当しそうなコード変更では、関連 Golden Path / failure pattern 候補を短く返す。
- local LLM timeout 時も、Failure Firewall context lookup は deterministic に返る。
- 既存 `usedKnowledge` / `decision` の意味を変えない。

検証:

```bash
bun test test/agentFirstSearch.test.ts test/mcp/tools/agentFirst.test.ts test/mcpToolsSnapshot.test.ts
```

## Phase 3: review_task Reviewer 内部ツール

目的: `review_task` の reviewer が、必要だと判断したときだけ Failure Firewall context を参照できるようにする。

primary MCP tool は増やさない。reviewer 内部 tool として扱う。

対象ファイル:

- `src/services/review/tools/index.ts`
- `src/services/review/llm/promptBuilder.ts`
- `src/services/review/llm/agenticReviewer.ts`
- `src/services/review/llm/pseudoToolReviewer.ts`
- `src/services/failureFirewall/context.ts`
- `src/services/failureFirewall/index.ts`
- `test/review-stage-c.test.ts` または既存 review tests
- `test/failureFirewall.test.ts`

実装手順:

1. reviewer tool registry に `lookup_failure_firewall_context` を追加する。
2. tool input は `taskGoal`, `repoPath`, `diff`, `filePaths`, `maxCandidates` に限定する。
3. tool output は `FailureFirewallContext` の bounded summary にする。
4. prompt には「汎用レビューではなく、必要な場合のみ Golden Path 逸脱と再発証拠を確認する」と明記する。
5. `review_task` の `goal` に `failure_firewall` が含まれる場合は context lookup を強めるが、それ以外では reviewer 判断に任せる。
6. FastGate の finding と通常 review finding を混ぜすぎない。metadata に `source: failure_firewall` または `knowledge_refs` を持たせる。

受け入れ条件:

- 通常 review で tool が必ず呼ばれることはない。
- `goal: failure_firewall` では bounded context が reviewer に渡る。
- `review_task` の出力に、参照した Golden Path / failure pattern の id が残る。
- Failure Firewall context が取得できない場合も review は degraded で継続する。

検証:

```bash
bun test src/services/review/tools/index.spec.ts src/services/review/llm/agenticReviewer.spec.ts src/services/review/llm/pseudoToolReviewer.spec.ts test/failureFirewall.test.ts
```

## Phase 4: FastGate の位置づけ整理

目的: FastGate を「常時ブロッカー」ではなく、deterministic safety net として安定させる。

対象ファイル:

- `src/services/failureFirewall/index.ts`
- `src/services/failureFirewall/scorer.ts`
- `src/services/failureFirewall/renderer.ts`
- `src/services/failureFirewall/cli.ts`
- `test/failureFirewall.test.ts`
- `docs/failure-firewall.md`

実装手順:

1. FastGate は `mode=fast` のまま local LLM を使わない。
2. `changes_requested` は `deviation_with_recurrence` かつ severity `error` の場合だけに限定する。
3. Golden Path 逸脱だけなら `needs_confirmation` または warning にする。
4. CLI output に `goldenPathsEvaluated`, `patternsEvaluated`, `riskSignals`, `degradedReasons` を明示する。
5. `--json` は agent が登録候補生成に使える安定 contract にする。

受け入れ条件:

- FastGate は docs-only 変更を無視する。
- cache/auth/db/schema の代表 fixture で expected finding が出る。
- false positive count が高い pattern は severity または score が下がる。

検証:

```bash
bun test test/failureFirewall.test.ts
bun run failure-firewall -- --json --mode worktree
```

## Phase 5: verify 後・commit 承認時の候補生成

目的: 実装完了、verify 合格、ユーザー commit 承認が揃ったときだけ、成功パターンと失敗パターンの登録候補を作る。

Gnosis は git commit approval を直接所有しないため、隠れた commit hook ではなく、agent が明示的に呼べる service として実装する。CLI 入口は残すが、既定では MCP host private request 経由でこの service を呼ぶ。

対象ファイル:

- `src/services/failureFirewall/learningCandidates.ts`
- `src/services/failureFirewall/types.ts`
- `src/services/failureFirewall/cli.ts`
- `src/mcp/tools/agentFirst.ts`
- `test/failureFirewallLearningCandidates.test.ts`
- `docs/mcp-tools.md`
- `docs/failure-firewall.md`

実装手順:

1. `suggestFailureFirewallLearningCandidates(input)` を追加する。
2. input は `rawDiff`, `verifyCommand`, `verifyPassed`, `commitApprovedByUser`, `reviewFindings?`, `repoPath?` を受ける。
3. `verifyPassed !== true` または `commitApprovedByUser !== true` の場合は候補を生成しない。
4. 成功パターン候補は以下から作る。
   - risk signal がある diff
   - verify passed
   - review findings がない、または修正後に passed
   - reusable steps に分解できる
5. 失敗パターン候補は以下から作る。
   - review finding が採用された
   - 修正前 diff に明確な再発可能構造がある
   - successPattern と pair にできる
6. CLI に `bun run failure-firewall -- --suggest-candidates --verify-command "bun run verify" --commit-approved --json` を追加する。既定実行は host private request 経由にする。
7. 保存は自動 active 化しない。`record_task_note` 用 payload を返すか、明示フラグ `--save-candidates` で `needs_review` として保存する。

受け入れ条件:

- verify 未実行または失敗時は候補を生成しない。
- commit 承認がない場合は候補を生成しない。
- success と failure の pair が作れる場合、相互参照 id を持つ。
- 保存時は `status: needs_review` で、active Golden Path にはしない。
- 候補は1タスクあたり最大3件に制限する。

検証:

```bash
bun test test/failureFirewallLearningCandidates.test.ts test/failureFirewall.test.ts
bun run failure-firewall -- --suggest-candidates --verify-command "bun run verify" --commit-approved --json
```

## Phase 6: record_task_note との接続

目的: 候補を Gnosis の通常知識登録フローに乗せる。

対象ファイル:

- `src/mcp/tools/agentFirst.ts`
- `src/services/agentFirst.ts`
- `src/services/failureFirewall/learningCandidates.ts`
- `test/mcp/tools/agentFirst.test.ts`
- `test/agentFirstRecordTaskNote.test.ts` または既存該当テスト

実装手順:

1. `record_task_note` が `tags: ["failure-firewall", "golden-path"]` を含む場合、metadata shape を検証する。
2. `goldenPath` / `failureFirewall` metadata が不足している場合は、保存は許可するが `status: needs_review` に補完する。
3. `record_task_note` の response に `enrichmentState` とは別に `failureFirewallCandidateState` を返す。
4. active 昇格は別 CLI または管理画面で行う。`record_task_note` 直後に active 化しない。

受け入れ条件:

- `record_task_note` は既存用途を壊さない。
- Failure Firewall 候補だけ追加 metadata validation /補完が走る。
- verify gate を通した候補だけが保存候補として案内される。

検証:

```bash
bun test test/mcp/tools/agentFirst.test.ts test/agentFirstSearch.test.ts
```

## Phase 7: 昇格・フィードバック

目的: `needs_review` 候補を active Golden Path / failure pattern に昇格し、false positive を学習できるようにする。

対象ファイル:

- `src/services/failureFirewall/promotion.ts`
- `src/services/failureFirewall/patternStore.ts`
- `src/db/schema.ts`
- `test/failureFirewallPromotion.test.ts`
- `docs/failure-firewall.md`

実装手順:

1. `promoteFailureFirewallCandidate(candidateId)` を追加する。
2. 昇格時に dedicated table を使うか、entities metadata を使うかを config で選ぶ。初期既定は entities metadata。
3. dismissed / false positive feedback は `review_outcomes` から pattern id ごとに集計する。
4. false positive count が閾値を超えた pattern は block 対象から外し、warning 以下に落とす。
5. deprecated 化できるようにする。

受け入れ条件:

- active でない Golden Path / pattern は block しない。
- false positive が蓄積した pattern は severity が下がる。
- dedicated table が読めない場合は seed/entities fallback で動く。

検証:

```bash
bun test test/failureFirewallPromotion.test.ts test/failureFirewall.test.ts
```

## Phase 8: Documentation と運用ルール

目的: agent が使い方を迷わないよう、現在の primary MCP 方針に合わせて docs を短く保つ。

対象ファイル:

- `docs/failure-firewall.md`
- `docs/failure-firewall-active-use-plan.md`
- `docs/mcp-tools.md`
- `README.md`

実装手順:

1. `docs/failure-firewall.md` は設計思想とデータモデル中心に整理する。
2. この文書は実装順と acceptance criteria の正とする。
3. `docs/mcp-tools.md` は primary MCP tool を増やさない方針、Agentic Search / review_task から必要時に参照する方針だけを短く書く。
4. README には追加しすぎない。必要なら MCP 公開面に一文だけ追加する。

受け入れ条件:

- docs に `activate_project` / `start_task` / `finish_task` 前提の新規導線が残らない。
- Failure Firewall を常時必須 preflight として説明しない。
- verify 合格前に知識登録しない運用ルールが明記されている。

検証:

```bash
rg -n "activate_project|start_task|finish_task" docs/failure-firewall.md docs/mcp-tools.md
bun run lint
```

## PR 分割

### PR 1: Context foundation

- Phase 0
- Phase 0.5
- Phase 1
- 対象テスト: `test/failureFirewall.test.ts`, `test/failureFirewallContext.test.ts`, `test/failureFirewallHost.test.ts`

### PR 2: Agentic Search integration

- Phase 2
- 対象テスト: `test/agentFirstSearch.test.ts`, `test/mcp/tools/agentFirst.test.ts`, `test/mcpToolsSnapshot.test.ts`

### PR 3: review_task internal tool

- Phase 3
- 対象テスト: review tool registry / agentic reviewer / pseudo tool reviewer / failure firewall tests

### PR 4: Verified learning candidates

- Phase 5
- Phase 6
- 対象テスト: `test/failureFirewallLearningCandidates.test.ts`, MCP record note tests

### PR 5: Promotion and feedback

- Phase 7
- Phase 8
- 対象テスト: promotion tests, failure firewall regression, docs grep

## 全体完了条件

- Agentic Search が、必要時のみ Failure Firewall context を提案できる。
- `review_task` の reviewer が、必要時のみ Failure Firewall context を参照できる。
- CLI は利用入口として残るが、既定実行は MCP host private request 経由になる。
- `failure_firewall --knowledge-source dedicated|hybrid` が実際に効く。
- verify 合格とユーザー commit 承認がない限り、成功/失敗 pattern 候補は生成されない。
- 成功パターンと失敗パターンは pair として候補化できる。
- 候補は初期状態 `needs_review` で保存され、明示昇格まで active block には使われない。
- primary MCP tool は増えない。
- `bun run verify` が通る。

## 最初に実装するべき最小スライス

最初の1 PR では、以下だけを実装する。

1. `knowledgeSource` 引き渡し修正。
2. CLI 既定実行を MCP host private request に寄せる設計を入れる。
3. `lookupFailureFirewallContext` 追加。
4. Agentic Search にはまだ接続せず、context service の unit test を作る。
5. docs から lifecycle 前提を消す。

この順番なら既存 review flow を壊さず、次の PR で Agentic Search / `review_task` に接続できる。
