# KnowFlow 統合・一括移行計画書

## 1. 目的
KnowFlow 実装を Gnosis の第一級サービスとして再編し、以下を同時達成する。
- ディレクトリ構成の標準化 (`services`, `adapters`)
- 設定読み込みの一本化 (`src/config.ts`)
- DB 参照経路の一本化 (`src/db/index.ts`)
- MCP サーバー import の直参照化（バレル廃止）
- 型安全性改善（`mcpRetriever`, `runLlmTask`）

## 2. 変更方針
段階移行ではなく、1 回の変更セットで以下を一括実施する。

## 3. ディレクトリ移設マッピング
### 3.1 Adapters
- `src/knowflow/adapters/llm.ts` -> `src/adapters/llm.ts`
- `src/knowflow/adapters/retriever/mcpRetriever.ts` -> `src/adapters/retriever/mcpRetriever.ts`

### 3.2 Services
- `src/knowflow/` 配下の上記以外 -> `src/services/knowflow/`

### 3.3 削除対象
- `src/knowflow/index.ts`（バレル）
- `src/knowflow/db/pg.ts`（テスト用シム）
- `src/knowflow/config/llm.ts`
- `src/knowflow/config/budget.ts`

## 4. 設定統合
`src/config.ts` に KnowFlow 設定を統合する。

### 4.1 追加する型・スキーマ
- `CliPromptModeSchema`
- `LlmClientConfigSchema`
- `BudgetConfigSchema`

### 4.2 `config` への追加
- `config.knowflow.llm`（`LOCAL_LLM_*` 環境変数）
- `config.knowflow.budget`（`USER_BUDGET`, `CRON_BUDGET`, `CRON_RUN_BUDGET`）

### 4.3 互換方針
- 既存の環境変数名は維持し、デフォルト値も現行互換を原則とする。
- 呼び出し側は `src/config.ts` の `config` 参照へ変更。

## 5. DB 接続統一
- KnowFlow 関連リポジトリは `src/db/index.ts` の `db` 直接参照を維持。
- 旧シム経由 import を排除する。
- テストで旧シムを使う箇所は削除または `src/db/index.ts` 側 API へ置換。

## 6. MCP サーバー更新
`src/mcp/server.ts` の KnowFlow import をバレル依存から個別 import に変更。
対象例:
- `PgJsonbQueueRepository`
- `PgKnowledgeRepository`
- `createKnowFlowTaskHandler`
- `createLocalLlmRetriever`
- `runWorkerOnce`

## 7. 型安全性改善
### 7.1 `src/adapters/retriever/mcpRetriever.ts`
- `callTool` 結果を `unknown` として受け取り、型ガードで `content` 配列を検証。
- `any` キャストと不要 suppression を削除。

### 7.2 `runLlmTask`（`src/adapters/llm.ts`）
- `input.context` が plain object であることを型ガードで強制。
- 解析不能 context の場合は明示的に例外化。

## 8. テスト・参照更新
- `test/knowflow/*` の import パスを新配置へ更新。
- CLI usage 表記を移設後パスへ更新。

## 9. 検証
実装後に以下を実行する。
- `npx tsc --noEmit`
- `bun test test/knowflow/`
- `npx biome check .`

## 10. リスクと対策
- リスク: 相対 import ずれによるコンパイルエラー。
  - 対策: 移設後に `tsc` で網羅チェックし、`rg "from '"` で未更新 import を探索。
- リスク: `config` 統合時のデフォルト値差分。
  - 対策: 旧実装と同値の fallback を維持。
- リスク: バレル削除に伴う単一箇所依存漏れ。
  - 対策: `rg "knowflow/index"` で参照ゼロを確認。

## 11. 完了条件
- `src/knowflow/` が存在しないか、空ディレクトリのみ。
- KnowFlow 関連 import が `src/services/knowflow` / `src/adapters` に集約される。
- `src/mcp/server.ts` が `src/knowflow/index.ts` 非依存。
- 上記検証コマンドの実行結果を記録（実行不可の場合は理由を明記）。
