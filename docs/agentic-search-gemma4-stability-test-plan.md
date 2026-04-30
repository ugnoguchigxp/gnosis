# Agentic Search Gemma4 安定性テスト計画

## 目的

`agentic_search` の Gemma4 relevance filtering が、どの条件で安定し、どの条件で `degraded` に倒れるべきかを測定可能にする。

目的は Gemma4 を常に成功させることではない。Gemma4 の限界を把握し、遅延、異常出力、runtime failure、同時実行、MCP timeout の範囲内で `agentic_search` が安全に返ることを固定する。

## 先に固定する仕様（実装着手条件）

以下を未決定のまま実装に入ると、テストが割れて進行が止まるため先に固定する。

| 論点 | 推奨仕様 | 理由 |
| --- | --- | --- |
| `localLlm.enabled=false` かつ `localLlm.required=true` | `decision: "degraded"` を返す（validation error にはしない） | ツール契約を壊さず、`required` の意図（fallback 注入禁止）を守れる |
| malformed JSON の一部 salvage | `candidate` 単位 salvage はしない。構造不正は degraded | 部分救済は挙動が不安定化しやすく、回帰コストが高い |
| missing candidate decision | 未指定 candidate は deterministic fallback を適用 | 完全失敗で degraded に倒すより、既存挙動との互換を保てる |
| Agentic Search の分類 timeout | 既定 30s → 180s（`agentic_search` 専用） | Gemma4 実運用遅延に合わせる。分類用途でのみ拡張し副作用を局所化 |
| degrade 時の nextAction | 常に `retry_later` | 呼び出し側の分岐が単純になり、誤注入を防げる |

## 現行コード経路（2026-04-30 時点）

`agentic_search` は `src/services/agentFirst.ts` の `agenticSearch()` で実行される。

1. `searchKnowledgeV2({ preset: 'task_context' })` で候補を集める。
2. 候補がある場合、既定では `classifyAgenticCandidatesWithLocalLlm()` が走る。
3. 分類は `runPromptWithMemoryLoopRouter()` に委譲される。
4. routing は `src/services/memoryLoopLlmRouter.ts` が行う。
5. 呼び出しは `preferredLocalAlias: 'gemma4'`, `fallbackLocalAlias: 'bonsai'`, `allowCloudFallback: false`, `llmTimeoutMs: input.localLlm?.timeoutMs ?? 30_000`。
6. local LLM が失敗すると、`decision: 'degraded'`, `usedKnowledge: []`, `nextAction: 'retry_later'` を返す。

補足:

- Router 側の一般既定 timeout は 90 秒だが、`agentic_search` は 30 秒を明示指定して上書きしている。
- `localLlm.required` は schema で受理されるが、現行 `agenticSearch()` では分岐に使われていない。

## 受け入れ基準（DoD）

### 機能

- `localLlm.required` の仕様が実装され、`required=true` で未分類 fallback 注入が発生しない。
- Gemma4 分類 timeout を 180 秒に引き上げても、MCP 呼び出しは transport timeout ではなく structured result を返す。
- Gemma4 失敗時に `usedKnowledge` は常に空。

### 品質

- unit / router / contract の失敗系テストが追加され、`degradedReasons` の形式が固定される。
- process cleanup テストで timeout 後の orphan が検出されない（または known failing として明示管理される）。

### ドキュメント整合

- `MEMORY_LOOP_MAX_LOCAL_RETRIES` の default 記述を実装値と一致させる（`src/constants.ts` と `docs/configuration.md`）。
- 新規 smoke スクリプトの実行方法と結果保存先が明記される。

## 確認する既知ギャップ

### 1. `localLlm.required` が parse されるだけで使われていない

テスト期待値:

- `localLlm: { enabled: false, required: true }` は `degraded` を返す。
- `required` が `true` の場合、LLM を使わず fallback decision で `use_knowledge` にしてはいけない。

### 2. timeout 後に子 runtime が残る可能性がある

`agentic_search` の Gemma4 経路は `runLlmProcessSync()` 経由で `spawnSync()` を使う。非同期版 `runLlmProcess()` は process tree kill を持つが、同期版は process tree tracking を持たない。

`scripts/gemma4` は `bun run src/scripts/local-llm-cli.ts --alias gemma4` を起動し、`local-llm-cli.ts` がさらに Python runtime を spawn する。timeout で direct child だけが止まる場合、grandchild が残る可能性を検証する。

テスト期待値:

- timeout 後に `bun`, `python`, `main.py`, `local-llm-cli.ts` の余剰プロセスが残らない。
- 残る場合は sync path を process tree kill 対応にするか、Agentic Search の Gemma4 分類だけ async spawn path に寄せる。

### 3. config 既定値と docs が一致していない

`src/constants.ts` の `MEMORY_LOOP_MAX_LOCAL_RETRIES_DEFAULT` は `1` だが、`docs/configuration.md` は default `3` と記載している。

テスト期待値:

- 実 runtime config と docs を一致させる。
- Agentic Search の fallback が実際に Gemma4 から Bonsai へ進むかを fixture で確認する。

### 4. 不正 JSON handling が all-or-nothing になっている

Gemma4 出力は `extractJsonObject()` で最初の JSON object を抜き出して parse される。JSON が壊れている場合は全体 degraded になる。

テスト期待値:

- Markdown fenced JSON は parse できる。
- trailing comma は parse できる。
- truncated JSON は degraded。
- wrong schema は degraded とし、部分 salvage は行わない（今回の固定仕様）。

## テストレイヤー

### レイヤー A: 純粋な unit test

実 Gemma4 は使わない。`spawnSync` または `runPromptWithMemoryLoopRouter` を mock する。

対象ファイル:

- `test/agentFirstSearch.test.ts`
- `test/memoryLoopLlmRouter.test.ts`
- 追加: `test/agenticSearchGemma4Stability.test.ts`

シナリオ:

| シナリオ | 入力 | 期待値 |
| --- | --- | --- |
| 正常分類 | `use` / `skip` / `maybe` を含む strict JSON | `use` と高 confidence の `maybe` だけ注入される |
| timeout error | spawn error `ETIMEDOUT` | `decision: degraded`, `usedKnowledge: []` |
| non-zero status | status 1 with stderr | route diagnostic 付き degraded |
| 空 stdout | status 0, stdout empty | degraded、候補注入なし |
| malformed JSON | status 0, broken JSON | degraded、候補注入なし |
| fenced JSON | status 0, ```json wrapper | parse 成功 |
| unknown candidate id | 存在しない id の decision | 無視される |
| missing candidate decision | 一部 candidate の decision が欠落 | 未指定分は deterministic fallback |
| required but disabled | `localLlm.enabled=false, required=true` | degraded。fallback 注入はしない |
| disabled and not required | `localLlm.enabled=false` | deterministic fallback で top candidates を注入してよい |

重要 assertion:

- LLM failure path では常に `usedKnowledge.length === 0` を維持する。
- `diagnostics.degradedReasons` に alias、attempt、route reason、timeout/status category が含まれる。

### レイヤー B: router と process control のテスト

slow child behavior を模擬する local command を使う。

対象ファイル:

- `test/memoryLoopLlmRouter.test.ts`
- 追加: `test/llmSpawnTimeout.test.ts`

シナリオ:

| シナリオ | 入力 | 期待値 |
| --- | --- | --- |
| Gemma4 first attempt succeeds | status 0 | one attempt, alias `gemma4` |
| Gemma4 fails and fallback enabled | first status 1, second status 0 | retry で Bonsai が選択される |
| fallback disabled | `fallbackLocalAlias: null` | retry しても alias が切り替わらない |
| cloud forbidden | `allowCloudFallback: false` | retries 後も cloud route に進まない |
| seatbelt safe mode | `CODEX_SANDBOX=seatbelt` | `LOCAL_LLM_ALLOW_MLX_IN_SEATBELT=0` |
| timeout process cleanup | child sleeps past timeout | orphan child process が残らない |
| semaphore contention | concurrent calls が limit を超える | serialize されるか bounded diagnostic で失敗する |

process cleanup のテスト設計:

1. 長時間生きる child を spawn し、親終了を無視する小さな fixture script を追加する。
2. 同じ spawn control path を短い timeout で実行する。
3. pid を使って child が消えていることを assert する。
4. 現行 sync path が満たせない場合は、`test.todo` または `it.fails` で失敗条件を明示して追跡する。

### レイヤー C: Agentic Search の contract test

mock DB candidates と mock LLM outputs を使う。

対象ファイル:

- `test/agentFirstSearch.test.ts`
- `test/mcp/tools/agentFirst.test.ts`

シナリオ:

| シナリオ | 期待値 |
| --- | --- |
| candidate count 0 | local LLM call なし |
| raw memory fallback active | raw memory candidates は requested または entity candidates empty の時だけ含まれる |
| Gemma4 degraded + best effort caller | unfiltered injection なし |
| Gemma4 degraded + required caller | degraded が terminal になる |
| MCP handler timeout budget | client timeout 前に JSON を返す |
| Failure Firewall hint present | hint が `usedKnowledge` decision を上書きしない |

重要 assertion:

- `review_task` は `agentic_search.usedKnowledge` だけを受け取り、degraded Agentic Search の raw candidates を受け取ってはいけない。

### レイヤー D: 実 Gemma4 の smoke matrix

この layer は実 `scripts/gemma4` launcher を使う。default `bun test` には含めず、明示実行だけにする。

コマンド:

```sh
bun run src/scripts/agentic-search-gemma4-smoke.ts --suite quick --json
bun run src/scripts/agentic-search-gemma4-smoke.ts --suite stress --json
```

シナリオ:

| Suite | prompt shape | candidate count | timeout | 目的 |
| --- | --- | ---: | ---: | --- |
| quick | tiny direct task | 3 | 60s | cold/warm baseline |
| quick | Japanese task | 6 | 180s | 現在の日本語依頼 path |
| quick | mixed Japanese/English | 6 | 180s | bilingual relevance |
| quick | docs-only task | 8 | 180s | lexical over-selection の回避 |
| stress | long task summary | 16 | 180s | prompt length limit |
| stress | max candidates | 30 | 180s | max payload |
| stress | noisy candidates | 20 | 180s | generic memories の skip |
| stress | repeated sequential calls | 10 x 5 | 180s each | warm stability |
| stress | concurrent calls | 3 parallel | 180s each | semaphore と memory pressure |
| stress | forced tiny timeout | 6 | 1s | degraded speed と cleanup |

取得 metric:

- wall clock duration
- selected alias
- attempts
- stdout byte length
- stderr summary
- parse success/failure
- decision distribution
- degraded reason
- leftover process count
- memory pressure if cheaply available

合格基準:

- quick suite: 90% 以上が成功、または timeout 内に structured degraded を返す。
- stress suite: MCP/tool call hang がない。orphan local runtime が残らない。unfiltered knowledge injection がない。
- tiny timeout suite: 全 call が bounded time 内に degraded を返す。

### レイヤー E: live MCP scenario test

service function ではなく、MCP tool handler と同じ経路で実行する。

シナリオ:

1. `agentic_search` with `localLlm.enabled=false` が deterministic result を返す。
2. real Gemma4 + short timeout の `agentic_search` が `use_knowledge` または `degraded` を返し、transport timeout にならない。
3. `agentic_search` with `localLlm.required=true` が決定済み required semantics に従う。
4. repeated MCP calls で Bun/Python process が蓄積しない。
5. `doctor` が local LLM status と tool visibility を分けて報告する。

## 実装順序（ファイル単位）

1. `src/services/agentFirst.ts`
- `localLlm.required` 分岐を実装する。
- `agentic_search` の分類 timeout 既定値を 180 秒へ引き上げる（この経路のみ）。
- degraded diagnostics の reason 文言を機械判定しやすく正規化する。

2. `test/agentFirstSearch.test.ts`
- required semantics / malformed output / fallback 防止ケースを追加する。

3. `src/services/memoryLoopLlmRouter.ts`, `test/memoryLoopLlmRouter.test.ts`
- retry と alias 切替、timeout エラー分類、seatbelt env を固定する。

4. `test/llmSpawnTimeout.test.ts`（新規）
- timeout 後 orphan 検出テストを追加する。

5. `src/scripts/agentic-search-gemma4-smoke.ts`（新規）
- quick/stress suite 実装、JSON 出力、exit code 規約を追加する。

6. `docs/configuration.md`
- `MEMORY_LOOP_MAX_LOCAL_RETRIES` default を実装値に合わせる（1 へ修正）。

7. `docs/agentic-search-gemma4-stability-results.md`（新規）
- smoke 実行結果の baseline を記録する。

## 検証コマンド

default verification:

```sh
bun test test/agentFirstSearch.test.ts test/memoryLoopLlmRouter.test.ts test/mcp/tools/agentFirst.test.ts
bun run typecheck
```

process cleanup 追加後:

```sh
bun test test/llmSpawnTimeout.test.ts
```

opt-in real Gemma4 verification:

```sh
bun run src/scripts/agentic-search-gemma4-smoke.ts --suite quick --json
bun run src/scripts/agentic-search-gemma4-smoke.ts --suite stress --json
```

stability fixes を commit する前の full gate:

```sh
bun run verify
```

## 対象外

- `agentic_search` の default fallback を Azure OpenAI にしない。
- Gemma4 が失敗した時に unfiltered candidates を注入しない。
- `agentic_search` を MCP client が許容できる時間より長く待たせない。Gemma4 classification path は 180 秒を上限目安にする。
- この調査のために新しい primary MCP tool を追加しない。

## 追加深化: 実装オペレーション設計

### 工数と依存関係（目安）

| タスク | 依存 | 目安 |
| --- | --- | --- |
| `localLlm.required` 分岐実装 + unit | なし | 0.5 日 |
| timeout 180s 化 + diagnostics 正規化 | 上記 | 0.5 日 |
| router retry/alias テスト拡張 | 上記と並行可 | 0.5 日 |
| process cleanup fixture + test | router テスト拡張後 | 1.0 日 |
| real Gemma4 smoke script | unit 完了後 | 1.0 日 |
| docs 整合 + baseline 記録 | smoke 実行後 | 0.5 日 |

### 変更失敗時のロールバック方針

- timeout 180s 変更で MCP 応答悪化が出た場合:
  - `agentic_search` のみ 60s へ一時ロールバックし、`--suite stress` 再測定後に再調整する。
- `localLlm.required` 導入で既存 caller が詰まる場合:
  - caller 側入力を `required=false` 明示へ切り替える暫定対応を許可し、既定値の仕様は維持する。
- process cleanup が不安定な場合:
  - failing test を `it.fails` で管理し、既知課題として CI を止めない状態で追跡する。

### smoke script の出力契約（固定）

`src/scripts/agentic-search-gemma4-smoke.ts --json` は 1 run ごとに以下を出力する。

```json
{
  "suite": "quick|stress",
  "caseId": "string",
  "startedAt": "ISO-8601",
  "durationMs": 12345,
  "result": {
    "decision": "use_knowledge|no_relevant_knowledge|degraded",
    "confidence": 0.0,
    "usedKnowledgeCount": 0,
    "skippedCount": 0,
    "maybeCount": 0,
    "nextAction": "proceed_with_context|proceed_without_context|retry_later"
  },
  "diagnostics": {
    "localLlmUsed": true,
    "degradedReasons": ["..."],
    "attempts": 1,
    "selectedAlias": "gemma4|bonsai"
  },
  "process": {
    "leftoverCount": 0
  }
}
```

### 失敗分類コード（diagnostics で統一）

`degradedReasons` の先頭に機械可読 code を付与する。

- `LLM_TIMEOUT:`
- `LLM_NON_ZERO_EXIT:`
- `LLM_EMPTY_STDOUT:`
- `LLM_MALFORMED_JSON:`
- `LLM_SCHEMA_MISMATCH:`
- `RAW_MEMORY_SEARCH_FAILED:`

例: `LLM_TIMEOUT: alias=gemma4 attempt=1 reason=primary-local-route`

### 実装着手ゲート

以下が揃うまでコード編集を開始しない。

- 本ドキュメント内の「先に固定する仕様」が合意済みである。
- `test/agentFirstSearch.test.ts` と `test/memoryLoopLlmRouter.test.ts` の追加ケース名が先に確定している。
- smoke script の JSON 出力契約が確定している。

