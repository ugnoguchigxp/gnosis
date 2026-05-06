# Project Value Improvement Plan

最終更新: 2026-05-06

## 目的

Gnosis の価値評価で残った上限要因を、実装・検証・運用文言まで落として解消する。

この計画は「価値がある」ことを強く見せるための説明文書ではない。現在の証跡で言えること、まだ言えないこと、次にどの証跡を取れば評価を上げてよいかを固定するための実行計画である。

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

- MCP primary surface は `initial_instructions / agentic_search / search_knowledge / record_task_note / review_task / doctor` の6件に整理されている。
- `review_task` は旧 stub ではなく、provider / timeout / knowledge policy に応じて review result または structured degraded JSON を返す実装になっている。
- `agentic_search` は tool protocol の破綻時に raw 候補を確定知識として混ぜず、限定回答または degraded として扱う方針になっている。
- `bun run doctor`, `bun run monitor:snapshot -- --json`, `bun run status-report`, `bun run verify:fast` で、MCP、DB、quality gate、queue の状態を横断確認できる。
- README は minimal / local-llm / cloud-review の導線を分け、local LLM を最初の価値確認の必須条件にしていない。

残る上限要因:

- `review_task` は stub ではないが、local provider は 2026-05-06 の実測で 15秒 timeout により structured degraded になった。5分 timeout へ設定変更済みでも、まだ「local provider が即レビューを安定完走する」とは言えない。
- Monitor は `knowflow.status=healthy` と failed backlog が併存し得る。これは運用上あり得る状態だが、利用者には runtime が healthy なのか queue が要対応なのか分かりにくい。
- fresh clone から最小価値到達までの第三者実測が不足している。
- `review_task`, `agentic_search`, Failure Firewall の「価値が出た成功例」が docs と deterministic fixture に固定されていない。
- quality gate は強いが、価値導線全体を1本で説明する single scenario と evidence report がまだ弱い。

## 非主張

次の表現は、受け入れ条件を満たすまで README や評価メモで使わない。

| まだ言わない表現 | 代わりに使う表現 | 解禁条件 |
| :--- | :--- | :--- |
| `local review が安定して即完走する` | `local review は最大5分待ち、完走または structured degraded を返す` | local provider live smoke が3連続で300秒以内に review result を返す |
| `Monitor が healthy なので問題なし` | `runtime は healthy。failed backlog は別指標で確認する` | snapshot に runtime/backlog の2軸 interpretation が出る |
| `5分で価値到達できる` | `README 上の最短導線は5分到達を目標にしている` | clean clone 実測で bootstrap, doctor, onboarding smoke, MCP primary exposure が5分以内 |
| `Failure Firewall がレビュー品質を保証する` | `過去 lesson を補助 context として使い、再発リスクを surfaced する` | 成功例 fixture と review_task context 一致テストが揃う |

## Phase 1: `review_task` local provider の安定完走判定

目的: `review_task` を「stub ではない」から「local provider でも完走可否を実測で判断できる」状態に進める。

### 対象

- `src/mcp/tools/agentFirst.ts`
- `src/services/review/llm/localProvider.ts`
- `src/services/review/llm/reviewer.ts`
- `src/services/review/orchestrator.ts`
- `src/services/reviewAgent/documentReviewer.ts`
- `src/scripts/status-report.ts`
- `test/mcp/tools/agentFirst.test.ts`
- `test/review-foundation.test.ts`
- `docs/review-task-improvement-plan.md`
- `docs/mcp-tools.md`
- `docs/operations-runbook.md`

### 実装方針

1. MCP sync path の timeout 契約を固定する。
   - `GNOSIS_MCP_REVIEW_LLM_TIMEOUT_MS` default は `300000`。
   - `GNOSIS_MCP_HOST_REQUEST_TIMEOUT_MS` default は `330000`。
   - provider timeout は host timeout より短くする。
2. local provider preflight を review 本体の前に追加する。
   - launcher が存在する。
   - 5秒から10秒以内に空でない text response を返す。
   - parser/runtime error を stderr と exit status から分類する。
3. local timeout / unavailable / malformed output は MCP transport error ではなく structured degraded JSON にする。
4. degraded result は `reviewStatus: "needs_confirmation"` とし、clean pass として扱わない。
5. `status-report` に `reviewTask.localProvider` を追加する。
   - `lastStatus`: `ok | degraded | skipped | failed`
   - `durationMs`
   - `provider`
   - `degradedReasons`
   - `timeoutMs`
   - `evidenceCommand`
6. local provider live smoke は env が揃う場合だけ実行する。env 不足は failure ではなく `skipped` と reason にする。

### 受け入れ条件

```bash
bun test test/mcp/tools/agentFirst.test.ts test/review-foundation.test.ts
bun run verify:fast
bun run review:local-smoke
bun run status-report --json
```

Manual MCP smoke:

```ts
await review_task({
  provider: 'local',
  targetType: 'implementation_plan',
  target: { documentPath: 'docs/review-task-improvement-plan.md' },
  knowledgePolicy: 'best_effort',
});
```

期待:

- local provider が完走した場合は `status: "ok"` と review findings / summary を返す。
- timeout した場合でも MCP call 自体は timeout せず、`status: "degraded"` と `diagnostics.timeoutMs` を返す。
- degraded result は `reviewStatus: "needs_confirmation"` になる。
- local LLM 子プロセスが timeout 後に残らない。
- 3連続 live smoke が300秒以内に `status: "ok"` を返すまで、「local provider は安定完走」と表現しない。

## Phase 2: Monitor の runtime health と backlog health を分離

目的: `knowflow.status=healthy` と failed backlog の併存を、利用者が正しく読める状態にする。

### 対象

- `src/scripts/monitor-snapshot.ts`
- `src/scripts/status-report.ts`
- `src/scripts/knowflow-failure-report.ts`
- `src/scripts/monitor-detail.ts`
- `apps/monitor/src/lib/monitor/types.ts`
- `apps/monitor/src/routes/+page.svelte`
- `test/statusReport.test.ts`
- `docs/operations-runbook.md`
- `docs/knowflow-guide.md`

### 実装方針

1. `knowflow.status` は runtime の生存性として扱う。
   - worker success が直近にある。
   - consecutive runtime failure が許容範囲内。
   - queue 処理が完全停止していない。
2. failed backlog は別の `queueBacklog.status` として扱う。
   - `clear`: failed/deferred がない。
   - `needs_attention`: failed があるが runtime は動いている。
   - `blocked`: 同一 reason が反復し、再試行しても進んでいない。
3. snapshot に `queueInterpretation` を追加する。
   - `runtimeStatus`
   - `backlogStatus`
   - `failedCount`
   - `failedReasonClasses`
   - `humanSummary`
   - `nextCommand`
4. `status-report` と `monitor:knowflow-failures` の分類ロジックを揃える。
5. Monitor UI は runtime と backlog を別行または別 badge で表示する。
6. runbook では `healthy with failed backlog` を正常系の一種として説明し、放置してよい状態とは書かない。

### 受け入れ条件

```bash
bun run monitor:snapshot -- --json
bun run status-report --json
bun run monitor:knowflow-failures -- --json
bun test test/statusReport.test.ts
bun run build
```

期待:

- `knowflow.status=healthy` でも failed backlog がある場合、JSON 上で `backlogStatus: "needs_attention"` と読める。
- failed reason が `llm_provider_unavailable`, `timeout`, `payload_invalid`, `system_error`, `unknown` のような運用分類で出る。
- 次に実行すべき command が `nextCommand` に出る。
- UI と JSON の解釈が一致する。

## Phase 3: project value evidence register

目的: 価値評価を、印象ではなく evidence の有無で更新できるようにする。

### 対象

- `src/scripts/status-report.ts`
- `src/scripts/monitor-snapshot.ts`
- `scripts/lib/quality-gates.ts`
- `scripts/onboarding-smoke.ts`
- `docs/project-value-improvement-plan.md`
- `docs/operations-runbook.md`

### 実装方針

`status-report --json` に `projectValueEvidence` を追加する。

| evidence | 取得元 | pass 条件 |
| :--- | :--- | :--- |
| `primaryTools` | MCP tools/list または doctor | primary 6 tools が欠落なし |
| `reviewTaskLocal` | live smoke または skipped reason | ok または reason 付き skipped/degraded |
| `reviewTaskDegradedSemantics` | focused tests | degraded が `needs_confirmation` 扱い |
| `monitorBacklogInterpretation` | monitor snapshot | runtime/backlog が2軸で出る |
| `freshCloneValueArrival` | clean clone smoke artifact | 5分以内または超過理由あり |
| `successExamples` | docs/examples と tests | deterministic fixture が存在し通る |
| `docsLinks` | README/docs link check | リンク切れなし |

出力例:

```json
{
  "projectValueEvidence": {
    "scoreReady": false,
    "missingEvidence": ["freshCloneValueArrival", "reviewTaskLocalStableOk"],
    "reviewTaskLocal": {
      "status": "degraded",
      "claimAllowed": "structured_degraded_only"
    }
  }
}
```

### 受け入れ条件

```bash
bun run status-report --json
bun run monitor:snapshot -- --json
```

期待:

- 価値評価を上げられない理由が `missingEvidence` として出る。
- degraded が残っている場合、どの claim を抑えるべきか分かる。
- 手動評価メモが `status-report` の evidence と矛盾しない。

## Phase 4: fresh clone 5分価値到達の実測固定

目的: README の「5分で最小起動」を外部展開性の実測にする。

### 対象

- `README.md`
- `docs/startup.md`
- `docs/no-local-llm-setup.md`
- `docs/configuration.md`
- `scripts/bootstrap.ts`
- `scripts/onboarding-smoke.ts`
- `scripts/fresh-clone-value-smoke.ts`

### 実装方針

1. clean clone 用の smoke script を追加する。
   - 一時ディレクトリに clone する。
   - `bun install` または既存 lockfile 前提の install を実行する。
   - `bun run bootstrap`
   - `bun run doctor`
   - `bun run onboarding:smoke`
   - primary MCP tool exposure を確認する。
2. 測定結果を `logs/fresh-clone-value-smoke.json` に保存する。
   - `totalDurationMs`
   - `stepDurations`
   - `environment`
   - `skippedOptionalSteps`
   - `failureReason`
3. `minimal` は local LLM 不要のまま維持する。
4. `cloud-review` と `local-llm` は optional route とし、5分到達の必須条件にしない。
5. 5分を超えた場合は README から断定表現を落とし、実測値を更新する。

### 受け入れ条件

```bash
bun run fresh-clone:value-smoke
bun run onboarding:smoke
bun run doctor
```

期待:

- clean clone で minimal value path が5分以内に終わる、または超過理由が artifact に残る。
- README の最短導線と smoke script の手順が一致する。
- 第三者が local LLM なしで最小価値に到達できる。

## Phase 5: 成功例 fixture と docs examples の固定

目的: Gnosis の価値を、抽象説明ではなく再現可能な成功例で示す。

### 対象

- `docs/examples/agentic-search-success.md`
- `docs/examples/review-task-success.md`
- `docs/examples/failure-firewall-success.md`
- `test/mcp/tools/agentFirst.test.ts`
- `test/reviewFailureFirewallContext.test.ts`
- `test/failureFirewall.test.ts`
- `test/failureFirewallLearningCandidates.test.ts`

### 実装方針

1. `agentic_search` の成功例は raw 候補一覧ではなく、作業判断に使える自然文回答を固定する。
2. `review_task` の成功例は provider live 依存を避け、deterministic fixture で `knowledgeUsed` と review context の一致を確認する。
3. Failure Firewall の成功例は専用 tool ではなく、既存 lesson / rule / procedure が review context に効く形で固定する。
4. degraded 例も成功例と並べる。
   - timeout は `needs_confirmation`。
   - raw candidate は未選別なら review finding にしない。
   - provider unavailable は setup 問題として説明する。

### 受け入れ条件

```bash
test -e docs/examples/agentic-search-success.md
test -e docs/examples/review-task-success.md
test -e docs/examples/failure-firewall-success.md
bun test test/mcp/tools/agentFirst.test.ts test/reviewFailureFirewallContext.test.ts test/failureFirewall.test.ts test/failureFirewallLearningCandidates.test.ts
```

期待:

- 価値説明に使う example が実装と一致する。
- `review_task` の `knowledgeUsed` が実 prompt/context と一致する。
- Failure Firewall が汎用レビュー finding を増やす仕組みとして誤解されない。

## Phase 6: release 前の価値評価 gate

目的: 9.0 / 10 へ評価を上げる判断を、実測 gate に接続する。

### 実行順

```bash
bun run doctor
GNOSIS_DOCTOR_STRICT=1 bun run doctor
bun run onboarding:smoke
bun run smoke
bun run verify:fast
bun run verify
bun run monitor:snapshot -- --json
bun run status-report --json
```

任意 live smoke:

```ts
await agentic_search({
  userRequest: 'Gnosis の project value 改善で優先すべきことを確認したい',
  repoPath: '/Users/y.noguchi/Code/gnosis',
  changeTypes: ['docs', 'mcp', 'review'],
  intent: 'plan'
});

await review_task({
  provider: 'local',
  targetType: 'implementation_plan',
  target: { documentPath: 'docs/project-value-improvement-plan.md' },
  knowledgePolicy: 'best_effort'
});
```

### 評価更新条件

総合価値を 9.0 / 10 に更新できる条件:

- `review_task` が stub ではないことに加え、local provider の live smoke 結果または degraded reason が `status-report` に残る。
- `review_task` local provider を「安定完走」と表現する場合は、3連続 live smoke が300秒以内に `status: "ok"`。
- Monitor snapshot で runtime health と backlog health が分離している。
- failed backlog がある場合も reason class と next command が表示される。
- fresh clone 価値到達の artifact が存在する。
- `docs/examples/*` の成功例と focused tests が一致する。
- README の claims が evidence register と矛盾しない。

## 実装順序

| PR | 内容 | 完了 gate |
| :--- | :--- | :--- |
| PR 1 | `review_task` local provider evidence と status-report 追加 | focused tests, `verify:fast`, `bun run review:local-smoke` artifact |
| PR 2 | Monitor runtime/backlog 2軸 interpretation | monitor snapshot, status-report, monitor tests, build |
| PR 3 | project value evidence register | status-report JSON, operations runbook |
| PR 4 | fresh clone value smoke | clean clone artifact, README/startup docs |
| PR 5 | success examples と deterministic fixtures | examples existence, focused review tests |
| PR 6 | release 前 value gate 固定 | doctor strict, verify, status-report |

## リスクと対策

| リスク | 影響 | 対策 |
| :--- | :--- | :--- |
| local provider が5分でも安定しない | `review_task` の実用価値が過大評価になる | structured degraded を正式成功ではなく `needs_confirmation` として扱い、queued review は別計画に分ける |
| Monitor の表示が複雑化する | 利用者がさらに混乱する | runtime/backlog の2軸だけに絞り、原因分析 UI は後段にする |
| fresh clone 実測がローカル環境依存でぶれる | 外部展開性の証跡にならない | artifact に環境情報と step duration を保存し、local LLM は optional に保つ |
| 成功例が provider live 依存になる | fixture が不安定になる | deterministic fixture と live smoke を分ける |
| README が実測より強い表現になる | 価値評価が信用を失う | evidence register の `claimAllowed` に合わせて文言を制限する |

## 非目標

- primary MCP tool の追加。
- hosted SaaS 化。
- local LLM 必須化。
- Failure Firewall 専用の公開 MCP tool 追加。
- `agentic_search` のユーザー向け response schema 拡張。
- `review_task` の degraded を clean pass として扱うこと。
