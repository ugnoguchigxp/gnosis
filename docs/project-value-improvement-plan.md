# Project Value Improvement Plan

最終更新: 2026-05-06

## 目的

Gnosis の現在価値を、local-first な Agent-First MCP 基盤としてさらに引き上げる。

この計画は、既存の [Project Maturity Improvement Plan](project-maturity-improvement-plan.md) の後続計画として扱う。既存計画は `review_task` stub 解消、strict gate、docs drift 修復などの成熟度回復を主対象にしている。本計画は、2026-05-06 の価値評価で残った上限要因を、実装・検証・docs・運用サンプルまで落として解消する。

## 評価ベースライン

2026-05-06 時点の評価:

| 指標 | 現状評価 | 目標 |
| :--- | ---: | ---: |
| 総合価値 | 8.4 / 10 | 9.0 / 10 |
| 技術的独自性 | 8.5 / 10 | 9.0 / 10 |
| 実用価値 | 8.0 / 10 | 9.0 / 10 |
| 運用信頼性 | 8.6 / 10 | 9.2 / 10 |
| 製品成熟度 | 7.6 / 10 | 8.8 / 10 |
| 差別化 | 8.8 / 10 | 9.2 / 10 |
| 外部展開性 | 7.0 / 10 | 8.2 / 10 |

確認済みの強み:

- `bun run doctor` は `fail=0 warn=0` で、DB、Postgres container、embedding command、10件の LaunchAgent、local-llm health、直近 KnowFlow run を確認できる。
- `bun run monitor:snapshot -- --json` で `doctor`, `doctorStrict`, `smoke`, `verifyFast`, `verify`, `verifyStrict`, `mcpContract` が pass として観測できる。
- MCP primary surface は `initial_instructions / agentic_search / search_knowledge / record_task_note / review_task / doctor` の6件に整理されている。
- `review_task` は MCP timeout ではなく structured degraded JSON を返す実装になっている。
- Failure Firewall は新 primary tool を増やさず、`review_task` / `agentic_search` の補助 context として使う方向に整理されている。
- `agentic_search` の Phase 1 protocol 修復は 2026-05-06 に実装済みで、CLI smoke、MCP smoke、focused tests、`verify:fast` で確認済み。

残る上限要因:

- fresh clone から最小価値到達までの第三者実測が不足している。
- Monitor で `knowflow.status=healthy` でも failed task が残る場合の解釈が利用者に伝わりにくい。
- `review_task` / Failure Firewall の「価値が出た成功例」が smoke fixture と docs に固定されていない。
- quality gate は強いが、価値導線全体を検証する single scenario がまだ弱い。

## 改善方針

1. primary MCP tool は増やさない。
2. `agentic_search` のユーザー向け response schema は自然文のまま維持する。
3. degraded は成功扱いしない。fallback を返す場合も、限定回答であることを明示する。
4. fresh clone 価値は SaaS 化ではなく、local install、docs、runbook、smoke の再現性で上げる。
5. Failure Firewall は汎用レビューではなく、Golden Path 逸脱と再発検知に責務を限定する。
6. すべての評価更新は、実コマンド、MCP payload、Monitor snapshot、またはテストで裏付ける。

## Phase 1: `agentic_search` protocol 修復

目的: primary retrieval の信頼性を価値評価の最大減点から外す。

### 背景

実装前の `AgenticSearchRunner` は prefetch で `knowledge_search` と `brave_search` を実行し、その結果を `tool` role message として LLM history に積んでいた。2026-05-06 の MCP 実行では cloud provider が、この `tool` role message を直前の assistant `tool_calls` と対応していないものとして拒否した。

これは検索品質ではなく message protocol の問題である。`search_knowledge` raw 候補は返っているため、優先順位は retrieval 改善より protocol 整合性の修復を上に置く。

### 実装状況

2026-05-06 に完了済み。

- prefetch 結果は provider の `tool` role history ではなく、compact context message として渡す。
- native tool loop 内で LLM が返した `tool_calls` だけを `tool` role message に戻す。
- `AgenticLoopMessage` が assistant の `toolCalls` を保持し、`rawAssistantContent` と provider request の `raw` を対応させる。
- LLM adapter が provider 呼び出し前に orphan `tool` role message を検出し、provider 400 ではなく `invalid_agentic_tool_message_sequence` として扱う。
- structured `toolCalls` だけがある assistant message には OpenAI-compatible な `raw.tool_calls` を合成し、`tool_call_id` の親子関係を維持する。
- 現行 public surface を authoritative context として渡し、古い lifecycle 導線を含む prefetch knowledge は compact context から除外する。
- 最終回答が現行 public surface と矛盾する古い lifecycle 導線を含む場合は保存せず、現行方針に基づく限定回答へ切り替える。

確認済み gate:

```bash
bun test test/agenticSearch/runner.test.ts test/agenticSearch/llmAdapter.test.ts test/agentic-search-cli.test.ts test/mcp/tools/agentFirst.test.ts
bun run agentic-search -- --request "Gnosis の agentic_search 改善で守るべきルールを調べて" --intent plan --change-type mcp --json
bun run agentic-search:semantic-smoke
bun run doctor
bun test test/mcpContract.test.ts test/mcpToolsSnapshot.test.ts test/mcpHostServices.test.ts test/mcpStdioIntegration.test.ts
bun run verify:fast
```

MCP smoke では、stale host による `MCP_HOST_ERROR` を `launchctl kickstart -k gui/$UID/com.gnosis.mcp-host` で復旧した後、`agentic_search` が protocol error なしで自然文回答を返すことを確認した。

### 対象

- `src/services/agenticSearch/runner.ts`
- `src/services/agenticSearch/publicSurface.ts`
- `src/services/agenticSearch/llmAdapter.ts`
- `src/services/agenticCore/toolLoop.ts`
- `src/services/agenticSearch/types.ts`
- `test/agenticSearch/runner.test.ts`
- `test/agenticSearch/llmAdapter.test.ts`
- `test/agentic-search-cli.test.ts`
- `test/mcp/tools/agentFirst.test.ts`
- `docs/agentic-search-tool-layer-rebuild-plan.md`
- `docs/mcp-tools.md`

### 実装方針

この方針は Phase 1 実装後も regression rule として維持する。

1. prefetch 結果を provider に渡す履歴では、いきなり `tool` role にしない。
2. prefetch は次のどちらかに寄せる。
   - `system` または `user` message の compact context として渡す。
   - 直前に synthetic assistant `tool_calls` を置き、provider protocol と整合する `tool` message にする。
3. まずは実装と安全性が単純な compact context 方式を採用する。
4. native tool loop 内で LLM が返した tool call だけを `tool` role message にする。
5. provider adapter ごとに、送信直前の message sequence validation を入れる。
6. validation で protocol 不整合があれば LLM 呼び出し前に degraded とし、knowledge fallback を返す。
7. fallback は既存どおり自然文で、上位候補と `degradedReason` を含める。
8. 現行 public surface と矛盾する古い lifecycle knowledge は prompt context に入れず、件数だけを trace と compact context に残す。
9. 最終回答が現行 public surface と矛盾した場合は、回答保存を行わず、現行導線だけの限定回答を返す。

### 受け入れ条件

```bash
bun test test/agenticSearch/runner.test.ts test/agenticSearch/llmAdapter.test.ts test/agentic-search-cli.test.ts test/mcp/tools/agentFirst.test.ts
bun run agentic-search -- --request "Gnosis の agentic_search 改善で守るべきルールを調べて" --intent plan --change-type mcp --json
bun run agentic-search:semantic-smoke
```

MCP smoke:

```ts
await agentic_search({
  userRequest: 'Gnosis の project value 改善で優先すべきことを確認したい',
  repoPath: '/Users/y.noguchi/Code/gnosis',
  changeTypes: ['docs', 'mcp', 'review'],
  intent: 'plan',
});
```

期待:

- cloud provider が `tool role` protocol error を返さない。
- LLM finalization が失敗しても、`search_knowledge` 候補がある場合は限定回答を返す。
- semantic smoke が pass し、回答本文に deprecated lifecycle tool 名が混入しない。
- `agentic_search` が raw 候補を確定判断として扱わない。

## Phase 2: 価値導線 smoke の追加

目的: Gnosis の価値を「個別機能が動く」ではなく、「開発タスクの前後で知識が効く」単位で検証する。

### 価値導線

```text
doctor
  -> agentic_search
  -> review_task
  -> record_task_note candidate
  -> monitor:snapshot quality gate
```

### 対象

- `scripts/onboarding-smoke.ts`
- `scripts/smoke.ts`
- `scripts/verify.ts`
- `scripts/lib/quality-gates.ts`
- `test/mcp/tools/agentFirst.test.ts`
- `test/mcpStdioIntegration.test.ts`
- `test/reviewFailureFirewallContext.test.ts`
- `docs/release-checklist.md`

### 実装方針

1. `onboarding:smoke` は minimal 価値に限定する。
   - DB 接続
   - embedding command
   - primary 6 tool exposure
   - `search_knowledge` raw 候補または graceful empty
   - `record_task_note` dry-run 相当、または isolated note registration
2. `smoke` は primary value path を確認する。
   - `agentic_search` fallback 以上の回答
   - `review_task` が stub でないこと
   - `review_task` degraded 時は diagnostics を返すこと
   - `monitor:snapshot` が gate result を拾えること
3. `verify:strict` には重い live provider 依存を入れない。
4. cloud/local live smoke は env がある場合だけ実行し、ない場合は skipped と理由を記録する。
5. smoke fixture は Gnosis 固有の小さな実装計画または diff を使う。

### 受け入れ条件

```bash
bun run onboarding:smoke
bun run smoke
bun run verify:fast
GNOSIS_DOCTOR_STRICT=1 bun run doctor
```

期待:

- `logs/quality-gates.json` に onboarding, smoke, doctorStrict が残る。
- Monitor UI / snapshot で上記 gate を確認できる。
- provider 未設定が failure ではなく、期待された skipped/degraded として説明される。

## Phase 3: fresh clone 体験の実測と固定

目的: 外部展開性を上げる。第三者が clone 後に迷わず最小価値へ到達できる状態を作る。

### 対象

- `README.md`
- `docs/startup.md`
- `docs/no-local-llm-setup.md`
- `docs/configuration.md`
- `docs/release-checklist.md`
- `scripts/bootstrap.ts`
- `scripts/onboarding-smoke.ts`
- `.env.minimal`
- `.env.cloud-review`
- `.env.local-llm`

### 実装方針

1. fresh clone 手順を `minimal`, `cloud-review`, `local-llm` の3本に分ける。
2. 各構成で「使えるもの」「degraded になるもの」「optional なもの」を表にする。
3. `bootstrap` 後の next action を固定する。
   - `bun run doctor`
   - `bun run onboarding:smoke`
   - MCP client 登録
4. `cloud-review` は Azure OpenAI alias の env 名と timeout の説明を docs に寄せる。
5. `local-llm` は最初の価値確認には必須でないことを維持する。
6. fresh clone 実測は一時ディレクトリまたは clean worktree で行い、結果を release checklist に反映する。

### 受け入れ条件

```bash
git status --short
bun run bootstrap
bun run doctor
bun run onboarding:smoke
rg -n "TODO|存在しない|unavailable_in_minimal_mode" README.md docs
```

期待:

- README の全リンクが存在する。
- `minimal` で到達できる価値が明確。
- local LLM なしで失敗する項目が、正常な degraded / skipped として説明される。

## Phase 4: Monitor health 判定の精密化

目的: `healthy` と failed task の併存を利用者が正しく解釈できるようにする。

### 背景

2026-05-06 の snapshot では `knowflow.status` は `healthy` だったが、queue には failed task が残っていた。これは必ずしも runtime failure ではないが、UI や JSON の読み手には「本当に healthy なのか」が分かりにくい。

### 対象

- `src/scripts/monitor-snapshot.ts`
- `src/scripts/monitor-detail.ts`
- `src/scripts/knowflow-failure-report.ts`
- `apps/monitor/src/lib/monitor/types.ts`
- `apps/monitor/src/routes/+page.svelte`
- `docs/operations-runbook.md`
- `docs/knowflow-guide.md`

### 実装方針

1. runtime health と backlog health を分ける。
   - runtime: worker が動いているか、consecutive failure があるか。
   - backlog: failed / deferred / pending が運用上許容範囲か。
2. snapshot に `queueInterpretation` を追加する。
   - `status`: `clear | needs_attention | blocked`
   - `reason`
   - `nextCommand`
3. failed task があっても直近 worker success があり consecutive failure が 0 なら runtime は healthy とする。
4. 同じ topic の failed が繰り返される場合は backlog を `needs_attention` にする。
5. Monitor UI は green/yellow/red を runtime と backlog で分けて表示する。
6. runbook に `healthy with failed backlog` の解釈を追加する。

### 受け入れ条件

```bash
bun run monitor:snapshot -- --json
bun run monitor:knowflow-failures
bun run monitor:task-action -- --action retry --task-id <failed-task-id> --json
bun test test/monitorSnapshot.test.ts test/monitorQueueUtils.test.ts
bun run build
```

期待:

- failed task が残っている理由と次 command が snapshot から分かる。
- failed backlog の分類が `monitor:knowflow-failures` と `status-report` で一致する。
- 再試行が必要な failed/deferred task は `monitor:task-action` から新規 pending task として作れる。
- `healthy` が failed backlog を隠しているように見えない。
- Monitor UI の表示が runtime と backlog を混同しない。

## Phase 5: `review_task` / Failure Firewall 成功例の固定

目的: Gnosis の差別化である knowledge-aware review と再発防止を、誰でも再現できる形にする。

### 対象

- `test/reviewFailureFirewallContext.test.ts`
- `test/failureFirewall.test.ts`
- `test/failureFirewallLearningCandidates.test.ts`
- `test/mcp/tools/agentFirst.test.ts`
- `docs/failure-firewall.md`
- `docs/failure-firewall-active-use-plan.md`
- `docs/mcp-tools.md`
- `docs/release-checklist.md`
- `docs/examples/`

### 実装方針

1. `docs/examples/` を追加し、以下を置く。
   - `review-task-success.md`
   - `failure-firewall-success.md`
   - `agentic-search-success.md`
2. 各 example は次を含める。
   - 入力
   - 期待される出力要点
   - 使われる knowledge
   - degraded の場合の正常な読み方
   - 検証コマンド
3. Failure Firewall は dedicated pattern だけでなく ordinary `lesson / rule / procedure` 由来の context 例を含める。
4. raw lesson 由来 context は blocker ではなく `needs_confirmation` まで、という境界を example と test で固定する。
5. `review_task` の success example は provider live 依存を避け、mock または deterministic path で再現できるようにする。

### 受け入れ条件

```bash
bun test test/reviewFailureFirewallContext.test.ts test/failureFirewall.test.ts test/failureFirewallLearningCandidates.test.ts test/mcp/tools/agentFirst.test.ts
test -e docs/examples/review-task-success.md
test -e docs/examples/failure-firewall-success.md
test -e docs/examples/agentic-search-success.md
```

期待:

- Gnosis の価値を説明するときに、抽象説明ではなく再現可能な example を参照できる。
- Failure Firewall が汎用レビューと混ざらない。
- `review_task` と `agentic_search` の成功条件が docs と tests で一致する。

## Phase 6: value score gate の導入

目的: 「価値が上がった」という主張を主観で終わらせない。

### 対象

- `src/scripts/status-report.ts`
- `src/scripts/agentic-search-semantic-smoke.ts`
- `src/scripts/monitor-snapshot.ts`
- `scripts/lib/quality-gates.ts`
- `docs/project-value-improvement-plan.md`
- `docs/release-checklist.md`

### 実装方針

1. `bun run status-report` または新しい report mode で value score に必要な evidence をまとめる。
2. score は自動採点ではなく、評価材料の checklist として出す。
3. 出力項目:
   - primary 6 tool exposure
   - doctor result
   - smoke result
   - strict result
   - semantic agentic_search smoke
   - latest review_task smoke
   - Monitor queue interpretation
   - queue backlog classification
   - docs link check
   - known degraded reasons
4. `logs/quality-gates.json` と Monitor snapshot を参照し、手動評価の根拠を1コマンドで取得できるようにする。

### 受け入れ条件

```bash
bun run agentic-search:semantic-smoke
bun run status-report
bun run monitor:snapshot -- --json
```

期待:

- 最終評価更新時に、どの evidence で何点にしたか説明できる。
- degraded の残りが明示される。
- `missingEvidence` が空で、`semanticSmoke` が pass として記録される。
- queue failed backlog がある場合、`queueBacklog.failedReasonClasses` に主因分類が出る。
- release checklist と同じ観点で確認できる。

## 実装順序

| PR | 内容 | 完了 gate |
| :--- | :--- | :--- |
| PR 1 | `agentic_search` protocol 修復 | 完了済み。agenticSearch tests, CLI JSON smoke, MCP smoke, `verify:fast` |
| PR 2 | primary value path smoke 追加 | onboarding smoke, smoke, doctor strict |
| PR 3 | fresh clone docs / bootstrap 実測 | bootstrap, doctor, onboarding smoke, docs link check |
| PR 4 | Monitor health / backlog 解釈 | monitor snapshot, monitor tests, build |
| PR 5 | review_task / Failure Firewall 成功例 | focused tests, docs examples |
| PR 6 | value score evidence report | status report, monitor snapshot |
| PR 7 | 総合 gate と release checklist 更新 | verify, verify strict, release checklist |

## 完了判定

以下をすべて満たしたら、総合価値を 9.0 / 10 に更新できる。

```bash
git status --short
bun run doctor
GNOSIS_DOCTOR_STRICT=1 bun run doctor
bun run onboarding:smoke
bun run smoke
bun run verify:fast
bun run verify
bun run verify:strict
bun run monitor:snapshot -- --json
bun run status-report
```

MCP manual smoke:

1. `doctor` が primary 6 tools を返す。
2. `agentic_search` が protocol error なしで自然文回答または限定 fallback を返す。
3. `review_task` が stub ではなく review result または structured degraded result を返す。
4. `record_task_note` が isolated な再利用知識を保存できる。
5. `search_knowledge` が raw 候補確認用途として score と候補を返す。

Docs:

1. README の fresh clone 手順が実コマンドと一致する。
2. `minimal / cloud-review / local-llm` の違いが明確。
3. `docs/examples/*` で価値導線の成功例を再現できる。
4. `operations-runbook` が degraded、failed backlog、provider unavailable の読み方を説明している。

## リスクと対策

| リスク | 影響 | 対策 |
| :--- | :--- | :--- |
| `agentic_search` 修復が provider ごとの protocol 差分に膨らむ | PR が重くなる | prefetch compact context 方式を先に採用し、native tool call は loop 内だけに限定する。 |
| fallback が raw 候補を過信する | 誤回答 | fallback は限定回答として明記し、確定判断は LLM final answer または一次情報 fetch がある場合に限る。 |
| fresh clone 実測がローカル環境依存で不安定 | 外部展開性を測れない | minimal を local LLM 不要に保ち、cloud/local live は optional skipped として扱う。 |
| Monitor health が複雑化する | UI と運用が重くなる | runtime と backlog の2軸だけに限定し、分析 UI は後回しにする。 |
| Failure Firewall が汎用 review と混ざる | finding noise が増える | Golden Path 逸脱と再発検知に限定し、raw lesson は `needs_confirmation` までにする。 |

## 非目標

- primary MCP tool の増加。
- hosted SaaS 化。
- local LLM 必須化。
- Failure Firewall 専用の公開 MCP tool 追加。
- `agentic_search` のユーザー向け schema 拡張。
- Review / KnowFlow / Failure Firewall の全面再設計。
