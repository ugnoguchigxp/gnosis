# Operations Runbook

Gnosis の通常運用は、軽量診断、focused gate、strict gate、Monitor の順に確認します。

## Daily Check

```bash
bun run doctor
bun run monitor:snapshot -- --json
bun run status-report --json
```

`doctor` は軽量診断です。strict gate は実行しません。

## Strict Check

```bash
GNOSIS_DOCTOR_STRICT=1 bun run doctor
```

strict doctor は通常診断に加えて次を実行します。

- `bun run smoke`
- `bun test test/mcpContract.test.ts test/mcpToolsSnapshot.test.ts`

結果は `logs/quality-gates.json` に保存され、Monitor UI の `Quality Gates` に表示されます。

## Review Provider

`review_task` の既定 provider は `GNOSIS_REVIEWER` で解決し、未指定時は Azure OpenAI alias です。

| 入力 | 解決 |
| :--- | :--- |
| 未指定 | `GNOSIS_REVIEWER`、なければ `azure-openai` |
| `openai` | Azure OpenAI alias |
| `azure-openai` | Azure OpenAI |
| `bedrock` | Bedrock |
| `local` | local reviewer、fallback 無効 |

MCP sync path では `GNOSIS_MCP_REVIEW_LLM_TIMEOUT_MS` を使い、既定は 300000ms（5分）です。shared host の `GNOSIS_MCP_HOST_REQUEST_TIMEOUT_MS` 既定は 330000ms で、review LLM が先に結果または degraded JSON を返せる余白を持たせます。失敗時は例外ではなく degraded JSON を返します。

## Agentic Search Smoke

`agentic_search` の runner、provider adapter、MCP host を変更した後は、CLI first で protocol を確認してから MCP 経由を確認します。

```bash
bun test test/agenticSearch/runner.test.ts test/agenticSearch/llmAdapter.test.ts test/agentic-search-cli.test.ts test/mcp/tools/agentFirst.test.ts
bun run agentic-search -- --request "Gnosis の agentic_search 改善で守るべきルールを調べて" --intent plan --change-type mcp --json
bun run agentic-search:semantic-smoke
```

MCP 経由では次を確認します。

- provider が `messages with role 'tool' must be a response to a preceeding message with 'tool_calls'` を返さない。
- stale host ではなく、現在の checkout の MCP host が応答している。
- 回答は自然文、または限定回答であることを明示した fallback である。
- semantic smoke では、現行 public surface と矛盾する古い lifecycle 導線を回答に混ぜない。

raw 候補や score を直接確認する場合だけ `search_knowledge` を使います。その場合は `taskGoal` / `files` / `changeTypes` / `technologies` を明示し、`insufficient_task_context` は検索品質ではなく入力不足として扱います。

## Failure Response

| 症状 | 確認 | 対応 |
| :--- | :--- | :--- |
| `doctor` が DB で失敗 | `docker compose ps` | `docker compose up -d gnosis` |
| `smoke` が eval で失敗 | `bun src/services/knowflow/cli.ts eval-run --suite local --mock --json` | CLI 引数と fixture を確認 |
| `review_task` が degraded | `diagnostics.errorCode` | provider env / timeout / documentPath を確認 |
| `agentic_search` が限定回答 | `degradedReason` | raw候補を `search_knowledge` で確認 |
| `search_knowledge` が `insufficient_task_context` | request payload | `taskGoal`, `files`, `changeTypes`, `technologies` を追加して再実行 |
| `agentic_search` が provider protocol error | focused tests と CLI JSON smoke | prefetch が compact context で渡され、LLM 由来の `tool_calls` だけが `tool` role message を作ることを確認 |
| semantic smoke が失敗 | `logs/quality-gates.json` の `semanticSmoke` と CLI output | structured tool calling provider、prefetch context、degraded reason を確認 |
| MCP host connection closed | `launchctl print gui/$UID/com.gnosis.mcp-host` と `tail -n 120 logs/mcp-host.log` | `launchctl kickstart -k gui/$UID/com.gnosis.mcp-host` 後に `bun run doctor` と MCP smoke を再実行 |
| queue failed backlog が残る | `bun run status-report --json` の `queueBacklog.failedReasonClasses` と `bun run monitor:knowflow-failures -- --json` | `llm_provider_unavailable` は provider/env/backoff、入力不正は task payload、timeout は worker timeout を切り分ける。再試行する場合は `bun run monitor:task-action -- --action retry --task-id <id> --json` |
| Monitor が古い | `logs/quality-gates.json` | 対象 gate を再実行 |

## Monitor Health の読み方

`knowflow.status=healthy` は runtime の生存性です。直近 worker / seed が動いており、KnowFlow runtime として完全停止していないことを示します。

failed backlog は別指標です。`monitor:snapshot` の `queueInterpretation` と `status-report` の `queueBacklogInterpretation` を見て、次のように読む。

| backlog status | 意味 | 次 |
| :--- | :--- | :--- |
| `clear` | failed / deferred backlog なし | 通常監視を継続 |
| `needs_attention` | runtime は動いているが failed/deferred が残っている | `bun run monitor:knowflow-failures -- --json` |
| `blocked` | DB/input/worker runtime 系の reason class が failed backlog にある | reason class を直してから retry |
| `unknown` | DB に到達できず backlog を読めない | `bun run doctor` |

`healthy + needs_attention` は矛盾ではありません。runtime は生きているが、処理済みタスクの失敗が残っている状態です。

## Project Value Evidence

価値評価の更新前は次を確認します。

```bash
bun run status-report --json
bun run monitor:snapshot -- --json
```

`projectValueEvidence.scoreReady=false` の場合は、`missingEvidence` と `claimAllowed` に合わせて README や評価文の主張を弱めます。特に `reviewTaskLocal.claimAllowed=structured_degraded_only` または `single_run_ok` の間は、local provider を「安定完走」と書かない。

local provider の live evidence が必要な場合:

```bash
bun run review:local-smoke
```

結果は `logs/review-task-local-smoke.json` に保存され、`status-report` の `projectValueEvidence.reviewTaskLocal` に反映されます。
3連続で300秒以内に `status=ok` になるまで、claim は `single_run_ok` のまま扱います。
既存の `llm-pool` lock が30秒以上残っている場合、smoke は待ち続けず `status=blocked` と lock holder を記録します。その場合は `logs/review-task-local-smoke.json` の `llmPoolLock` を確認し、必要なら worker の進行状況を確認してから再実行します。

## Release Gate

リリース前は [Project Value Improvement Plan](project-value-improvement-plan.md) の value gate と `bun run verify` を使います。
