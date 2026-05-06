# Operations Runbook

Gnosis の通常運用は、軽量診断、focused gate、strict gate、Monitor の順に確認します。

## Daily Check

```bash
bun run doctor
bun run monitor:snapshot -- --json
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

MCP sync path では `GNOSIS_MCP_REVIEW_LLM_TIMEOUT_MS` を使い、既定は 15 秒です。失敗時は例外ではなく degraded JSON を返します。

## Agentic Search Smoke

`agentic_search` の runner、provider adapter、MCP host を変更した後は、CLI first で protocol を確認してから MCP 経由を確認します。

```bash
bun test test/agenticSearch/runner.test.ts test/agenticSearch/llmAdapter.test.ts test/agentic-search-cli.test.ts test/mcp/tools/agentFirst.test.ts
bun run agentic-search -- --request "Gnosis の agentic_search 改善で守るべきルールを調べて" --intent plan --change-type mcp --json
```

MCP 経由では次を確認します。

- provider が `messages with role 'tool' must be a response to a preceeding message with 'tool_calls'` を返さない。
- stale host ではなく、現在の checkout の MCP host が応答している。
- 回答は自然文、または限定回答であることを明示した fallback である。

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
| MCP host connection closed | `launchctl print gui/$UID/com.gnosis.mcp-host` と `tail -n 120 logs/mcp-host.log` | `launchctl kickstart -k gui/$UID/com.gnosis.mcp-host` 後に `bun run doctor` と MCP smoke を再実行 |
| Monitor が古い | `logs/quality-gates.json` | 対象 gate を再実行 |

## Release Gate

リリース前は [Release Checklist](release-checklist.md) を使います。
