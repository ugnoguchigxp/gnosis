# Serena類似機能の TypeScript 移植計画（Python最小化）

## 1. 結論

Serena類似機能（シンボル探索・参照・編集、文脈管理、記憶同期）は **TypeScript/Bun で実装**する。  
Python は **MLX 推論の起動・実行レイヤーのみ**に限定する。

要するに役割分担は次のとおり:

- TypeScript:
  - エージェント制御、Tool Loop、MultiMCP、semantic-code MCP、レビュー連携
- Python:
  - `mlx-lm` モデルロードと推論 API（または最小CLI）提供のみ

---

## 2. 現状とギャップ

現状は `services/local-llm/main.py` 側に以下が混在している:

- 推論制御
- MCP接続
- Tool Call 解析と実行
- セッション管理

この構造だと、Serena類似機能をTS側に育てる際に責務が分断される。  
したがって **リファクタリングは必須**（中〜大規模）。

---

## 3. ターゲット構成（責務分離）

### A. Python（最小）

- 役割:
  - MLXモデルのロード
  - 推論実行（chat completion）
- 提供形態:
  - OpenAI互換HTTP API（推奨）または最小CLI
- 非責務:
  - MCP接続
  - Tool Loop
  - セッションオーケストレーション

### B. TypeScript（主制御）

- 役割:
  - Agent Runtime（対話/ツール反復）
  - MultiMcpClient（`gnosis` + `semantic-code` + 将来拡張）
  - Serena類似機能（symbol-aware retrieval/editing）
  - reviewer/coderプロファイル別 tool allowlist

---

## 4. Serena類似機能のTS実装スコープ

## Phase S1: read-only semantic tools（最優先）

`src/scripts/semanticCodeMcpServer.ts` を新規作成し、次を提供:

- `get_symbols_overview`
- `find_symbol`
- `find_references`
- `read_symbol`
- `search_pattern`

備考:
- 初期対象は TypeScript/JavaScript を優先
- 編集系はこのフェーズでは入れない

## Phase S2: safe editing tools（段階導入）

read-only の安定後に以下を追加:

- `replace_symbol_body`
- `insert_before_symbol`
- `insert_after_symbol`
- `rename_symbol`（影響範囲確認付き）

制約:
- `reviewer` プロファイルでは常に無効化
- `coder` のみ有効化

## Phase S3: memory/context連携

- semantic-code の参照結果を Gnosis graph/memory と連結
- Hook 経由で変更後の知識更新を自動化

---

## 5. リファクタリング計画（Python最小化）

## Phase R0: 互換レイヤー維持（即時）

目的:
- 既存導線を壊さず、TS主導への移行足場を作る

作業:
- 現行 `scripts/gemma4` / `scripts/qwen27b` は維持
- MultiMCP は既存実装を利用（暫定）

## Phase R1: TS Agent Runtime 新設

目的:
- Tool Loop と MCP制御をTS側へ移す

作業:
- 新規: `src/services/localAgent/runtime.ts`（仮）
  - メッセージ整形
  - tool call 解析
  - call -> tool result -> 再推論の反復
- 新規: `src/services/localAgent/localMlxClient.ts`（仮）
  - Python推論APIへのHTTPクライアント

## Phase R2: Python main.py 依存の解体

目的:
- Pythonの責務を「MLX推論のみ」に限定

作業:
- `src/scripts/local-llm-cli.ts` の `gemma4/qwen27b/bonsai` 実行先を段階的にTS runtimeへ切替
- `services/local-llm/main.py` のMCP/Tool処理を非推奨化

## Phase R3: 旧経路の整理

目的:
- 重複実装を排除し保守コストを削減

作業:
- Python側の chat/tool orchestration ロジックを削減
- README/起動手順をTS主導へ更新

---

## 6. 影響ファイル（初期見積）

- 既存更新:
  - `src/scripts/local-llm-cli.ts`
  - `src/services/review/llm/localProvider.ts`
  - `src/services/review/llm/reviewer.ts`
  - `services/local-llm/main.py`（段階的に縮小）
- 新規追加（予定）:
  - `src/scripts/semanticCodeMcpServer.ts`
  - `src/services/localAgent/runtime.ts`
  - `src/services/localAgent/localMlxClient.ts`
  - `src/services/localAgent/toolPolicy.ts`

---

## 7. 受け入れ基準（DoD）

1. Python停止時に失われる機能が「MLX推論」以外に存在しない（責務分離完了）
2. semantic-code read-only ツールで主要探索ユースケースをカバー
3. `reviewer` で編集系ツールが発火しない
4. 2000行級 diff のレビューでタイムアウト率が許容範囲内
5. 既存 review パイプライン（DiffGuard/Astmend）と後方互換を維持

---

## 8. リスクと対策

### リスク1: TS移行中の二重実装で挙動差が出る

- 対策: 期間限定で dual-run 比較（旧Python経路と新TS経路）を実施

### リスク2: semantic-code の精度不足

- 対策: read-only を先に本番投入し、ログで誤検知傾向を計測してから編集系を解放

### リスク3: Python最小化に伴う性能劣化

- 対策: Python側はモデル常駐・再ロード抑制を維持し、TSはAPI呼び出しのみ担当

---

## 9. 実施順（推奨）

1. S1（semantic read-only）  
2. R1（TS runtime）  
3. R2（Python責務縮小）  
4. S2（safe editing）  
5. S3（memory/context連携）  
6. R3（旧経路整理）
