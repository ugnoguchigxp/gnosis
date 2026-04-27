# Qwen + MultiMCP 実行計画（統合版）

## 目的

`M4 MacBook Air (32GB)` で `Qwen3-14B-4bit` を主力にしつつ、

- Serena類似機能を **TypeScript/Bun で実装**
- Pythonは **MLX推論の実行レイヤー最小限** に限定
- エージェント実行基盤は **MultiMcpClient** で拡張可能に維持

を同時に進める。

---

## 統合方針

本ドキュメントは「実行順と現状ステータス」を管理する。  
設計原則と責務分離の詳細は [serena-function.md](/Users/y.noguchi/Code/gnosis/docs/serena-function.md) を正本とする。

- `docs/serena-function.md`: TS移植の思想、責務分離、Python最小化、長期ロードマップ
- `docs/qwen+multiMcpClient.md`（本書）: 実装順、完了/未完了、次アクション

---

## 現在の実装ステータス

## 完了済み

1. `qwen` alias 追加
- `scripts/qwen`
- `src/scripts/local-llm-cli.ts`
- `src/services/review/llm/*` の reviewer alias 対応

2. MultiMCP基盤（Python側）追加
- `services/local-llm/vibe_mcp/client.py` を複数サーバー対応
- `LOCAL_LLM_MCP_ENABLE_SEMANTIC` で `semantic-code` サーバーを追加起動可能
- ツール名衝突時の `server__tool` ルーティング対応

3. `semanticCodeMcpServer.ts` 最小実装（read-only）
- `semantic_list_files`
- `semantic_search_pattern`
- `semantic_get_symbols_overview`
- `semantic_find_symbol`
- `semantic_read_symbol`
- `semantic_find_references`

4. read-only semantic ツールのユニットテスト追加
- `test/semanticCodeMcpServer.test.ts`
- `bun test test/semanticCodeMcpServer.test.ts` で主要ケースを検証

## 未完了（次フェーズ）

1. **TS主導 runtime への移行**
- 現在は Python `main.py` に Tool Loop/MCP処理が残存
- これを TS runtime に段階移管する必要がある

2. **reviewer/coder ツールポリシーの実装固定化**
- 実運用で編集系ツールが reviewer から呼ばれない保証をコード化

3. **Python責務の最小化**
- Pythonは推論APIのみ提供する形に整理（MCP/Tool Loop を剥離）

---

## フェーズ計画（更新版）

## Phase A（進行中）: TS read-only semantic 安定化

### 目的

- Serena類似の探索・参照機能を TS で先行運用する

### 作業

- `semanticCodeMcpServer.ts` のテスト追加（完了）
- 出力スキーマ固定（将来互換のため）
- 大規模repo向けに結果件数上限・タイムアウトを調整

### 完了条件

- 主要ユースケース（symbol探索/参照/抜粋）を read-only でカバー
- 型チェック・最低限の動作テストが通る

---

## Phase B: TS Agent Runtime 新設

### 目的

- Tool Loop / MCP制御を TypeScript 側へ寄せる

### 作業

- 新規（予定）
  - `src/services/localAgent/runtime.ts`
  - `src/services/localAgent/localMlxClient.ts`
  - `src/services/localAgent/toolPolicy.ts`
- `src/scripts/local-llm-cli.ts` の local alias を段階的に TS runtime 経由へ切替

### 完了条件

- 対話の tool-calling 反復が TS 側のみで完結
- Pythonなしではなく、Pythonを「推論呼び出し専用」に限定できる

---

## Phase C: Python最小化

### 目的

- Python責務を MLX 推論のみに限定する

### 作業

- `services/local-llm/main.py` の MCP/Tool orchestration を非推奨化
- 推論専用経路（HTTP API or 最小CLI）を標準導線に固定

### 完了条件

- Python停止で影響する機能が推論以外にない
- MCP/ツール制御は TS 側で一元管理

---

## Phase D: safe editing tools（TS）

### 目的

- Serena類似の安全な編集ツールを段階追加

### 作業

- `semantic_replace_symbol_body`
- `semantic_insert_before_symbol`
- `semantic_insert_after_symbol`
- `semantic_rename_symbol`（影響範囲検証付き）

### 完了条件

- `coder` のみ編集系を利用可能
- `reviewer` は read-only を維持

---

## 推奨環境変数（現行）

```env
QWEN_MODEL=mlx-community/Qwen3-14B-4bit
GNOSIS_REVIEWER=qwen

LOCAL_LLM_MCP_ENABLE_SEMANTIC=true
LOCAL_LLM_SEMANTIC_COMMAND=bun
LOCAL_LLM_SEMANTIC_ARGS=run /Users/y.noguchi/Code/gnosis/src/scripts/semanticCodeMcpServer.ts
GNOSIS_MCP_TOOL_EXPOSURE=all
```

---

## 受け入れ基準（更新）

1. `qwen` が本番導線で安定利用できる  
2. `gnosis + semantic-code` の MultiMCP 同時接続が安定  
3. read-only semantic ツールの主要操作が実運用で再現可能  
4. reviewer の編集系ツール禁止をコードで強制  
5. Python責務が「MLX推論」以外へ広がらない

---

## 次アクション

1. `semanticCodeMcpServer.ts` のテスト追加  
2. reviewer/coder の tool allowlist 実装  
3. TS runtime 新設（Tool Loop移管）  
4. Python main.py の責務縮小
