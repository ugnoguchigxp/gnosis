# KnowFlow 仕様変更計画書（Cron起動・教訓/ストーリー起点）

作成日: 2026-04-18
更新日: 2026-04-18

## 1. 目的

本機能は、現状のKnowFlow運用と同じく **cron起動** を前提とする。
入力は手動貼り付けではなく、Gnosis内に蓄積された以下の情報から取得する。

- 教訓: `experience_logs`（`record_experience`で蓄積）
- ストーリー: `vibe_memories`（`memory_type='episode'`）

cron実行時に候補キーワードを抽出し、LLMが「検索するべきスコア」を付与する。
**検索スコアが 6.5 を超えた候補のみ** `topic_tasks` へ最低優先度で投入する。

## 2. 前提（現行構成との整合）

- 既存キュー: `topic_tasks`
- 既存ワーカー: `runWorkerLoop` / `runWorkerOnce`
- 既存フロー分岐: `source='cron'` で `runCronFlow` が実行される
- バッチ優先度は最低: `priority=1`
- 最低優先度保証: `priority >= 1` を前提（実装時にZod + DB CHECKで保証）

## 3. スコープ

### 3.1 In Scope

- cronトリガーでの候補抽出バッチ
- 教訓/ストーリーからのキーワード候補生成
- LLMによるスコアリング（簡易）
- `topic_tasks` への自動投入（`source='cron'`, `priority=1`）
- 既存KnowFlowワーカーによる処理
- 重複投入の抑止（既存dedupe活用）

### 3.2 Out of Scope

- 手動入力専用APIの追加
- 既存 `knowledge_*` スキーマの破壊的変更
- キュー/ワーカーのアーキテクチャ変更

## 4. 処理フロー（Cronバッチ）

### Step 1: Cron起動

- 既存の定期実行基盤で **5分ごとのバッチチェック** が走る前提
- 本機能は独立した長周期cronを持たず、既存チェックに相乗りして実行する

### Step 2: 対象データ収集

- 前回実行以降に追加/更新された以下を収集
  - `experience_logs.content`
  - `vibe_memories.content` where `memory_type='episode'`

### Step 3: 候補キーワード抽出

- LLMで候補トピックを抽出
- 一般語やノイズ語は除外

### Step 4: LLMによる簡易評価（必須）

候補ごとに以下のみを出力する。

- `category` (string): 項目カテゴリ
- `why_research` (string): なぜ調べるべきか
- `search_score` (0.0-10.0): 検索するべき度合い
- `term_difficulty_score` (0.0-10.0): フレーズ/固有名詞そのものの難解さ
- `uncertainty_score` (0.0-10.0): 情報の不確実さ

投入ルール:
- **`search_score > 6.5` の場合のみキュー投入**

### Step 5: `topic_tasks` へ投入

- 既存 `enqueue` 経路を利用
- 設定値:
  - `source='cron'`
  - `mode='directed'`
  - `priority=1`
- dedupeは既存 `dedupe_key` 制約で抑止
- `priority` は常に `>= 1`（負数/0 を禁止）
- 実行方針:
  - 上位優先タスク（user起点など）がある場合はそちらを優先
  - 低優先タスクの出番になったタイミングで検索処理を実行
  - 空き時間は継続的に候補探索を行う（5分チェックごと）

### Step 6: ワーカー処理

- 既存 `runCronFlow` で低優先の調査として処理
- 成果は既存 `knowledge_*` に統合

## 5. データ設計方針

### 5.1 評価結果の保存先（新規テーブル）

評価結果の正本として新規テーブルを追加する。

- テーブル名: `knowflow_keyword_evaluations`
- 目的: 投入/非投入を含む評価ログを永続化し、閾値検証と監査を可能にする

主なカラム:
- `run_id`: 1回のバッチ実行単位ID
- `source_type` / `source_id`: 評価元（`episode` / `experience`）
- `topic`, `category`, `why_research`
- `search_score`, `term_difficulty_score`, `uncertainty_score`
- `threshold`, `decision` (`enqueued` / `skipped`)
- `enqueued_task_id`（投入時のみ）
- `model_alias`（`bonsai|gemma4|bedrock|openai`）
- `created_at`

### 5.2 実行カーソル

- `sync_state` を再利用し、最終処理時刻を管理
- 例: `id='knowflow_keyword_cron'`

### 5.3 判定結果の保持

閾値運用を検証できるよう、以下を必ず保持する。

- 正本: `knowflow_keyword_evaluations` に評価結果を保存
- 補助: `topic_tasks.payload` に評価メタデータを格納（投入時のみ）
  - `category`
  - `whyResearch`
  - `searchScore`
  - `termDifficultyScore`
  - `uncertaintyScore`
  - `scoreEvaluatedAt`
- 併せて構造化ログにも同値を出力（投入/非投入理由の監査用）

## 6. LLM設計（候補抽出 + スコアリング）

### 6.1 出力仕様（例）

```json
{
  "items": [
    {
      "topic": "...",
      "category": "provider_scope",
      "why_research": "AWS/Azure/GCPでの実装範囲が不明で、利用可否判断に影響するため",
      "search_score": 7.1,
      "term_difficulty_score": 5.4,
      "uncertainty_score": 6.8
    }
  ]
}
```

### 6.2 フィルタリング

- `search_score > 6.5` のみ投入
- 1バッチあたり最大投入件数を制限（例: 10件）
- 重複はdedupeで抑止

### 6.3 カテゴリ例

- `provider_scope`
- `feature_spec`
- `compatibility_risk`
- `performance`
- `security`
- `license`
- `operations`
- `other`

### 6.4 出力表示例（人間向け）

| 項目 | カテゴリ | なぜ調べるべきか | 用語難解さ | 不確実性 |
| :--- | :--- | :--- | :--- | :--- |
| エフェメラルリソースの対応プロバイダー範囲 | 機能仕様 | 「トークン等」とあるが、AWS/Azure/GCPでの実装範囲が不明。金融・医療ユースケースの可否に影響 | ★★★☆☆ | ★★★★☆ |
| OpenTofuのリリースサイクルとTerraformとの乖離状況 | 互換性リスク | 「最新機能未対応の可能性」の具体差分が不明。将来の互換性劣化リスク評価に必要 | ★★☆☆☆ | ★★★★☆ |
| DAG最適化の実測パフォーマンス差 | 性能 | 「大規模で効率的」の定量根拠が不足し、採用判断に必要な閾値が不明 | ★★★☆☆ | ★★★☆☆ |

注記:
- キュー投入判定は星ではなく `search_score`（0-10）を使う
- 星表示は `term_difficulty_score` / `uncertainty_score` の表示変換として扱う

### 6.5 LLM切替設計（必須）

評価モデルは固定せず、以下4種を **切替可能** にする。

- `gemma4`
- `bonsai`
- `bedrock`
- `openai`

切替方針:
- 実行時設定で評価モデルを選択可能にする
- プロバイダ固有設定（APIキー等）が不足している場合は明示エラー
- 将来の運用変更に備えて、モデル選択はコード内ハードコードしない

初期運用:
- **当面は `gemma4` を既定にして担当させる**

参考比較（要点のみ）:

| 観点 | gemma4/bonsai | bedrock/openai |
| :--- | :--- | :--- |
| コスト | 低〜中（ローカル中心） | 中〜高（API課金） |
| 判定安定性 | 中 | 高 |
| 運用依存 | ローカル資源依存 | ネットワーク/認証依存 |

## 7. 実装計画（段階）

### Phase 0: 仕様固定

- スコアスキーマ確定（3項目のみ）
- 閾値固定（`search_score > 6.5`）
- 最低優先度固定（`priority=1`）
- 制約固定（`priority >= 1` を Zod + DB CHECKで保証）
- LLM alias仕様固定（`bonsai|gemma4|bedrock|openai`）
- 既定 alias を `gemma4` に固定

### Phase 1: バッチ実装

新規追加（例）:
- `src/services/knowflow/cron/keywordSeeder.ts`
  - 教訓/ストーリー収集
  - 候補抽出
  - スコア判定
  - enqueue実行

既存流用:
- `PgJsonbQueueRepository.enqueue`
- `createTask` / `dedupe_key`

### Phase 2: スケジューラ統合

- 既存cron経路に `keywordSeeder` を組み込み
- 実行結果を構造化ログへ出力
- 5分チェックごとに、優先順位的に実行可能なら `keywordSeeder` を走らせる

### Phase 3: テスト

- `test/knowflow/keywordSeeder.test.ts`（新規）
- `test/knowflow/queueRepository.unit.test.ts`（`priority=1` 追加）
- `test/knowflow/llmAdapter.test.ts`（alias切替分岐）
- `gemma4` 検証テスト（必須）
- `openai` 検証テスト（必須）
- 境界値テストを追加
  - `search_score = 6.5` は投入しない
  - `search_score = 6.5001` は投入する

### Phase 4: 文書化

- `docs/knowflow-guide.md` に追記
- `docs/configuration.md` に追記

## 8. 設定値（案）

- `KNOWFLOW_KEYWORD_CRON_ENABLED=true`
- `KNOWFLOW_KEYWORD_CRON_MAX_TOPICS=10`
- `KNOWFLOW_KEYWORD_CRON_MIN_RESEARCH_SCORE=6.5`
- `KNOWFLOW_KEYWORD_CRON_LOOKBACK_HOURS=24`
- `KNOWFLOW_KEYWORD_EVAL_MODEL_ALIAS=gemma4` (`bonsai|gemma4|bedrock|openai`)
- `KNOWFLOW_KEYWORD_EVAL_MODEL_FALLBACK_ALIAS=openai`（任意）

注記:
- 実行周期は独自設定せず、既存の5分チェック周期に従う
- 初期運用は `gemma4` を使用

固定値:
- enqueue時 `priority=1`

## 9. 再評価

### 評価結果

**採用推奨**（切替可能設計 + 初期値 `gemma4` 前提）。

### 理由

1. 現行運用（cron + queue + worker）と整合
2. 教訓/ストーリーを自然に再活用できる
3. 判定ルールがシンプル（`search_score > 6.5`）
4. 低優先バッチで通常タスクを阻害しない
5. 実行モデルを運用で切替可能（`bonsai|gemma4|bedrock|openai`）

### リスクと対策

1. 低品質候補の混入
- 対策: 閾値 + 件数上限 + dedupe

2. モデルごとの判定ぶれ
- 対策: `gemma4/openai` の回帰テストを常設し、差分を監視

3. cron停止時の未実行
- 対策: ヘルスチェックと最終実行時刻監視

## 10. 受け入れ基準（DoD）

- cron実行で候補が抽出される
- 候補ごとに `category` / `why_research` / `search_score` / `term_difficulty_score` / `uncertainty_score` が出る
- `search_score > 6.5` のみキュー投入される
- 評価結果（投入/非投入の双方）が `knowflow_keyword_evaluations` に保存される
- 投入/非投入の判定根拠（3スコア）が `topic_tasks.payload` または構造化ログで追跡できる
- `topic_tasks` に `source='cron'` かつ `priority=1` で投入される
- `priority >= 1` が実装上保証される
- dedupeで重複タスクが抑止される
- 既存ワーカーで処理される

## 11. 次フェーズ

- 閾値 6.5 の妥当性検証
- `mode='expand'` の条件付き解放
