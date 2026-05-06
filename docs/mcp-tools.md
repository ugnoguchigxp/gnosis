# MCP Tools API Reference

Gnosis は、エージェントが長期記憶、知識グラフ、自律調査能力、計画レビューを利用するための MCP ツール群を提供します。

現在の一次導線は lifecycle event ではなく、`agentic_search` による task-aware retrieval と、`review_task` による knowledge-aware review です。

## 公開ツール一覧

Gnosis 本体の primary tool surface は以下の6件です。

- [initial_instructions](#initial_instructions): Gnosis の最小利用方針
- [agentic_search](#agentic_search): タスク文脈に必要な知識だけを取得する agentic retrieval
- [search_knowledge](#search_knowledge): raw 候補・スコア確認用の低レベル検索
- [record_task_note](#record_task_note): 明示的な再利用知識の保存
- [review_task](#review_task): 知識注入型レビュー
- [doctor](#doctor): ランタイム診断とメタデータ整合性チェック

Codex などの stdio MCP client からは、Gnosis stdio adapter が shared host へ接続します。この host は Gnosis primary tools に加えて、利用可能な場合に Astmend と diffGuard の service tools も同じ `tools/list` へ集約します。代表例は `analyze_references_from_text`（Astmend）と `analyze_diff`（diffGuard）です。

## 稼働確認

MCP 公開面の確認は、Gnosis primary surface と shared host surface を分けて確認します。

```bash
bun run doctor
GNOSIS_DOCTOR_STRICT=1 bun run doctor
bun test test/mcpContract.test.ts test/mcpToolsSnapshot.test.ts
bun test test/mcpHostServices.test.ts test/mcpStdioIntegration.test.ts
```

期待値:

- `doctor` の `toolVisibility.exposedToolCount` は Gnosis primary tools として `6` です。
- `missingPrimaryTools` は空です。
- `test/mcpHostServices.test.ts` は `gnosis-memory-kg`, `astmend-mcp`, `diffguard-mcp` が同一 router に読み込まれることを確認します。
- `test/mcpStdioIntegration.test.ts` は stdio adapter 経由の `tools/list` に Gnosis primary tool と Astmend / diffGuard tool が含まれることを確認します。
- `review_task` は既定で Azure OpenAI reviewer を使います。`provider: "openai"` も Azure OpenAI alias として扱います。
- MCP `review_task` の LLM timeout 既定は `GNOSIS_MCP_REVIEW_LLM_TIMEOUT_MS=300000` です。shared host の request timeout 既定は `GNOSIS_MCP_HOST_REQUEST_TIMEOUT_MS=330000` で、host が review LLM より先に切れないようにします。
- strict doctor は `smoke` と MCP contract snapshot を実行し、結果を `logs/quality-gates.json` に保存します。

保守ルール:

- Gnosis primary tool を増減する場合は、`src/mcp/tools/index.ts`, `test/mcpContract.test.ts`, `test/mcpToolsSnapshot.test.ts`, このドキュメント、README の公開面説明を同じ変更で更新します。
- Astmend / diffGuard の shared host tool surface を変える場合は、各 service factory と `test/mcpHostServices.test.ts` / `test/mcpStdioIntegration.test.ts` の代表 tool 期待値を同じ変更で更新します。
- `doctor` の `exposedToolCount` は Gnosis primary surface の件数です。shared host の総 tool 数とは分けて扱います。

---

## Tools

### `initial_instructions`

- **用途**: Gnosis の現在の知識取得・レビュー・保存ツール方針を確認します。
- **出力**: `agentic_search`, `search_knowledge`, `review_task`, `record_task_note`, `doctor` の使い分けガイド。
- **注意**: `activate_project` first-call や `start_task` / `finish_task` は推奨しません。
- **運用ルール**:
  - Failure Firewall / Golden Path context は常時実行ではなく、`agentic_search` または review 判断で必要な場合だけ参照します。
  - 実装から得た知見を `record_task_note` で登録する前に、関連する verify gate を合格させます。
  - verify 合格後かつユーザーが commit を承認した場合、再利用可能な教訓・ルール・手続き・成功/失敗 pattern 候補の登録を検討します。
  - 完了報告前に変更内容をセルフレビューし、改善点を潰してから関連する verify gate を実行します。

### `agentic_search`

- **用途**: ユーザー依頼をタスク文脈として解釈し、今回の作業に本当に必要な知識だけを返します。
- **処理**:
  - `agentic_search` handler は `AgenticSearchRunner` を呼び出します。
  - Runner は native tool calling で `knowledge_search` / `brave_search` / `fetch` を必要時に実行します。
  - 候補採否や回答可否を正規表現で判定せず、追加調査か最終回答かは LLM の tool call 有無で判断します。
- **入力**:
  - `userRequest` (string, 必須): ユーザー依頼または今回のタスク説明
  - `repoPath` (string, 任意)
  - `files` (string[], 任意)
  - `changeTypes` (`frontend|backend|api|auth|db|docs|test|mcp|refactor|config|build|review`[], 任意)
  - `technologies` (string[], 任意)
  - `intent` (`plan|edit|debug|review|finish`, 任意)
- **出力**:
  - MCP レスポンスは最終回答の自然文テキストを返します。
  - CLI (`bun run agentic-search -- --json`) では `toolTrace` / `degraded` / `usage` を確認できます。

### `search_knowledge`

- **用途**: 語句・ベクトル・metadata で近い raw 候補やスコアを確認します。
- **位置づけ**: 通常の知識取得入口ではありません。通常は `agentic_search` を使ってください。
- **検索方式**: `query` / `taskGoal` / files / changeTypes / technologies / intent を1本の query text に整形し、entities の vector / exact / full-text / direct text 候補を merge します。候補0件時だけ recent fallback を使います。
- **入力**:
  - `query` (string, 任意)
  - `taskGoal` (string, 任意)
  - `preset` (`task_context|project_characteristics|review_context|procedures|risks`, 任意)
  - `kinds`, `categories`, `filters`, `files`, `changeTypes`, `technologies`, `grouping`, `traversal` 等（任意）
- **出力**:
  - category 別 `groups`
  - `flatTopHits`
  - `taskContext`
  - `suggestedNextAction`
  - `degraded`（必要時）

### `record_task_note`

- **用途**: 作業中に明示的に得られた再利用可能な知見を保存します。
- **保存対象**:
  - rule
  - lesson
  - procedure
  - skill
  - decision
  - risk
  - command_recipe
- **入力**:
  - `content` (string, 必須): 知見の内容
  - `kind`, `category`, `title`, `purpose`, `tags`, `files`, `evidence`, `confidence`, `source` (任意)

### `review_task`

- **用途**: コード、ドキュメント、実装計画、仕様書等のレビューを実行します。
- **処理**:
  - `targetType=code_diff` は review orchestrator (`runReviewAgentic`) に接続します。
  - `targetType=document|implementation_plan|spec|design` は document reviewer (`reviewDocument`) に接続します。
  - 同期 review が provider/timeout/input で完了できない場合も、MCP error ではなく `status: "degraded"` の JSON を返します。
- **知識注入**: review orchestrator/document reviewer が実際に採用した context だけを `knowledgeUsed` として扱います。raw 候補は直接混ぜません。
- **required policy**: `knowledgePolicy=required` で採用 context が 0 件の場合は、`status: "degraded"` / `reviewStatus: "needs_confirmation"` を返します。
- **入力**:
  - `targetType` (`code_diff|document|implementation_plan|spec|design`, 必須)
  - `target` (object, 必須): `diff`, `filePaths`, `content`, `documentPath` のいずれかを含む
  - `provider` (`local|openai|bedrock|azure-openai`, 任意): `openai` は Azure OpenAI alias として扱います。
  - `reviewMode` (`fast|standard|deep`, 任意)
  - `goal` (string, 任意)
  - `knowledgePolicy` (`off|best_effort|required`, 任意)
  - `diffMode` (`git_diff|worktree`, 任意)
  - `baseRef`, `headRef`, `sessionId` (任意)
  - `enableStaticAnalysis` (boolean, 任意)
- **出力**:
  - `status`: `ok` または `degraded`
  - `reviewStatus`: `changes_requested|needs_confirmation|no_major_findings`
  - `findings`, `summary`, `nextActions`
  - `knowledgeUsed`
  - `diagnostics`: provider, degraded reasons, duration, knowledge policy 等

### `doctor`

- **用途**: MCP サーバーのランタイム状態、DB 接続、知識インデックスの鮮度、メタデータの整合性を診断します。
- **入力**:
  - `clientSnapshot` (任意): クライアント側で保持しているツール情報のスナップショット

---

## 非公開・廃止方針

以下は通常の MCP 公開面から外します。

- `activate_project`: project activation 状態を持たず、診断は `doctor`、知識取得は `agentic_search` に寄せます。
- `start_task`: 低情報量の `task_trace` は新規作成しません。ユーザー依頼の要約と検索は `agentic_search` が行います。
- `finish_task`: 完了ログではなく、再利用可能な知識だけを `record_task_note` または scheduled synthesis で保存します。

旧 memory / graph / experience / review 系の細かいツールは、primary tool の内部実装または CLI / diagnostics 用として扱います。エージェントが通常直接呼ぶ必要はありません。
