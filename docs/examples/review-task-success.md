# review_task Success Example

## 入力

```ts
await review_task({
  provider: 'local',
  targetType: 'implementation_plan',
  target: { documentPath: 'docs/project-value-improvement-plan.md' },
  knowledgePolicy: 'best_effort',
});
```

## 期待される出力要点

- 旧 stub ではなく、`status`, `reviewStatus`, `summary`, `findings`, `knowledgeUsed`, `diagnostics` を含む JSON を返す。
- local provider が完走した場合は `status: "ok"` と review result を返す。
- timeout / unavailable / malformed output の場合も MCP transport error ではなく `status: "degraded"` を返す。
- degraded result は `reviewStatus: "needs_confirmation"` として扱う。
- `diagnostics.provider`, `diagnostics.durationMs`, `diagnostics.degradedReasons` を確認できる。

## 使われる knowledge

- `review_task` timeout は provider timeout が host timeout より先に切れる必要がある。
- degraded, timeout, `llm_failed`, `llm_unparseable`, knowledge retrieval failure は clean pass ではなく `needs_confirmation`。
- local-first path は実測されるまで「安定完走」と主張しない。

## degraded の読み方

`status: "degraded"` は価値がゼロという意味ではない。review request は受け付けられ、失敗理由も structured に返っている。ただし指摘なしの成功ではないため、評価や保存時は `needs_confirmation` として扱う。

## 検証コマンド

```bash
bun test test/mcp/tools/agentFirst.test.ts test/review-foundation.test.ts
bun run review:local-smoke
bun run status-report --json
```
