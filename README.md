# Gnosis: Agent-First Memory and Review MCP

Gnosis は、LLM エージェント向けの agent-first な知識・記憶・レビュー基盤です。  
MCP サーバーとして動作し、一次導線は `agentic_search` と `review_task` を中心に設計されています。

中核ワークフローは、再利用可能な knowledge（rule/lesson/procedure/skill/decision/risk/command recipe）に寄せています。

## 5分で最小起動 (minimal)

### 前提条件
- Bun 1.1+
- Docker (`postgres` コンテナ起動用)
- Python 3.10+（embedding サービス初期化で使用）

### 最短手順
```bash
git clone https://github.com/ugnoguchigxp/gnosis.git
cd gnosis
bun run bootstrap
bun run doctor
bun run onboarding:smoke
```

`onboarding:smoke` が成功すれば最小導線は完了です。
各 smoke / verify / doctor の結果は `logs/quality-gates.json` に保存され、Monitor UI で確認できます。

## 構成別セットアップ

| 構成 | 想定用途 | 実行コマンド |
| :--- | :--- | :--- |
| no-local-llm / minimal | ローカル LLM を入れずに起動確認したい | `bun run bootstrap` |
| local-llm | ローカル LLM も使いたい | `bun run bootstrap:local-llm` |
| cloud-review | cloud reviewer を使いたい | `.env` に `.env.cloud-review` の必要項目を追記 |

利用テンプレート:
- `.env.minimal`
- `.env.local-llm`
- `.env.cloud-review`
- `.env.example`（テンプレート案内用）

ローカル LLM を一切入れない導入は [Local LLM なしセットアップ](docs/no-local-llm-setup.md) を参照してください。

## Local LLM の有無

Gnosis の最小導線は local LLM を必要としません。minimal では PostgreSQL、embedding CLI、Agent-First MCP、`doctor`、`search_knowledge`、`record_task_note` を使えます。cloud-review を設定すれば、local LLM なしでも `agentic_search` と `review_task` の LLM レビュー導線を使えます。

local LLM を設定すると、Gemma4/Bonsai 系のローカル推論、KnowFlow の LLM rerank、local review、memory loop のローカル処理などが追加で使えるようになります。local LLM は拡張導線であり、最初の価値確認には必須ではありません。

## MCP 公開面

- Gnosis 本体の primary tool surface は Agent-First の一次導線に固定しています。
- Gnosis primary tools は `initial_instructions / agentic_search / search_knowledge / record_task_note / review_task / doctor / memory_search / memory_fetch` の8件です。
- stdio adapter が接続する shared host では、上記8件に加えて Astmend と diffGuard の MCP service tools も同一 `tools/list` に集約されます。
- `agentic_search` は通常の知識取得入口です。`search_knowledge` は raw 候補やスコアを確認する低レベル検索です。
- `memory_search` / `memory_fetch` は context 圧縮後に `vibe_memories` の過去会話・作業断片・保存回答を部分確認する補助導線です。entity knowledge の代替ではなく、取得内容は現行ファイルやユーザー指示と照合して使います。
- `memory_search` は薄い一覧だけを返し、`memory_fetch` は必要箇所だけを読む fetch 導線です。範囲指定がない場合は query match 周辺を既定1000文字で返し、`maxChars` は最大5000文字です。

### 成功例

`agentic_search` は、実装前に今回の作業へ効く過去知識を自然文で返す導線です。

```ts
await agentic_search({
  userRequest: 'review_task の provider default を変更する前に、過去の方針を確認したい',
  repoPath: '/Users/y.noguchi/Code/gnosis',
  changeTypes: ['mcp', 'config', 'review'],
  intent: 'edit',
});
```

期待される結果は、raw 候補一覧ではなく「Azure OpenAI alias、timeout、knowledge injection の既存方針を確認してから変更する」といった、今回使う判断材料に絞られた回答です。

`review_task` は、実装計画や diff を過去知識込みでレビューする導線です。

```ts
await review_task({
  targetType: 'implementation_plan',
  target: { documentPath: 'docs/review-task-improvement-plan.md' },
  knowledgePolicy: 'best_effort',
});
```

期待される結果は、指摘事項、残リスク、実際に使った知識 (`knowledgeUsed`) を含むレビューです。knowledge retrieval が degraded の場合も、未選別候補を混ぜずに診断情報として扱います。
provider 未設定や timeout などで同期レビューを完了できない場合も、MCP timeout ではなく `status: "degraded"` の JSON を返します。

`memory_search` / `memory_fetch` は、context 圧縮で過去会話の細部が失われた可能性がある場合にだけ使う補助導線です。

```ts
const results = await memory_search({
  query: 'review_task timeout knowledge retrieval',
  mode: 'hybrid',
  limit: 5,
});

await memory_fetch({
  id: results.items[0].id,
  query: 'review_task timeout',
  maxChars: 1000,
});
```

`memory_search` は raw JSON や metadata 全体を返さず、候補 id と snippet を返します。`memory_fetch` は `start` / `end` の 0-based UTF-16 index を指定するとその範囲を優先し、未指定の場合は hit 語句周辺を抜粋します。これは context 圧縮の回避策であり、通常の方針確認は `agentic_search`、raw 候補や score の確認は `search_knowledge` を使います。

## 品質チェック

`verify` は品質ゲートを一括実行します。

```bash
bun run verify:fast
bun run verify
bun run verify:strict
GNOSIS_DOCTOR_STRICT=1 bun run doctor
bun run agentic-search:semantic-smoke
```

実行内容:
- `verify:fast` / `verify`: `format-check` / `lint` / `typecheck` / `build` / `test`
- `verify:strict`: `verify` + `coverage` + `failure-path` + `smoke` + `flaky-check` + `integration-local`
- `GNOSIS_DOCTOR_STRICT=1 bun run doctor`: 通常診断 + `smoke` + MCP contract snapshot
- `agentic-search:semantic-smoke`: `agentic_search` の live 回答が現行 public surface と矛盾しないことを確認

## 日常コマンド

```bash
bun run start
bun run doctor
bun run db:init
bun run verify
bun run maintenance
```

## 主要機能

| 機能 | 説明 |
| :--- | :--- |
| Agent-First MCP | `initial_instructions`, `agentic_search`, `search_knowledge`, `review_task`, `memory_search`, `memory_fetch` などの一次導線と補助導線 |
| Vibe Memory | ベクトル + メタデータ検索による長期記憶 |
| Knowledge Graph | 関係性を扱う Graph RAG |
| Review | コード/ドキュメント/実装計画レビュー |
| KnowFlow | 自律的な知識収集タスク（キュー/ワーカー） |
| Monitor UI | Tauri + SvelteKit の管理画面 |

## アーキテクチャ（概要）

```text
┌─────────────────────────────────────────────────────────────┐
│                    MCP Clients (IDE/Agents)                 │
└──────────────────────────────┬──────────────────────────────┘
                               │ MCP Protocol
┌──────────────────────────────▼──────────────────────────────┐
│                      Gnosis Core (Bun)                      │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ Agent-First Tools / Memory / Graph / Review / KnowFlow│ │
│  └──────┬───────────────────────────┬─────────────────────┘ │
│         │                           │                       │
│  ┌──────▼──────┐             ┌──────▼──────┐                │
│  │ PostgreSQL  │             │  Local LLM  │                │
│  │ (pgvector)  │             │ (optional)  │                │
│  └─────────────┘             └─────────────┘                │
└─────────────────────────────────────────────────────────────┘
```

## ドキュメント

- [Startup Guide](docs/startup.md)
- [Configuration](docs/configuration.md)
- [MCP Tools](docs/mcp-tools.md)
- [KnowFlow Guide](docs/knowflow-guide.md)
- [Operations Runbook](docs/operations-runbook.md)
- [Project Value Improvement Plan](docs/project-value-improvement-plan.md)
- [Review Task Improvement Plan](docs/review-task-improvement-plan.md)
- [No Local LLM Setup](docs/no-local-llm-setup.md)
- [Success Examples](docs/examples/agentic-search-success.md)

## ライセンス

MIT
