# Agent-First Gnosis Refactoring Plan

このドキュメントは、Gnosis の公開面を Agent-First の6 tool に寄せた後の運用ルールと残作業を固定するものです。古い lifecycle tool を復活させず、利用者が迷わない一次導線を維持します。

## 現行 Primary Surface

| tool | 役割 |
| :--- | :--- |
| `initial_instructions` | 最小運用ルールの確認 |
| `agentic_search` | タスク文脈に必要な知識取得 |
| `search_knowledge` | raw 候補・スコア確認 |
| `record_task_note` | 再利用可能な知見保存 |
| `review_task` | code/doc/plan/spec/design review |
| `doctor` | runtime / metadata 診断 |

## 廃止済み導線

- `activate_project`
- `start_task`
- `finish_task`
- 旧 memory/search/register 系の細粒度 MCP tools

これらは通常の MCP 公開面に戻しません。必要な機能は primary tool の内部実装、CLI、または diagnostics に閉じます。

## 不変条件

1. primary tool 数は6件を維持する。
2. tool を増減する場合は `src/mcp/tools/index.ts`, `test/mcpContract.test.ts`, `test/mcpToolsSnapshot.test.ts`, `docs/mcp-tools.md`, README を同時更新する。
3. `review_task` は実レビューまたは degraded JSON を返し、`unavailable_in_minimal_mode` には戻さない。
4. `agentic_search` は LLM finalization が失敗しても、prefetch 済み knowledge がある場合は限定回答を返す。
5. commit 前に verify gate を通し、再利用可能な教訓があれば `record_task_note` へ登録する。

## 実装境界

| 領域 | ファイル |
| :--- | :--- |
| MCP tool schema/handler | `src/mcp/tools/agentFirst.ts` |
| tool registry contract | `src/mcp/tools/index.ts`, `src/mcp/server.ts` |
| agentic search runner | `src/services/agenticSearch/runner.ts` |
| review orchestrator | `src/services/review/orchestrator.ts` |
| document review | `src/services/reviewAgent/documentReviewer.ts` |
| contract tests | `test/mcpContract.test.ts`, `test/mcpToolsSnapshot.test.ts` |

## 変更時 Checklist

1. `agentic_search` / `review_task` の focused tests を追加または更新する。
2. `bun test test/mcpContract.test.ts test/mcpToolsSnapshot.test.ts` を通す。
3. schema 変更が意図的なら snapshot hash を更新する。
4. `bun run smoke` を通す。
5. `GNOSIS_DOCTOR_STRICT=1 bun run doctor` で gate 証跡を更新する。

## 残すべき判断

- queued/asynchronous review は sync `review_task` とは別導線として設計する。
- local LLM の長時間 review は MCP sync timeout の外に出す。
- Monitor UI は gate の最新証跡を表示し、gate 実行自体は snapshot では行わない。
