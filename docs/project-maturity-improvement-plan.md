# Gnosis Project Maturity Improvement Plan

最終更新: 2026-05-05

## 実装状況

2026-05-05 の初期実装で、`review_task` stub 解消、`agentic_search` knowledge fallback、`smoke` 修復、strict doctor gate、Monitor quality gate 表示、README/docs 実体化を反映した。以後の運用 gate は [Release Checklist](release-checklist.md) と [Operations Runbook](operations-runbook.md) に集約する。

## 目的

現在評価の弱点である以下を、実装と検証で大幅に引き上げる。

| 指標 | 現状 | 目標 |
| :--- | ---: | ---: |
| 運用信頼性 | 7.0 / 10 | 9.0 / 10 |
| 外部配布 / 製品成熟度 | 5.5 / 10 | 8.5 / 10 |
| 総合 | 7.5 / 10 | 8.8 / 10 |

この計画は SaaS 化を目的にしない。Gnosis の価値は local-first な Agent-First MCP、知識検索、レビュー、KnowFlow、Monitor を手元で安定運用できることにある。外部配布成熟度は「第三者が fresh clone から迷わず最小価値へ到達でき、公開ドキュメントと実装が一致している状態」と定義する。

## 現状ベースライン

2026-05-05 時点の確認結果。

| 項目 | 状態 | 評価への影響 |
| :--- | :--- | :--- |
| `bun run doctor` | `fail=0 warn=0`。DB、Postgres container、embedding command、LaunchAgent 10/10、local-llm health、直近 KnowFlow run を確認できる。 | 強いプラス。運用状態の可視化は既に実用域。 |
| `bun run onboarding:smoke` | 成功。 | fresh clone 最小導線の土台はある。 |
| `bun run verify:fast` | 成功。491 pass / 21 skip / 0 fail。 | 通常開発の品質ゲートは強い。 |
| `bun run smoke` | 失敗。`scripts/smoke.ts` が廃止済み `--max-degraded-rate` を `eval-run` に渡している。 | strict gate を信用できない。運用信頼性の主減点。 |
| MCP `review_task` | `{"status":"unavailable_in_minimal_mode"}` を返す stub。 | README / docs と実装が矛盾。製品成熟度の主減点。 |
| MCP `agentic_search` | 一部 query で `search_knowledge` は有効候補を返すが `agentic_search` は「結果が見つかりませんでした」。 | primary retrieval として弱い。 |
| README / docs | 存在しない docs link がある。`review_task` 説明も実装と矛盾。 | 外部配布成熟度を下げる。 |
| Monitor UI | Tauri + SvelteKit 実装があり build も通る。 | 運用価値の強み。ただし gate と runbook 連携を強化する余地あり。 |

## 改善方針

1. 公開面は必ず実装と一致させる。
2. `verify:strict` に含まれる gate は壊れたままにしない。
3. MCP の live 挙動はコード推測ではなく、実 tool call と `doctor` で検証する。
4. degraded / timeout / LLM failure は成功扱いしない。ユーザーには `needs_confirmation` または明示的な degraded 診断として返す。
5. local-first を維持する。CI や SaaS 前提の都合で CLI / MCP の通常利用を難しくしない。
6. primary MCP surface は増やさない。`initial_instructions / agentic_search / search_knowledge / record_task_note / review_task / doctor` の6件を維持する。

## Phase 0: 評価基準と現状差分を固定する

目的: 改善の成功条件を曖昧にしない。

対象ファイル:

- `docs/project-maturity-improvement-plan.md`
- `README.md`
- `docs/mcp-tools.md`
- `scripts/smoke.ts`
- `scripts/verify.ts`
- `scripts/doctor.ts`
- `src/mcp/tools/agentFirst.ts`
- `test/mcpContract.test.ts`
- `test/mcpToolsSnapshot.test.ts`

実装:

1. `docs/project-maturity-improvement-plan.md` を追加する。
2. スコア更新基準を下表で固定する。
3. 着手前に以下を実行し、結果を作業ログに残す。

```bash
git status --short
bun run doctor
bun run onboarding:smoke
bun run smoke
bun run verify:fast
```

スコア更新基準:

| 指標 | 9点相当の条件 |
| :--- | :--- |
| 運用信頼性 | `doctor`, `onboarding:smoke`, `smoke`, `verify:strict` が目的通り通る。MCP host freshness、LaunchAgent、DB、local-llm、KnowFlow queue の状態を CLI と Monitor で確認できる。 |
| 外部配布 / 製品成熟度 | README の手順が fresh clone で再現できる。存在しない docs link がない。primary MCP tools は docs 通りに動く。minimal / local-llm / cloud-review の違いが明確。 |
| 総合 | primary value path が `doctor -> agentic_search -> review_task -> record_task_note -> Monitor` として説明・実行・検証できる。 |

受け入れ条件:

- 計画書が現在の実装差分を明記している。
- 以降の Phase が PR 単位で切れる。
- 「評価が上がった」と言うための gate がコマンドで定義されている。

## Phase 1: strict gate と公開ドキュメントの真実性を回復する

目的: 運用信頼性を 7.0 から 8.0 以上へ戻す最短ブロッカーを潰す。

### 1.1 `bun run smoke` の破損修復

対象:

- `scripts/smoke.ts`
- `src/services/knowflow/cli.ts`
- `src/services/knowflow/eval/runner.ts`
- `test/knowflow/evalRunner.test.ts`
- 必要なら `test/scripts` に smoke 専用テストを追加

実装方針:

1. `scripts/smoke.ts` から廃止済み `--max-degraded-rate` を削除する。
2. `eval-run` が pass/fail だけで品質判断する現方針を維持する。
3. warning を gate にしたい場合は `--max-warning-case-rate` のような現行 runner の `warningCaseRate` に合う新オプションを別 PR で追加する。古い degraded-rate 名は復活させない。
4. `bun run smoke` のテストを追加し、CLI option drift を検知できるようにする。

受け入れ条件:

```bash
bun run smoke
bun run verify:strict
```

少なくとも `smoke` step が廃止オプションで失敗しない。

### 1.2 README / docs の drift 修正

対象:

- `README.md`
- `docs/mcp-tools.md`
- `docs/startup.md`
- `docs/configuration.md`
- 必要に応じて以下を新規作成またはリンク削除
  - `docs/data-layers.md`
  - `docs/knowflow-guide.md`
  - `docs/agent-first-gnosis-refactoring-plan.md`

実装方針:

1. README の品質チェック説明を `scripts/verify.ts` の実装に合わせる。現行 `verify:fast` は test も含むため、README の `verify:fast` 説明を修正する。
2. 存在しない docs link は作るか削除する。外部配布向けには削除より、薄い実態ベース doc を作る方がよい。
3. `review_task` が stub の間は「利用可能」と書かない。Phase 2 完了時に実装済み説明へ戻す。
4. `agentic_search` の期待値は、実際に CLI / MCP smoke で確認できる query に限定して記述する。

受け入れ条件:

```bash
rg -n "docs/data-layers.md|docs/knowflow-guide.md|docs/agent-first-gnosis-refactoring-plan.md" README.md docs
test -e docs/data-layers.md
test -e docs/knowflow-guide.md
test -e docs/agent-first-gnosis-refactoring-plan.md
bun run verify:fast
```

## Phase 2: MCP `review_task` を実用導線へ戻す

目的: 製品成熟度の最大減点を解消する。`review_task` を primary tool として残すなら、stub ではなく短時間に実結果または degraded JSON を返す必要がある。

対象:

- `src/mcp/tools/agentFirst.ts`
- `src/services/review/orchestrator.ts`
- `src/services/reviewAgent/documentReviewer.ts`
- `src/services/review/cli.ts`
- `src/services/review/llm/reviewer.ts`
- `src/services/review/llm/localProvider.ts`
- `src/services/review/llm/cloudProvider.ts`
- `test/mcp/tools/agentFirst.test.ts`
- `test/review-orchestrator.test.ts`
- `test/review-cli.test.ts`
- `docs/mcp-tools.md`
- `docs/review-task-improvement-plan.md`

実装方針:

1. `reviewTaskSchema` を docs に合わせる。
   - `provider?: local | openai | bedrock | azure-openai`
   - `reviewMode?: fast | standard | deep`
   - `goal?: string`
   - `knowledgePolicy?: off | best_effort | required`
   - `repoPath?: string`
   - `mode?: worktree | git_diff`
2. `targetType=code_diff` は既存 `runReviewAgentic()` に接続する。
3. `targetType=document | implementation_plan | spec | design` は `reviewDocument()` または既存 document/spec/plan review 経路へ接続する。
4. MCP sync path では provider timeout を host timeout より短く制限する。
5. provider 未設定時の方針を1つに固定する。
   - minimal では `provider=local` を既定にし、local preflight 失敗時は degraded JSON。
   - cloud-review 設定がある場合だけ Azure OpenAI alias を使う。
   - `provider=openai` は docs 通り Azure OpenAI alias として扱う。
6. LLM timeout / unavailable / unparseable は MCP timeout にせず、必ず structured result を返す。
7. `knowledgePolicy=off` では knowledge retrieval を呼ばない。
8. `knowledgePolicy=best_effort` では retrieval failure を degraded reason として返し、未選別候補をレビュー本文に混ぜない。
9. `knowledgePolicy=required` では retrieval failure を `needs_confirmation` または review failure として扱う。

MCP 出力契約:

```ts
type ReviewTaskMcpResult = {
  status: "no_major_findings" | "needs_confirmation" | "changes_requested" | "degraded";
  findings: Array<{
    title: string;
    severity: "error" | "warning" | "info";
    filePath?: string;
    line?: number;
    rationale: string;
    suggestedFix?: string;
  }>;
  summary: string;
  knowledgeUsed: string[];
  diagnostics: {
    providerUsed: string;
    degradedReasons: string[];
    durationMs: number;
  };
};
```

受け入れ条件:

```bash
bun test test/mcp/tools/agentFirst.test.ts test/review-orchestrator.test.ts test/review-cli.test.ts
bun run doctor
```

Manual MCP smoke:

1. `doctor` が exposedToolCount 6, missingPrimaryTools [] を返す。
2. `review_task` with `targetType=document`, `knowledgePolicy=off`, invalid local provider state が MCP timeout ではなく degraded JSON を返す。
3. `review_task` with `targetType=implementation_plan`, `knowledgePolicy=best_effort` が findings または no-major-findings を返す。
4. `review_task` が `unavailable_in_minimal_mode` を返さない。

Phase 2 完了時の評価見込み:

- 運用信頼性: 8.3 / 10
- 外部配布 / 製品成熟度: 7.0 / 10
- 総合: 8.1 / 10

## Phase 3: `agentic_search` の「候補ありなのに無回答」を潰す

目的: primary retrieval の実用価値を上げる。

対象:

- `src/services/agenticSearch/runner.ts`
- `src/services/agenticSearch/llmAdapter.ts`
- `src/services/agenticSearch/tools/knowledgeSearch.ts`
- `src/services/agenticSearch/systemContext.ts`
- `src/services/agenticSearch/toolContext.ts`
- `src/scripts/agentic-search.ts`
- `test/agenticSearch/runner.test.ts`
- `test/agentic-search-cli.test.ts`
- `test/mcp/tools/agentFirst.test.ts`

実装方針:

1. `knowledge_search` prefetch が有効候補を返しているのに LLM が空応答または loop failure になった場合、単に「結果が見つかりませんでした」と返さない。
2. fallback は schema を増やさず、自然文で短く返す。
3. fallback 文には次を含める。
   - LLM finalization が失敗したこと。
   - knowledge search で見つかった上位候補の title /要点。
   - その候補が十分な根拠か、追加確認が必要か。
4. `agentic_search` の MCP response は自然文のまま維持する。詳細 trace は CLI `--json` のみ。
5. `search_knowledge` と `agentic_search` の乖離を regression test にする。

受け入れテスト例:

```ts
await agentic_search({
  userRequest: "review_task の既定 provider 方針を確認したい",
  repoPath: "/Users/y.noguchi/Code/gnosis",
  changeTypes: ["mcp", "review", "config"],
  technologies: ["Azure OpenAI", "MCP"],
  intent: "review"
});
```

期待:

- `search_knowledge` が関連 decision を返すケースで、`agentic_search` が単なる「結果なし」にならない。
- LLM が失敗しても、上位 knowledge に基づく限定的な回答または明示的な degraded 診断を返す。
- 未選別 raw 候補を「確定判断」として扱わない。

検証:

```bash
bun test test/agenticSearch/runner.test.ts test/agentic-search-cli.test.ts test/mcp/tools/agentFirst.test.ts
bun run agentic-search -- --request "review_task の既定 provider 方針を確認したい" --intent review --change-type mcp --change-type review --technology "Azure OpenAI" --json
```

Phase 3 完了時の評価見込み:

- 運用信頼性: 8.6 / 10
- 外部配布 / 製品成熟度: 7.4 / 10
- 総合: 8.3 / 10

## Phase 4: 運用 health を `doctor` / Monitor / strict verify に統合する

目的: 「動いているつもり」をなくし、通常運用で問題を発見できる状態にする。

対象:

- `scripts/doctor.ts`
- `src/services/agentFirst.ts`
- `src/scripts/monitor-snapshot.ts`
- `src/scripts/monitor-detail.ts`
- `src/scripts/monitor-task-actions.ts`
- `apps/monitor/src/routes/+page.svelte`
- `apps/monitor/src/routes/ops/+page.svelte`
- `apps/monitor/src/lib/monitor/types.ts`
- `apps/monitor/src-tauri/src/monitor/commands.rs`
- `scripts/verify.ts`
- `scripts/test-integration-local.ts`

実装方針:

1. 通常 `doctor` は速いままにする。
2. `doctor --strict` または `GNOSIS_DOCTOR_STRICT=1` で以下を追加確認する。
   - `bun run smoke` 相当の dry-run 経路
   - MCP `review_task` lightweight smoke
   - MCP `agentic_search` lightweight smoke
   - local-llm preflight
   - embedding daemon health
   - stale host source fingerprint
3. Monitor snapshot に gate status を追加する。
   - `doctor`
   - `onboardingSmoke`
   - `smoke`
   - `verifyFast`
   - `lastStrictVerify`
4. Monitor UI で gate failure と next command を表示する。
5. `src/scripts/monitor-detail.ts` と `src/scripts/monitor-task-actions.ts` の `any[]` warning を解消する。
6. `verify:strict` は遅くてもよいが、失敗理由が action-oriented になるようにする。

受け入れ条件:

```bash
bun run doctor
GNOSIS_DOCTOR_STRICT=1 bun run doctor
bun run monitor:snapshot
bun run verify:strict
```

Monitor UI acceptance:

- Gate の green/yellow/red が一画面で見える。
- red の場合、次に実行すべき command が表示される。
- KnowFlow queue / embedding queue / local-llm / LaunchAgent / MCP host が別々に見える。

Phase 4 完了時の評価見込み:

- 運用信頼性: 9.0 / 10
- 外部配布 / 製品成熟度: 7.8 / 10
- 総合: 8.5 / 10

## Phase 5: 外部配布向けの最小価値導線を固める

目的: fresh clone 利用者が「何を入れれば何ができるか」を迷わず判断できる状態にする。

対象:

- `README.md`
- `docs/startup.md`
- `docs/no-local-llm-setup.md`
- `docs/configuration.md`
- `docs/mcp-tools.md`
- `docs/data-layers.md`
- `docs/knowflow-guide.md`
- `docs/agent-first-gnosis-refactoring-plan.md`
- `.env.minimal`
- `.env.local-llm`
- `.env.cloud-review`
- `scripts/bootstrap.ts`
- `scripts/bootstrap-local-llm.ts`
- `scripts/setup-automation.sh`
- `scripts/onboarding-smoke.ts`

実装方針:

1. README の冒頭を次の3導線に整理する。
   - minimal: DB + embedding + primary MCP + search/save
   - cloud-review: minimal + cloud reviewer + `review_task`
   - local-llm: minimal + local LLM + KnowFlow/review advanced
2. 各導線に「使える tool」と「使えない tool」を明記する。
3. `review_task` が cloud/local 設定なしで degraded JSON を返すなら、README はそれを正常な minimal 挙動として説明する。
4. `scripts/bootstrap.ts` の最後に `doctor` と `onboarding:smoke` の次 action を出す現在方針を維持する。
5. `scripts/setup-automation.sh status` の出力を README に載せる。
6. 外部配布向けに `docs/release-checklist.md` を追加する。

`docs/release-checklist.md` の内容:

- fresh clone check
- minimal check
- cloud-review check
- local-llm check
- LaunchAgent install/load/status/unload check
- MCP host live check
- Monitor build and smoke
- known limitations
- rollback commands

受け入れ条件:

```bash
bun run bootstrap
bun run doctor
bun run onboarding:smoke
bun run verify:fast
rg -n "unavailable_in_minimal_mode|docs/data-layers.md|docs/knowflow-guide.md" README.md docs
```

期待:

- README に存在しないリンクがない。
- README の `review_task` 説明が実装と一致している。
- local LLM なしでも価値確認できる範囲が明確。

Phase 5 完了時の評価見込み:

- 運用信頼性: 9.0 / 10
- 外部配布 / 製品成熟度: 8.5 / 10
- 総合: 8.8 / 10

## Phase 6: 回帰防止と運用 runbook 化

目的: 一度上げた成熟度を保つ。

対象:

- `scripts/verify.ts`
- `scripts/smoke.ts`
- `scripts/onboarding-smoke.ts`
- `scripts/test-flaky-check.ts`
- `scripts/test-integration-local.ts`
- `test/mcpContract.test.ts`
- `test/mcpToolsSnapshot.test.ts`
- `test/mcpStdioIntegration.test.ts`
- `test/mcpHostServices.test.ts`
- `docs/release-checklist.md`
- `docs/operations-runbook.md`

実装方針:

1. `test/mcpToolsSnapshot.test.ts` に `review_task` schema hash drift を明示的に固定する。
2. `test/mcpContract.test.ts` で `review_task` が stub ではないことを確認する。
3. `scripts/smoke.ts` は CLI option drift を起こさないよう、直接 command 配列だけでなく runner API の unit test も追加する。
4. DB-heavy integration は通常 verify と切り離しつつ、`verify:strict` では1本の isolated path にする。
5. `docs/operations-runbook.md` を追加し、以下の障害別に診断順序を書く。
   - MCP tool timeout
   - stale host
   - local LLM down
   - embedding daemon down
   - DB connection failure
   - KnowFlow queue stuck
   - Monitor snapshot stale
6. live MCP 修正後は、必ず以下を実行する運用ルールにする。

```bash
bun run doctor
bun test test/mcpContract.test.ts test/mcpToolsSnapshot.test.ts test/mcpHostServices.test.ts test/mcpStdioIntegration.test.ts
```

受け入れ条件:

- public MCP tool の stub 化が test で落ちる。
- smoke option drift が test で落ちる。
- runbook の各障害に `symptom -> command -> expected -> fix` がある。

## 実装順序

| PR | 内容 | 完了 gate |
| :--- | :--- | :--- |
| PR 1 | `smoke` 修復、README の明らかな drift 修正 | `bun run smoke`, `bun run verify:fast` |
| PR 2 | `review_task` MCP schema と handler 接続 | focused tests, manual MCP smoke |
| PR 3 | review timeout/degraded handling と provider preflight | `review_task` degraded smoke |
| PR 4 | `agentic_search` fallback と regression tests | agenticSearch tests, CLI JSON smoke |
| PR 5 | `doctor --strict` と Monitor gate status | doctor strict, monitor snapshot |
| PR 6 | missing docs / release checklist / runbook | link checks, verify:fast |
| PR 7 | `verify:strict` 完全回復と integration isolation | `bun run verify:strict` |

## 完了判定

以下をすべて満たしたら、評価を更新できる。

```bash
git status --short
bun run doctor
GNOSIS_DOCTOR_STRICT=1 bun run doctor
bun run onboarding:smoke
bun run smoke
bun run verify:fast
bun run verify:strict
bun test test/mcpContract.test.ts test/mcpToolsSnapshot.test.ts test/mcpHostServices.test.ts test/mcpStdioIntegration.test.ts
```

Manual MCP:

1. `doctor` が primary 6 tools を返す。
2. `agentic_search` が既知の Gnosis 方針 query に自然文で答える。
3. `search_knowledge` が raw 候補と telemetry を返す。
4. `review_task` が stub ではなく review result または degraded result を返す。
5. `record_task_note` が検証済み知識を保存できる。

Docs:

1. README の全リンクが存在する。
2. README の tool 説明が実装と一致する。
3. minimal / cloud-review / local-llm の違いが明確。
4. known limitations が明記されている。

## リスクと対策

| リスク | 影響 | 対策 |
| :--- | :--- | :--- |
| `review_task` 修復が LLM/provider 問題に巻き込まれる | MCP timeout 再発 | sync path は短い timeout と degraded JSON を必須にする。local/cloud live は strict/preflight に分離する。 |
| `agentic_search` fallback が raw 候補を過信する | 誤回答 | fallback は「限定的な候補」と明記し、確定判断は LLM または追加 fetch がある場合に限る。 |
| `verify:strict` が重くなりすぎる | 日常開発が遅くなる | 日常は `verify:fast`、release/成熟度確認は `verify:strict` に分離する。 |
| 外部配布対応が SaaS 化に膨らむ | local-first 価値が薄れる | 配布成熟度は fresh clone / docs / local install / runbook に限定する。 |
| Monitor 機能が増えて複雑化する | UI と保守負荷が増える | Gate status と action command を優先し、分析 UI の追加は後回しにする。 |

## 非目標

- hosted SaaS 化。
- primary MCP tool の増加。
- local LLM 必須化。
- CI 前提で CLI の通常動作を厳しくすること。
- Review / KnowFlow / Failure Firewall の全面再設計。
