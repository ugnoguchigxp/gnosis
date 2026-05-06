# Release Checklist

外部配布前に、次の項目を順に確認します。

## 1. Repository State

```bash
git status --short
bun run doctor
```

- 意図しない変更がないこと
- DB / embedding / MCP host / local-llm optional 状態が説明可能であること

## 2. Focused Gates

```bash
bun test test/mcp/tools/agentFirst.test.ts test/agenticSearch/runner.test.ts
bun test test/mcpContract.test.ts test/mcpToolsSnapshot.test.ts
bun run smoke
```

- `review_task` が `unavailable_in_minimal_mode` を返さないこと
- `agentic_search` が LLM finalization 失敗時も knowledge fallback を返せること
- KnowFlow mock eval が pass/fail gate で通ること

## 3. Full Gates

```bash
bun run verify:fast
bun run verify
GNOSIS_DOCTOR_STRICT=1 bun run doctor
```

必要に応じて strict verification:

```bash
bun run verify:strict
```

## 4. Docs

- README のセットアップ手順が実コマンドと一致していること
- `docs/mcp-tools.md` の schema/behavior が `test/mcpToolsSnapshot.test.ts` と一致していること
- `docs/data-layers.md` と `docs/knowflow-guide.md` が現行の運用導線を説明していること

## 5. Monitor Evidence

```bash
bun run monitor:snapshot -- --json
```

- `qualityGates` に直近 gate 結果が出ること
- queue の `failed` / `deferred` が説明可能であること
- `knowflow.status` が `healthy` / `idle` / `degraded` のどれかとして解釈できること

## 6. Tag

```bash
bun run release
```

`release` は verify 後に tag を作成します。push は手動で実行します。
