# review_task 改善計画

## 背景

Codex 再起動後の MCP smoke test では、`initial_instructions`, `doctor`, `search_knowledge`, `agentic_search`, `record_task_note` は呼び出し可能だった。一方で `review_task` は実用状態ではなかった。

- `provider` 未指定の `review_task` が単体 OpenAI として解決され、Azure OpenAI しか設定していない環境で `OPENAI_API_KEY` 不在により失敗した。
- `provider: local` でも MCP call が 120 秒で timeout した。
- `useKnowledge: false` でも timeout したため、原因は agentic_search 連携ではなく local review LLM 実行経路にある。
- `agentic_search` は Gemma4 timeout 時に `degraded` + `usedKnowledge: []` を返し、未フィルター候補を注入しない安全側の挙動になっている。
- `scripts/bonsai` は現環境で `1-bit Bonsai requires the PrismML MLX fork` により失敗するため、bonsai fallback は現時点では安定経路として扱えない。

この計画の目的は、`review_task` を「MCP から呼ぶと、失敗時も理由付きで短時間に返る」状態に戻し、agentic_search で採用した知識だけが実レビューに入ることを検証可能にすること。

## 原則

1. `review_task` の既定 review LLM は Azure OpenAI とする。
2. `provider: openai` は Azure OpenAI alias として扱い、単体 OpenAI API は review 経路で使わない。
3. Local LLM を明示指定した場合、遅い/壊れている状態でも MCP call を timeout させず structured degraded result を返す。
4. `knowledgeUsed` は実際に review prompt / guidance に渡した knowledge と一致させる。
5. `agentic_search` が degraded のとき、未選別候補をレビューに注入しない。
6. 旧 lifecycle tool を復活させず、公開面は Agent-First 主導線と補助導線（`initial_instructions / agentic_search / search_knowledge / record_task_note / review_task / doctor / memory_search / memory_fetch`）に維持する。

## 現状の問題

### 1. provider 既定値が運用意図とずれている

対象:

- `src/mcp/tools/agentFirst.ts`
- `src/services/review/llm/reviewer.ts`
- `test/mcp/tools/agentFirst.test.ts`
- `docs/configuration.md`
- `docs/mcp-tools.md`

現状のテストには `review_task uses OpenAI as the default MCP reviewer` があり、MCP の既定が単体 OpenAI であることを前提にしている。これは Azure OpenAI 前提の運用方針と衝突する。

改善:

- `review_task` の provider 未指定時は Azure OpenAI として扱う。
- `GNOSIS_REVIEWER` が設定されている場合はそれを優先する。ただし `openai` は Azure OpenAI alias に正規化する。
- `provider: openai` は Azure OpenAI alias として扱い、単体 OpenAI API は review 経路で使わない。
- local 失敗時に Azure OpenAI へ暗黙 fallback しない。fallback するなら設定名とログに明示する。

受け入れ基準:

- `provider` 未指定の `review_task` が Azure OpenAI reviewer を呼ぶ。
- `OPENAI_API_KEY` がなくても、Azure OpenAI 設定があれば provider 未指定の smoke test が cloud 設定エラーで落ちない。
- explicit `provider: openai` は Azure OpenAI として cloud を呼べる。

### 2. MCP timeout と local LLM timeout が噛み合っていない

対象:

- `src/mcp/tools/agentFirst.ts`
- `src/services/review/llm/localProvider.ts`
- `src/services/review/llm/reviewer.ts`
- `src/services/llm/spawnControl.ts`
- `test/mcp/tools/agentFirst.test.ts`

現状は MCP 側に `GNOSIS_MCP_REVIEW_LLM_TIMEOUT_MS` と 180 秒上限があるが、実際の MCP tool call は 120 秒で timeout した。local review が tool call より長く走る設計だと、ユーザーには結果も診断も返らない。

改善:

- MCP 経由の `review_task` では、内部 LLM timeout を MCP client timeout より短い値に制限する。
- 推奨値は 90 秒。`GNOSIS_MCP_REVIEW_LLM_TIMEOUT_MS` で調整可能にするが、sync MCP path では上限を 105 秒にする。
- timeout は `ReviewError('E006')` に正規化し、`review_task` handler が structured degraded result に変換する。
- degraded result には `providerUsed`, `knowledgeUsed`, `findings: []`, `summary`, `diagnostics.degradedReasons` を含める。
- 長時間 local review が必要な場合は、別計画として queued/asynchronous review を追加する。sync `review_task` で 120 秒超を狙わない。

受け入れ基準:

- local provider が timeout しても MCP call は timeout せず JSON を返す。
- `useKnowledge:false` の document review smoke が 120 秒未満で degraded JSON を返す。
- timeout 後に local LLM 子プロセスが残らない。

### 3. local LLM preflight がない

対象:

- `src/services/review/llm/localProvider.ts`
- `src/services/review/llm/reviewer.ts`
- `src/mcp/tools/agentFirst.ts`
- `src/services/agentFirst.ts`
- `test/llmService.test.ts`
- `test/mcp/tools/agentFirst.test.ts`

現状は `scripts/gemma4` が最小プロンプトに status 0 を返しても、出力が review provider の期待形式ではないケースがある。`scripts/bonsai` は依存 runtime 不足で失敗する。

改善:

- `review_task` 開始時に local provider preflight を入れる。
- preflight は 5 秒から 10 秒程度の短い `text` 出力確認に限定する。
- Gemma4 preflight では「空出力ではない」「launcher が status 0」「明らかな parser/runtime error ではない」を確認する。
- Bonsai は preflight で PrismML MLX fork 不足を検出し、fallback 候補から外す。
- preflight 失敗時は review 本体を開始せず degraded result を返す。
- `doctor` には strict mode のみ local review preflight を追加する。通常の `doctor` は遅くしない。

受け入れ基準:

- Bonsai runtime 不足が `diagnostics.localProviders.bonsai.status = "unavailable"` として説明される。
- Gemma4 出力異常が `LLM_UNAVAILABLE` として review_task result に出る。
- preflight は通常の `initial_instructions` や `search_knowledge` を遅くしない。

### 4. agentic_search knowledge と実レビュー context の一致をテストで固定する

対象:

- `src/mcp/tools/agentFirst.ts`
- `src/services/review/orchestrator.ts`
- `src/services/review/llm/reviewer.ts`
- `test/mcp/tools/agentFirst.test.ts`
- `test/agentFirstSearch.test.ts`

現在の実装は `review_task` 内で `agenticSearch` を呼び、code_diff では `retrieveGuidanceFn`、document/spec/plan では context に渡している。ただし、この不変条件は回帰しやすいため contract test として固定する。

改善:

- `agenticSearch.usedKnowledge` の fixture を用意する。
- code_diff review で `retrieveGuidanceFn` がその fixture だけを返すことを検証する。
- document/spec/plan review で context に同じ knowledge title/reason が含まれることを検証する。
- `agenticSearch.decision === "degraded"` かつ `knowledgePolicy: "required"` では review LLM を呼ばないことを検証する。
- `knowledgePolicy: "best_effort"` では degraded warning を result diagnostics に載せ、knowledge なしで review を続ける。ただし未選別候補は渡さない。

受け入れ基準:

- `knowledgeUsed` と実際に渡した guidance/context の件数と ID が一致する。
- `search_knowledge` の raw 候補は review_task に直接入らない。
- agentic_search degraded 時の required/best_effort/off の違いがテストで固定される。

### 5. document review の failure handling を MCP 向けに揃える

対象:

- `src/services/reviewAgent/documentReviewer.ts`
- `src/mcp/tools/agentFirst.ts`
- `test/mcp/tools/agentFirst.test.ts`

code_diff 側は orchestrator が `E006` timeout を degraded result に変換する経路を持つが、document/spec/plan 側は LLM failure が MCP tool timeout や internal error として見えやすい。

改善:

- `reviewDocumentForMcp` 呼び出しを `ReviewError` ごとに捕捉し、MCP response へ正規化する。
- `E006`, `E007`, `E016`, `E017` は structured degraded result にする。
- 入力不備 `E013`, `E014`, `E015` は `isError: true` の user-fixable error にする。


受け入れ基準:

- local document review timeout が MCP transport timeout にならない。
- failure result に `diagnostics.provider`, `diagnostics.timeoutMs`, `diagnostics.errorCode` が含まれる。


## 実装順

### Phase 1: 同期 MCP path を壊れない状態にする

1. `review_task` の provider default を Azure OpenAI に変更する。
2. local 失敗時の cloud fallback を MCP では無効にする。
3. MCP 経由の local LLM timeout を 90 秒程度に制限する。
4. document/spec/plan の LLM error を structured degraded result に変換する。
5. 既存テスト `review_task uses OpenAI as the default MCP reviewer` を Azure OpenAI default テストへ置き換える。

完了条件:

- `review_task` provider 未指定 smoke が `OPENAI_API_KEY` 不在で失敗せず、Azure OpenAI 設定を使う。
- local timeout でも MCP call が JSON を返す。

### Phase 2: local provider preflight と診断を追加する

1. `createLocalReviewLLMService` の前段に軽量 preflight helper を追加する。
2. Gemma4/Bonsai の status, stderr, stdout 異常を分類する。
3. `doctor` strict mode に local review preflight を追加する。
4. `review_task` diagnostics に local provider 状態を載せる。

完了条件:

- Bonsai の PrismML MLX fork 不足が説明付きで返る。
- Gemma4 parser/runtime 異常が `LLM_UNAVAILABLE` として返る。

### Phase 3: knowledge injection contract を固定する

1. code_diff の `retrieveGuidanceFn` が agentic_search 選定済み knowledge だけ返すテストを追加する。
2. document/spec/plan context に agentic_search 選定済み knowledge だけ入るテストを追加する。
3. `knowledgePolicy` ごとの degraded 挙動をテストに追加する。
4. docs/mcp-tools.md に provider default と degraded response を追記する。

完了条件:

- review_task の `knowledgeUsed` と実レビュー context が一致する。
- agentic_search failure 時の未選別候補混入がテストで防がれる。

### Phase 4: 長時間 local review の扱いを決める

2026-05-06 の運用判断で、local provider は同期 MCP 経由でも最大5分まで待つ方針に変更した。`GNOSIS_MCP_REVIEW_LLM_TIMEOUT_MS` の既定は 300000ms、shared host の `GNOSIS_MCP_HOST_REQUEST_TIMEOUT_MS` の既定は 330000ms とし、provider 側が先に structured degraded JSON を返せる余白を残す。

候補:

- `review_task` に `mode: "sync" | "queued"` を追加する。
- sync は通常5分以内に結果または degraded を返す。
- queued は task id を返し、後続の status/result 取得を別 tool ではなく既存 `doctor` または `search_knowledge` に寄せるかを検討する。

この Phase は Phase 1-3 が安定してから判断する。

## テスト計画

Focused tests:

```bash
bun test test/mcp/tools/agentFirst.test.ts test/agentFirstSearch.test.ts test/llmService.test.ts
```

Review stack tests:

```bash
bun test test/review-foundation.test.ts test/review-cloud-provider.test.ts test/mcpContract.test.ts test/mcpToolsSnapshot.test.ts
```

Full gate:

```bash
bun run verify
```

Manual MCP smoke:

1. `initial_instructions` が primary tool 方針を返す。
2. `doctor` が exposedToolCount 8, missingPrimaryTools [] を返す。
3. `agentic_search` で Gemma4 timeout 時に `degraded` + `usedKnowledge: []` になる。
4. `review_task` provider 未指定で `OPENAI_API_KEY` error にならず、Azure OpenAI 設定を使う。
5. `review_task` provider local で local LLM failure が structured degraded result になる。
6. `search_knowledge` は raw 候補確認用としてだけ使える。

## ドキュメント更新

更新対象:

- `docs/mcp-tools.md`
- `docs/configuration.md`
- `README.md`

追記内容:

- `review_task` の既定 provider は Azure OpenAI。
- `provider: openai` は Azure OpenAI alias。
- sync MCP path の timeout 方針。
- degraded response の例。
- `agentic_search` degraded 時は未選別候補を注入しない。

## リスク

- Gemma4 の実行時間が sync MCP timeout に収まらない場合、実レビューは degraded ばかりになる。この場合は queued review が必要。
- Bonsai fallback は現環境では壊れているため、fallback 候補に入れると失敗理由が増えるだけになる。
- provider default の変更は既存テストと docs を同時に変えないと contract drift になる。
- document review と code_diff review は別経路なので、片方だけ直すと再び `knowledgeUsed` と実 prompt がずれる。

## 完了定義

- `review_task` が MCP call timeout ではなく JSON result を返す。
- provider 未指定で `OPENAI_API_KEY` を要求しない。
- local LLM unavailable/timeout が degraded result と diagnostics に正規化される。
- agentic_search が選定した knowledge だけが実レビューに渡る。
- `bun run verify` が通る。
