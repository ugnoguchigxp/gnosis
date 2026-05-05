# Handoff: MCP Transport Repair / Monitor Queue UI

作成日時: 2026-05-05 20:04:51 JST  
作業ディレクトリ: `/Users/y.noguchi/Code/gnosis`  
ブランチ: `main`

## 直近のユーザー依頼

1. `mcp__gnosis.search_knowledge` / `agentic_search` が `Transport closed` で失敗するため、ちゃんと通るように修復したい。
2. その後、Tauri UI の queue が何も選択されておらず、ちゃんと使えていない気がする、という指摘。
3. 新しいセッションにしたいので、いったん作業を止めて引き継ぎmdファイルを作る。

## 現在の結論

- repo側のMCPホストと新規stdio接続は修復済み。
- ただし、このCodexセッションに既に割り当てられていた `mcp__gnosis` tool namespace は `Transport closed` のまま。これはCodexクライアント側が閉じたtransportを保持している問題で、repo内コードから同一セッション内で再接続できない。
- 新しいCodexセッションでは、まず `mcp__gnosis.doctor` または `mcp__gnosis.search_knowledge` を直接実行して復帰確認するのがよい。
- Tauri/Monitor UI の queue 問題は調査開始直後に中断。まだコード修正していない。

## MCP Transport 修復でやったこと

### 変更ファイル

- `src/mcp/hostFingerprint.ts`
- `test/mcpHostFingerprint.test.ts`

### 内容

`computeMcpHostSourceFingerprint` の対象が `src/mcp` とreview系に偏っており、`search_knowledge` / `agentic_search` の実体に近いservice変更を拾えなかった。

追加したfingerprint対象:

- `src/services/agentFirst.ts`
- `src/services/agenticSearch`
- `src/services/entityKnowledge.ts`
- `src/services/failureFirewall`
- `src/services/sessionKnowledge`

これにより、検索・ナレッジ系service変更後に常駐MCPホストが古いまま残るリスクを下げた。

### 追加テスト

`test/mcpHostFingerprint.test.ts` を追加。

確認内容:

- `src/services/agentFirst.ts` 変更でfingerprintが変わる。
- `src/services/entityKnowledge.ts` 変更でfingerprintが変わる。

## MCP 修復の検証結果

### verify

実行済み:

```bash
bun run verify:fast
```

結果:

- `486 pass`
- `21 skip`
- `0 fail`
- `verify:fast passed`

### LaunchAgent / direct host

`launchctl kickstart -k gui/$UID/com.gnosis.mcp-host` でホスト再起動済み。

直接ソケット経由で確認済み:

- host pid: `13267`
- cwd: `/Users/y.noguchi/Code/gnosis`
- backgroundWorkers: `disabled`
- sourceFingerprint: current source と一致
- services:
  - `gnosis-memory-kg`
  - `astmend-mcp`
  - `diffguard-mcp`

`search_knowledge` direct host result:

- `isError: false`
- `mode: merged_embedding_and_lexical`
- `vectorHitCount: 30`
- `embeddingStatus: used`
- `groups: 4`
- `flatTopHits: 10`

### 新規stdio MCP接続

Codex設定と同じコマンドで新規MCP clientを立てて確認済み。

設定:

```bash
/bin/zsh -lc 'cd /Users/y.noguchi/Code/gnosis && exec /Users/y.noguchi/.bun/bin/bun run src/index.ts'
```

確認結果:

- `doctor`: `isError=false`
- `search_knowledge`: `isError=false`
- `agentic_search`: `isError=false`

補足:

- `search_knowledge` のpayloadは `retrieval.mode` に `merged_embedding_and_lexical` を返す。
- 最初に `debug` を `changeTypes` に入れて `agentic_search` を呼んだらenum違反になった。`changeTypes` は `frontend | backend | api | auth | db | docs | test | mcp | refactor | config | build | review` のみ。

## このセッション内で残ったMCP制約

このセッションの `mcp__gnosis.search_knowledge` / `mcp__gnosis.agentic_search` は、修復後も以下で失敗した。

```text
tool call error: tool call failed for `gnosis/search_knowledge`
Caused by:
    Transport closed
```

```text
tool call error: tool call failed for `gnosis/agentic_search`
Caused by:
    Transport closed
```

これはrepo側のMCPサーバー起動パスではなく、Codex側の既存transportが閉じているため。新セッションでは再接続される想定。

## Tauri / Monitor Queue UI 調査の途中状態

ユーザー指摘:

```text
Tauri ui のqueueは何も選択されていないのでちゃんと使えてない気がします
```

調査開始時に見えた関連ファイル:

- `apps/monitor/src/routes/+page.svelte`
- `apps/monitor/src/lib/monitor/types.ts`
- `apps/monitor/src-tauri/src/monitor/models.rs`
- `src/scripts/monitor-snapshot.ts`

この4ファイルはすでにworktreeでmodifiedだった。今回の中断直前には内容レビュー・修正は未実施。

過去方針上、Monitor queueは単に `topic_tasks` の件数だけでなく、以下を区別して見せるべき:

- queue pending/running/deferred/failed
- workerが起動中か
- seed loopが動いているか
- last seedがないのか
- last seedはあるが候補なしなのか
- last worker failureがあるのか
- unrelated background task failureでKnowFlow degradedにしないこと

次セッションでまず見るべき点:

1. `apps/monitor/src/routes/+page.svelte` のqueue選択stateの初期値と、snapshot受信後のdefault selection処理。
2. `src/scripts/monitor-snapshot.ts` がqueue候補またはqueue summaryを返しているか。
3. `apps/monitor/src/lib/monitor/types.ts` と `apps/monitor/src-tauri/src/monitor/models.rs` の型がsnapshot JSONと一致しているか。
4. Queue UIが「選択なし」を正常状態として扱っていないか。候補があるなら最初のqueue/source/statusを自動選択する方がよい。
5. 候補が本当に空なら、UIで `queue empty` と `seed/worker inactive` を分けて表示する。

## 現在のworktree

`git status --short`:

```text
 M apps/monitor/src-tauri/src/monitor/models.rs
 M apps/monitor/src/lib/monitor/types.ts
 M apps/monitor/src/routes/+page.svelte
 M docs/knowledge-retrieval-improvement-plan.md
 M docs/mcp-tools.md
 M src/mcp/hostFingerprint.ts
 M src/mcp/tools/agentFirst.ts
 M src/scripts/monitor-snapshot.ts
 M src/services/agentFirst.ts
 M src/services/agenticSearch/runner.ts
 M src/services/agenticSearch/tools/knowledgeSearch.ts
 M src/services/entityKnowledge.ts
 M src/services/sessionKnowledge/approval.ts
 M test/agentFirstSearch.test.ts
 M test/mcp/tools/agentFirst.test.ts
 M test/mcpToolsSnapshot.test.ts
 M test/sessionKnowledge.approval.test.ts
?? test/entityKnowledge.test.ts
?? test/mcpHostFingerprint.test.ts
?? docs/handoff-2026-05-05-mcp-monitor-queue.md
```

`git diff --stat` at handoff作成前:

```text
 apps/monitor/src-tauri/src/monitor/models.rs       |   4 +
 apps/monitor/src/lib/monitor/types.ts              |   1 +
 apps/monitor/src/routes/+page.svelte               |  77 ++++-
 docs/knowledge-retrieval-improvement-plan.md       | 194 +++++++++---
 docs/mcp-tools.md                                  |   1 +
 src/mcp/hostFingerprint.ts                         |   5 +
 src/mcp/tools/agentFirst.ts                        |  14 +-
 src/scripts/monitor-snapshot.ts                    |  33 ++
 src/services/agentFirst.ts                         | 276 +++++++++++++----
 src/services/agenticSearch/runner.ts               |  16 +-
 src/services/agenticSearch/tools/knowledgeSearch.ts|  11 +-
 src/services/entityKnowledge.ts                    | 333 ++++++++++++++++++---
 src/services/sessionKnowledge/approval.ts          |  14 +-
 test/agentFirstSearch.test.ts                      | 134 ++++++++-
 test/mcp/tools/agentFirst.test.ts                  |  47 +--
 test/mcpToolsSnapshot.test.ts                      |   2 +-
 test/sessionKnowledge.approval.test.ts             |  13 +-
 17 files changed, 985 insertions(+), 190 deletions(-)
```

## 次セッションの推奨開始手順

### 1. MCP復帰確認

新セッションでまず直接確認する。

```ts
mcp__gnosis.doctor({})
```

または:

```ts
mcp__gnosis.search_knowledge({
  query: 'Gnosis Monitor queue UI selection',
  taskGoal: 'Tauri Monitor queue UI wiring debug',
  intent: 'debug',
  files: [
    'apps/monitor/src/routes/+page.svelte',
    'src/scripts/monitor-snapshot.ts'
  ],
  changeTypes: ['frontend'],
  technologies: ['Tauri', 'SvelteKit']
})
```

### 2. Monitor queueの現状確認

```bash
bun run monitor:snapshot
```

またはpackage scriptがなければ:

```bash
bun src/scripts/monitor-snapshot.ts
```

JSON内で以下を確認する:

- queue summaryの有無
- queue item/listの有無
- selected queueに相当するキーが存在するか
- worker/seed/automationの状態がsnapshotに含まれているか

### 3. UI側の選択ロジック確認

```bash
sed -n '1,260p' apps/monitor/src/routes/+page.svelte
sed -n '1,220p' apps/monitor/src/lib/monitor/types.ts
sed -n '1,220p' apps/monitor/src-tauri/src/monitor/models.rs
sed -n '1,260p' src/scripts/monitor-snapshot.ts
```

確認観点:

- selection stateが空文字/nullのままになっていないか
- snapshot更新時にdefault selectionしているか
- selected queueが存在しなくなった時にfallbackしているか
- Rust model -> TS type -> Svelte UI のフィールド名が一致しているか

### 4. 修正方針

候補があるのに未選択なら:

- snapshot受信時に最初のqueue/source/statusを自動選択する。
- 現在選択が存在しなくなった場合だけfallbackする。
- ユーザーが手動選択した場合は、存在する限り保持する。

候補が空なら:

- 「未選択」ではなく「queue empty」を明示表示する。
- worker/seed/automation healthも同時表示し、空queueが正常なのか、seedが止まっているのかを分ける。

### 5. 検証

最低限:

```bash
bun test test/monitorSnapshot.test.ts
bun run verify:fast
```

UIを触るなら可能なら:

```bash
bun run --cwd apps/monitor build
```

## 注意点

- 現在のworktreeにはMonitor関連のmodified fileが既にある。次セッションでは、誰の変更かを前提にせず、まずdiffを読んでから触ること。
- `mcp__gnosis` が新セッションでも `Transport closed` の場合は、repoコードではなくCodex側MCP client/host再接続問題として扱う。新規stdio接続とdirect hostは通っている。
- destructiveなgit操作は禁止。既存変更はrevertしない。
