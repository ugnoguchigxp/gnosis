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

## Failure Response

| 症状 | 確認 | 対応 |
| :--- | :--- | :--- |
| `doctor` が DB で失敗 | `docker compose ps` | `docker compose up -d gnosis` |
| `smoke` が eval で失敗 | `bun src/services/knowflow/cli.ts eval-run --suite local --mock --json` | CLI 引数と fixture を確認 |
| `review_task` が degraded | `diagnostics.errorCode` | provider env / timeout / documentPath を確認 |
| `agentic_search` が限定回答 | `degradedReason` | raw候補を `search_knowledge` で確認 |
| Monitor が古い | `logs/quality-gates.json` | 対象 gate を再実行 |

## Release Gate

リリース前は [Release Checklist](release-checklist.md) を使います。
