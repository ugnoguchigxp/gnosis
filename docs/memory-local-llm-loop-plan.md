# Gnosis ローカルLLM優先メモリ運用計画（レビュー用）

> **ステータス**: Draft for cross-AI review  
> **作成日**: 2026-04-17  
> **基準文書**: `docs/memory-refactoring.md` の実装済み方針を拡張

---

## 1. 目的

- `openai / bedrock / bonsai / gemma4` の4系統を使い分け、**可能な限り local LLM を使う**運用基盤を定義する。
- ストーリー記憶作成を定期ループ化し、エピソード記憶・手続き記憶・Knowledge Graph の更新を継続実行する。
- 手続き記憶に「どのプロジェクト/領域で使えるか」を明示し、`query_procedure` で実行時フィルタ可能にする。
- ループ処理はデフォルトで有料APIを使わず、必要時のみ `openai/bedrock` へ**切り替え可能**な構成にする。

---

## 2. 前提（現状）

以下は既に実装済み:

- `consolidate_episodes`（raw -> episode）  
  `src/services/consolidation.ts`
- `query_procedure` / `record_outcome`（手続き記憶 + confidence更新）  
  `src/services/procedure.ts`
- `scope:'always'` の自動注入  
  `src/mcp/server.ts`
- LLM alias 切替（`gemma4|bonsai|openai|bedrock`）  
  `src/scripts/local-llm-cli.ts`

今回の計画は、上記を前提に**運用ループ化と適用条件強化**を行う。

---

## 3. 方針（合意内容）

1. **Local-first**  
   ループ処理は `gemma4`/`bonsai` をデフォルト利用し、有料APIはデフォルト無効とする。
2. **Switchable cloud path**  
   `openai`/`bedrock` は無効化可能な切替経路として実装し、必要時に明示的に有効化する。
3. **評価の分離**  
   KG評価は「構造チェック=決定論（SQL/Graph）」「意味評価=LLM」で分離し、再現性を確保する。
4. **適用対象を構造化**  
   手続き記憶に `applicability` フィールドを持たせ、プロジェクト/言語/領域でフィルタする。
5. **段階導入**  
   スキーマ追加なしで開始できる部分は `metadata` で先行導入し、必要に応じて後から列追加を検討する。

---

## 4. LLMルーター設計（local優先）

### 4-1. タスク別の推奨モデル

- `consolidate_episodes`: `gemma4`（第一候補）
- `reflect_on_memories` 由来の抽出/要約: `gemma4`
- 軽量分類・タグ付け・短文正規化: `bonsai`
- ループ系タスクのデフォルト経路: `gemma4` -> `bonsai`（local 内で完結）
- `openai` / `bedrock`: `MEMORY_LOOP_ALLOW_CLOUD=true` のときのみ選択対象

### 4-2. フォールバック条件（例）

- JSON parse 失敗が連続2回
- 出力スキーマバリデーション失敗が連続2回
- 自己評価スコア（任意実装）< 0.6
- 高リスク操作（セキュリティ/重大設計変更）としてフラグされた場合

注記:

- デフォルトでは cloud へ自動フォールバックしない（ローカル再試行のみ）。
- cloud への切替は feature flag 有効時のみ許可する。

### 4-3. 実装ポイント

- `src/services/llm.ts` 直接呼び出しを、`LlmRouter` 層（新設）経由に集約する。
- ルーター入力:
  - `taskKind`（consolidation / extraction / evaluation / repair-json 等）
  - `riskLevel`
  - `retryCount`
- ルーター出力:
  - 使用 alias
  - degraded/failed reason
  - 次フォールバック候補
- 追加設定（例）:
  - `MEMORY_LOOP_ALLOW_CLOUD=false`（デフォルト）
  - `MEMORY_LOOP_CLOUD_PROVIDER=openai|bedrock`
  - `MEMORY_LOOP_DEFAULT_ALIAS=gemma4`
  - `MEMORY_LOOP_LIGHT_ALIAS=bonsai`

---

## 5. ストーリー記憶作成ループ（cron/worker）

### 5-1. ループ構成

1. **5分間隔（デフォルト）**
   - セッションごとの raw 件数を確認
   - 閾値以上で `consolidate_episodes`
2. **5分間隔（同一ループ内で条件実行）**
   - `reflect_on_memories` を実行し、episode から task/constraint/context を抽出
   - 実行対象がない場合はスキップ
3. **1日1回**
   - KG品質監査（重複、循環、孤立ノード、低confidence）
4. **週1回**
   - `confidence < 0.1` 候補の見直しと deprecate 提案

### 5-2. 実行基盤

- 既存の worker/queue（`src/services/knowflow/worker/*`）を活用し、memory loop タスクを追加する。
- もしくは初期段階では cron から CLI を直接呼び出す:
  - `consolidate_episodes` 相当
  - `reflect_on_memories`
  - KG audit スクリプト（新設）
- ループ運用ポリシー:
  - デフォルトは local LLM のみ（有料API呼び出し 0 を目標）
  - 必要時は flag で `openai` または `bedrock` に切替可能
  - 切替時も対象は限定タスクのみに制約する

---

## 6. 手続き記憶の適用対象フィールド

`entities.metadata.applicability` に以下を格納する（初期案）。

```json
{
  "projects": ["gnosis", "backendMock"],
  "domains": ["programming", "infra", "cli", "batch"],
  "languages": ["python", "typescript", "rust"],
  "frameworks": ["drizzle-orm", "tauri"],
  "environments": ["local", "docker", "k8s", "aws"],
  "repos": ["github.com/ugnoguchigxp/gnosis"]
}
```

### 6-1. `query_procedure` 拡張案

入力パラメータを追加:

- `project?: string`
- `domains?: string[]`
- `languages?: string[]`
- `frameworks?: string[]`
- `environment?: string`

フィルタロジック:

- `when` relation による context 適合
- `metadata.applicability` の一致
- 上記2つの AND 条件で最終候補を決定

---

## 7. Knowledge Graph評価（local LLM活用）

### 7-1. 決定論チェック（LLM不要）

- 重複候補: 同一 type + 近似 name
- 循環検出: `precondition` / `follows` サイクル
- 孤立ノード: 入出次数が極端に低い task
- 長期未参照ノード: `lastReferencedAt` が古いノード

### 7-2. LLMチェック（local）

- 重複候補ペアが実質同義か判定
- description 品質（短すぎ/曖昧すぎ）改善提案
- relationType の妥当性提案（`depends_on` -> `precondition` など）

評価時モデル:

- 第一候補 `gemma4`
- 大量バッチ軽量判定に `bonsai`
- デフォルトは local-only
- 必要時のみ `openai` / `bedrock` に切替（feature flag 前提）

---

## 8. 実装フェーズ案

### Phase A: ルーター導入

- `LlmRouter` 新設（taskKindベースの alias 選択 + fallback）
- `consolidation/synthesis/procedure` の LLM呼び出しをルーター経由化

### Phase B: 適用対象フィルタ

- `register_guidance` に `applicability.projects/domains/environments/repos` を追加
- `query_procedure` 入力拡張とフィルタ実装

### Phase C: ループ自動化

- memory loop runner（cron/worker）実装
- raw閾値・実行間隔・失敗時リトライポリシーを設定可能化

### Phase D: KG監査

- 決定論監査ジョブ追加
- local LLM による意味監査ジョブ追加
- `record_outcome` と連携して confidence 推移を追跡

---

## 9. 成功指標（レビュー観点）

- ループでの有料API呼び出し件数（デフォルト 0）
- `consolidate_episodes` の成功率
- `query_procedure` の採用率（返却タスクが実行される割合）
- `record_outcome` 後の confidence 安定性（急激な振動の減少）
- 適用ミスマッチ率（他プロジェクト向け手順が混入する率）の低下
- `MEMORY_LOOP_ALLOW_CLOUD` 切替時の動作整合性（provider選択/監査ログ）

---

## 10. 未決事項（他AIレビュー依頼ポイント）

1. `applicability` を metadata運用で継続するか、将来列追加するか
2. local再試行から cloud切替に進む閾値（2回失敗/0.6未満）の妥当性
3. `bonsai` をどの処理まで任せるか（構造抽出の可否）
4. KG監査の実行頻度（1日1回 vs 6時間毎）
5. `query_procedure` のフィルタを AND 固定にするか、重み付けにするか

---

## 11. 実装タスク分解（着手順）

### 11-1. Phase A: LlmRouter 導入

目的:

- ループ系処理を local-first / switchable-cloud の単一経路で制御する。

変更対象:

- `src/config.ts`
- `src/services/llm.ts`
- `src/services/consolidation.ts`
- `src/services/synthesis.ts`
- `src/services/procedure.ts`
- `src/scripts/local-llm-cli.ts`（必要時）

作業項目:

1. `MemoryLoopLlmConfig` を追加し、ループ向けの flag を定義する。
2. `LlmRouter` を新設し、`taskKind`/`retryCount`/`riskLevel` で alias を決定する。
3. 既存 LLM 呼び出し箇所をルーター経由に置換する。
4. cloud が無効時は `openai`/`bedrock` 選択を拒否し、ローカル再試行のみ実行する。
5. 実行ログに `selectedAlias`, `fallbackAttempt`, `cloudEnabled` を出力する。

受け入れ条件:

- デフォルト設定で cloud 呼び出しが 0 件であること。
- `MEMORY_LOOP_ALLOW_CLOUD=true` 時のみ cloud alias が選択可能であること。
- 既存 `consolidate_episodes` / `query_procedure` / `record_outcome` が非破壊で動作すること。

### 11-2. Phase B: 適用対象フィルタ実装

目的:

- 手続き記憶をプロジェクト/領域/言語ごとに適切に絞り込む。

変更対象:

- `src/mcp/tools/guidance.ts`
- `src/services/guidance/register.ts`
- `src/mcp/tools/queryProcedure.ts`
- `src/services/procedure.ts`
- `src/domain/schemas.ts`

作業項目:

1. `register_guidance` の `applicability` に `projects/domains/environments/repos` を追加する。
2. `query_procedure` 入力に `project/domains/languages/frameworks/environment` を追加する。
3. `when` relation と `metadata.applicability` の AND フィルタを実装する。
4. 条件に合わないタスクは除外し、除外理由をデバッグログに残す。

受け入れ条件:

- 異なる project を指定した場合、対象外 task が返らないこと。
- `context` のみ指定した従来呼び出しが後方互換で動作すること。

### 11-3. Phase C: 5分ループ自動化

目的:

- ストーリー化と反映を 5分間隔で継続実行する。

変更対象:

- `src/services/knowflow/worker/knowFlowHandler.ts` または memory loop 専用 runner（新設）
- `src/services/knowflow/cli.ts`（必要時）
- `src/mcp/tools/memory.ts`

作業項目:

1. 5分ごとのループで `consolidate_episodes` 条件判定を実行する。
2. 同ループで `reflect_on_memories` を条件実行（対象なしは skip）する。
3. 日次/週次監査タスクのキュー投入を追加する。
4. 失敗時バックオフと最大連続失敗時の circuit break を定義する。

受け入れ条件:

- 5分ループが idle 時に不要な LLM 呼び出しを行わないこと。
- 連続失敗時に無限リトライにならないこと。

### 11-4. Phase D: KG 監査ジョブ

目的:

- 決定論監査 + local LLM 監査で KG を保守する。

変更対象:

- `src/services/community.ts`
- `src/services/procedure.ts`（confidence 連携）
- `src/scripts/` 配下に audit スクリプト新設（必要時）

作業項目:

1. 重複/循環/孤立/長期未参照の決定論チェックを実装する。
2. local LLM で description/relation 妥当性提案を生成する。
3. `confidence < 0.1` の deprecate 候補を記録する。

受け入れ条件:

- 監査結果が再実行で安定すること（決定論パート）。
- local-only 既定で監査が完結すること。

---

## 12. 設定契約（Environment Variables）

| 変数名 | 既定値 | 用途 |
|---|---|---|
| `MEMORY_LOOP_ALLOW_CLOUD` | `false` | ループで cloud LLM を許可するか |
| `MEMORY_LOOP_CLOUD_PROVIDER` | `openai` | cloud 利用時の優先プロバイダ |
| `MEMORY_LOOP_DEFAULT_ALIAS` | `gemma4` | 通常処理の第一候補 |
| `MEMORY_LOOP_LIGHT_ALIAS` | `bonsai` | 軽量処理の候補 |
| `MEMORY_LOOP_INTERVAL_MS` | `300000` | ループ間隔（5分） |
| `MEMORY_LOOP_MAX_LOCAL_RETRIES` | `2` | local 再試行回数 |
| `MEMORY_LOOP_ENABLE_DAILY_AUDIT` | `true` | 日次監査の有効化 |
| `MEMORY_LOOP_ENABLE_WEEKLY_AUDIT` | `true` | 週次監査の有効化 |

実装ルール:

- 既定値では `openai/bedrock` に一切到達しない。
- cloud 利用時は provider と理由を必ずログに記録する。

---

## 13. テスト計画（最小セット）

### 13-1. Unit

- `LlmRouter`:
  - cloud 無効時に cloud alias を返さない
  - cloud 有効時に `MEMORY_LOOP_CLOUD_PROVIDER` に従う
  - retry 回数で `gemma4 -> bonsai` の遷移が起きる
- `query_procedure`:
  - applicability 条件一致時のみ task が返る
  - context のみ指定した従来ケースが壊れない

### 13-2. Integration

- 5分ループ1サイクルで
  - raw -> episode が生成される
  - reflect が episode を処理する
  - 対象なし時は skip される
- cloud 無効構成で外部API呼び出しが発生しない

### 13-3. Regression

- `consolidate_episodes`, `query_procedure`, `record_outcome` の既存テストが維持される
- `register_guidance` の旧入力（現行フィールド）で登録可能

---

## 14. 運用ガードレール

1. ループタスクの cloud 呼び出しは flag で明示許可されない限り禁止。
2. cloud 許可時でも対象タスクを限定し、全タスクへの自動拡大をしない。
3. 有料API利用回数をメトリクス化し、しきい値超過時に通知する。
4. 失敗時は local-only モードへ自動復帰できるようにする。

---

## 15. ロールバック方針

1. `MEMORY_LOOP_ALLOW_CLOUD=false` に戻して cloud 経路を即停止する。
2. `LlmRouter` 導入前の呼び出し経路を feature flag で残し、段階的切戻しを可能にする。
3. applicability フィルタで障害が出た場合は、`query_procedure` を context-only フィルタに一時退避する。
