# agentic_search Success Example

## 入力

```ts
await agentic_search({
  userRequest: 'review_task の local provider timeout 方針を変更する前に、過去の方針を確認したい',
  repoPath: '/Users/y.noguchi/Code/gnosis',
  changeTypes: ['mcp', 'review', 'config'],
  intent: 'edit',
});
```

## 期待される出力要点

- raw 候補一覧ではなく、今回の変更判断に使う自然文の要約を返す。
- `review_task` の timeout は host timeout より短くする、という既存方針を説明する。
- local provider が timeout した場合は structured degraded として扱い、安定完走とは主張しない。
- 旧 lifecycle tool を通常導線として案内しない。

## 使われる knowledge

- MCP shared host と `review_task` timeout の過去修復。
- degraded result を clean pass に丸めない review semantics。
- primary tool surface は `initial_instructions / agentic_search / search_knowledge / record_task_note / review_task / doctor` に固定する方針。

## degraded の読み方

`agentic_search` が provider timeout や protocol error で degraded になった場合、未選別 raw 候補を確定判断として使わない。回答に `degradedReason` がある場合は、限定回答として扱い、必要なら `search_knowledge` で raw 候補だけを別確認する。

## 検証コマンド

```bash
bun run agentic-search -- --request "review_task の local provider timeout 方針を変更する前に、過去の方針を確認したい" --intent edit --change-type mcp --change-type review --change-type config --json
bun run agentic-search:semantic-smoke
```
