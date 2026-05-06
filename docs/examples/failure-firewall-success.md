# Failure Firewall Success Example

## 入力

Failure Firewall は専用 primary MCP tool として呼ばない。通常の `review_task` または `agentic_search` の補助 context として使う。

```ts
await review_task({
  targetType: 'code_diff',
  target: { diff: '<unified diff>' },
  knowledgePolicy: 'best_effort',
  goal: '過去 lesson と同じ失敗を再発していないか確認する',
});
```

## 期待される出力要点

- 過去 lesson / rule / procedure に該当する再発リスクがある場合だけ、finding または `needs_confirmation` として surfaced する。
- raw lesson は blocker として確定せず、review context の補助証拠として扱う。
- docs-only 変更や無関係な差分では Failure Firewall finding を増やさない。
- `knowledgeUsed` と実際に review context に渡った knowledge が一致する。

## 使われる knowledge

- Failure Firewall は Golden Path 逸脱と再発検知に限定する。
- 専用公開 tool を増やさず、既存 knowledge / review / agentic_search の流れに統合する。
- false green を避けるため、degraded knowledge path は clean pass に丸めない。

## degraded の読み方

Failure Firewall context が degraded の場合、過去 lesson が使えなかった可能性を `diagnostics.degradedReasons` で確認する。raw 候補が未選別なら review finding として扱わない。

## 検証コマンド

```bash
bun test test/reviewFailureFirewallContext.test.ts test/failureFirewall.test.ts test/failureFirewallLearningCandidates.test.ts
```
