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
- Gnosis primary tools は `initial_instructions / agentic_search / search_knowledge / record_task_note / review_task / doctor` の6件です。
- stdio adapter が接続する shared host では、上記6件に加えて Astmend と diffGuard の MCP service tools も同一 `tools/list` に集約されます。
- `agentic_search` は通常の知識取得入口です。`search_knowledge` は raw 候補やスコアを確認する低レベル検索です。

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

## 品質チェック

`verify` は品質ゲートを一括実行します。

```bash
bun run verify:fast
bun run verify
bun run verify:strict
GNOSIS_DOCTOR_STRICT=1 bun run doctor
```

実行内容:
- `verify:fast` / `verify`: `format-check` / `lint` / `typecheck` / `build` / `test`
- `verify:strict`: `verify` + `coverage` + `failure-path` + `smoke` + `flaky-check` + `integration-local`
- `GNOSIS_DOCTOR_STRICT=1 bun run doctor`: 通常診断 + `smoke` + MCP contract snapshot

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
| Agent-First MCP | `initial_instructions`, `agentic_search`, `search_knowledge`, `review_task` などの一次導線 |
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
- [Data Layers](docs/data-layers.md)
- [KnowFlow Guide](docs/knowflow-guide.md)
- [Operations Runbook](docs/operations-runbook.md)
- [Release Checklist](docs/release-checklist.md)
- [Active-Use Improvement Plan](docs/active-use-improvement-plan.md)
- [Agent-First Refactoring Plan](docs/agent-first-gnosis-refactoring-plan.md)

## ライセンス

MIT
