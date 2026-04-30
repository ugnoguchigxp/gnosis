# Failure Firewall 実行計画

> ステータス: 実装計画 Draft  
> 作成日: 2026-04-29  
> 目的: Gnosis の成功体験・手続き・失敗体験を使い、Git diff が「うまくいく型」から外れていないかをレビュー前に検知する

> 実装順と PR 分割は [Failure Firewall Active-Use Implementation Plan](failure-firewall-active-use-plan.md) を正とする。

---

## 1. 結論

Failure Firewall は採用する価値がある。

ただし、最初から汎用コードレビュー機能として作らない。実用上の価値は「この diff は過去にうまくいった型から外れています。さらに過去失敗 X と同じ危険があります」と言えることにあるため、責務を **Golden Path 逸脱検知 + 再発証拠による重大度判定** に限定する。

MVP は新しい primary MCP tool を増やさず、既存の `review_task` / Review Stage C の知識注入基盤に `failure_firewall` モードを追加する。初期データは `procedure`, `skill`, `rule`, `decision`, `success` を主軸に使い、失敗体験は error へ昇格する根拠として扱う。データ保存は既存のローカル DB にある `entities`, `experience_logs`, `vibe_memories`, `review_cases`, `review_outcomes` を優先し、専用テーブルは運用データが増えてから導入する。

重要な設計変更:

- 主判定: 失敗体験との類似ではなく、Golden Path の必須条件からの逸脱
- 補助判定: 過去失敗・レビュー採用済み finding・false positive 履歴による重大度調整
- 初期価値: 失敗ナレッジが少なくても、既存の手続き・スキル・ルールで立ち上がる
- 運用前提: ローカル完結。外部サーバー、GitHub Actions、従量課金 API 常用に依存しない
- LLM 前提: Gemma4 等のローカル LLM を優先し、低速でも破綻しない非同期/段階実行にする

---

## 2. プロダクト定義

### 2.1 コンセプト

過去にうまくいった実装、手続き、スキル、ルールを「Golden Path」として保存し、以後の diff がその必須条件から外れたら警告する。さらに過去に起きた失敗、レビューで止めた問題、ユーザーが明示的に登録した教訓と一致する場合は、再発リスクとしてブロック候補に昇格する。

### 2.2 対象ユーザー

- AI coding agent を日常的に使う開発者
- 同じ種類の実装ミスを減らしたいチーム
- レビュー品質を「一般論」ではなく「自分たちの事故履歴」に寄せたい利用者

### 2.3 提供価値

- 汎用レビューでは見落とす「このプロジェクト固有のうまくいく型」からの逸脱を検知できる。
- 失敗体験が少ない初期状態でも、`procedure` / `skill` / `rule` を使って価値を出せる。
- 個人・チームの成功体験と失敗体験が蓄積するほど検知精度が上がる。
- LLM の指摘を「Golden Path」「逸脱条件」「過去事例」「構造特徴」に紐づけ、納得可能な形で出力できる。

### 2.4 非目標

- 初期版で一般的なコードレビュー全体を置き換えない。
- 初期版で全言語対応の AST 正規化を作らない。
- 初期版で自動修正まで必須にしない。
- 初期版で新しい primary MCP tool を増やさない。
- Golden Path から外れたことだけを理由に、常に block しない。
- GitHub Actions、外部 CI、外部ホストの常駐サーバーを前提にしない。
- OpenAI などの従量課金 API を常時利用する設計にしない。

### 2.5 ローカル完結原則

Failure Firewall は、開発者の手元のリポジトリ、ローカル DB、ローカル LLM ランタイムだけで成立することを必須条件にする。

- 永続化先は既存のローカル DB を基本にする。
- 実行入口は `bun run failure-firewall`、既存 `review_task` に限定する。
- GitHub Actions や外部 CI による品質ゲートは作らない。
- 外部サービスに diff、失敗体験、embedding 入力を送らない。
- LLM 判定は Gemma4 等のローカル LLM を優先する。
- ローカル LLM は遅い前提で扱い、即時応答を要求しない。
- LLM が遅い、未起動、失敗した場合も、ルールベースの結果を先に返せるようにする。
- Failure Firewall 自体は外部向けサーバーを起動しない。必要な場合も既存のローカル実行環境への接続に留める。

---

## 3. 利用フロー

### 3.1 手動実行

```bash
bun run review --stage c --mode worktree --goal "failure_firewall: Golden Path 逸脱と過去失敗の再発だけを検知する"
bun run review --stage c --mode worktree --goal "failure_firewall --knowledge-source dedicated"
```

最終的には専用 CLI alias を追加する。

```bash
bun run failure-firewall --mode worktree
bun run failure-firewall --mode git_diff
```

### 3.2 MCP 経由

既存の `review_task` を使う。

```json
{
  "targetType": "code_diff",
  "reviewMode": "standard",
  "goal": "failure_firewall: Golden Path 逸脱と過去失敗の再発検知に限定する",
  "knowledgePolicy": "required"
}
```

Gnosis primary MCP 公開面は Agent-First の6 tool を維持する。Failure Firewall は新 tool ではなく、`review_task` のモード、または `goal` / `focus` のプリセットとして扱う。



---

## 4. システム構成

```text
git diff
  |
  v
Diff Normalizer
  |
  +--> Risk Signal Extractor
  +--> AST / Symbol Feature Extractor
  +--> Patch Embedding Builder
  |
  v
Hybrid Knowledge Retrieval
  |
  +--> entities(type=procedure/skill/rule/decision, metadata.goldenPath)
  +--> entities(type=risk/lesson, metadata.failureFirewall)
  +--> experience_logs(type=success)
  +--> experience_logs(type=failure)
  +--> vibe_memories(session=code-review-<project>)
  +--> review_cases / review_outcomes
  |
  v
Golden Path Deviation Scoring
  |
  v
Rule + LLM Adjudicator
  |
  v
Failure Firewall Result
```

---

## 5. 既存資産の使い方

### 5.1 使う既存部品

| 既存部品 | 用途 |
|---|---|
| `src/services/review/diff/normalizer.ts` | diff をファイル、hunk、追加行に分解する |
| `src/services/review/static/signals.ts` | auth, migration, transaction などのリスク信号を抽出する |
| `src/services/review/static/diffguard.ts` | diff の変更タイプを補助特徴として使う |
| `src/services/review/static/astmend.ts` | TypeScript の変更シンボルと影響範囲を使う |
| `src/services/review/knowledge/retriever.ts` | guidance と過去類似指摘の検索導線を拡張する |
| `src/services/review/knowledge/persister.ts` | review outcome と finding memory の保存を使う |
| `src/services/experience.ts` | 失敗/成功経験の embedding 検索を使う |
| `src/services/procedure.ts` | 手続き知識を Golden Path 候補として使う |
| `src/db/schema.ts` | 初期版は既存テーブルを利用する |

### 5.2 追加する主なモジュール

```text
src/services/failureFirewall/
  index.ts
  types.ts
  diffFeatures.ts
  patternStore.ts
  retriever.ts
  scorer.ts
  adjudicator.ts
  renderer.ts
  cli.ts
  *.spec.ts
```

Review 直下ではなく `failureFirewall` として分ける。理由は、汎用レビューではなく再発検知に責務を限定するため。

---

## 6. データモデル

### 6.1 MVP: 既存テーブルを使う

初期版では migration を増やさず、以下の形で保存する。

#### `entities`

成功パターンは `type = 'procedure' | 'skill' | 'rule' | 'decision'` として保存し、`metadata.goldenPath` を付ける。Failure Firewall はまずこの Golden Path を検索し、「今回の diff が守るべき条件」を作る。

```json
{
  "category": "review",
  "tags": ["failure-firewall", "golden-path", "cache_invalidation", "tanstack-query"],
  "goldenPath": {
    "pathId": "gp-cache-invalidation-mutation-001",
    "pathType": "mutation_cache_update",
    "appliesWhen": [
      "state-changing mutation is added or changed",
      "UI depends on cached query data"
    ],
    "requiredSteps": [
      "obtain queryClient through the project standard hook",
      "invalidate or update the affected query key on success",
      "cover the cache update behavior with a focused test when risk is high"
    ],
    "allowedAlternatives": [
      "direct cache update with setQueryData",
      "project-standard full data refresh"
    ],
    "blockWhenMissing": ["cache update step"],
    "severityWhenMissing": "warning",
    "successEvidence": [
      "similar past implementation was accepted",
      "procedure is active and project-scoped"
    ],
    "status": "active"
  }
}
```

再発防止ルールは `type = 'risk' | 'lesson' | 'rule'` として保存し、`metadata.failureFirewall` を付ける。これは主判定ではなく、Golden Path 逸脱の重大度を上げる証拠として使う。

```json
{
  "category": "review",
  "tags": ["failure-firewall", "cache_invalidation", "tanstack-query"],
  "failureFirewall": {
    "patternId": "ff-cache-invalidation-mutation-001",
    "patternType": "missing_cache_invalidation",
    "severity": "error",
    "riskSignals": ["cache_invalidation", "external_api_error"],
    "languages": ["TypeScript"],
    "frameworks": ["React"],
    "matchHints": [
      "mutation function changes persistent app state",
      "no query invalidation in success path"
    ],
    "requiredEvidence": [
      "state-changing API call",
      "absence of invalidateQueries or equivalent"
    ],
    "source": "review",
    "status": "active"
  }
}
```

#### `experience_logs`

成功体験は `type = 'success'` として保存する。成功体験は Golden Path の seed と評価データになる。

```json
{
  "sessionId": "failure-firewall-gnosis",
  "scenarioId": "gp-cache-invalidation-mutation-001",
  "type": "success",
  "content": "状態変更 mutation 後に該当 query key を invalidate し、UI 更新漏れを防いだ",
  "metadata": {
    "pathId": "gp-cache-invalidation-mutation-001",
    "files": ["src/modules/..."],
    "riskSignals": ["cache_invalidation"],
    "whySuccessful": "既存の query key 設計と同じ更新経路を使い、レビューで採用された",
    "reusableSteps": [
      "useQueryClient を取得する",
      "onSuccess で対象 query key を invalidate する",
      "関連 hook のテストを追加する"
    ]
  }
}
```

失敗体験は `type = 'failure'` として保存する。失敗体験は block の根拠、または Golden Path の `blockWhenMissing` を補強する証拠になる。

```json
{
  "sessionId": "failure-firewall-gnosis",
  "scenarioId": "ff-cache-invalidation-mutation-001",
  "type": "failure",
  "failureType": "RECURRING_PATTERN",
  "content": "Mutation後に query invalidation がなく UI が更新されなかった",
  "metadata": {
    "patternId": "ff-cache-invalidation-mutation-001",
    "files": ["src/modules/..."],
    "riskSignals": ["cache_invalidation"],
    "fixSummary": "useQueryClient と invalidateQueries を追加"
  }
}
```

#### `vibe_memories`

過去レビューの finding を embedding 検索する。既存の `code-review-${projectKey}` セッションを使う。

### 6.2 専用テーブル

専用テーブルは先に実装し、標準経路は既存 `entities` のままにする。切り替えはローカル環境変数、CLI option、または Review Stage C の `goal` option で行う。

```bash
GNOSIS_FAILURE_FIREWALL_KNOWLEDGE_SOURCE=entities  # default
GNOSIS_FAILURE_FIREWALL_KNOWLEDGE_SOURCE=dedicated
GNOSIS_FAILURE_FIREWALL_KNOWLEDGE_SOURCE=hybrid

bun run failure-firewall --mode worktree --knowledge-source dedicated
bun run review --stage c --mode worktree --goal "failure_firewall --knowledge-source hybrid"
```

```text
failure_firewall_golden_paths
  id text primary key
  title text not null
  path_type text not null
  applies_when jsonb not null
  required_steps jsonb not null
  allowed_alternatives jsonb not null
  block_when_missing jsonb not null
  severity_when_missing text not null
  risk_signals jsonb not null
  languages jsonb not null
  frameworks jsonb not null
  tags jsonb not null
  status text not null
  source_entity_id text
  source_experience_id uuid
  metadata jsonb not null
  created_at timestamptz
  updated_at timestamptz

failure_firewall_patterns
  id text primary key
  title text not null
  pattern_type text not null
  severity text not null
  risk_signals jsonb not null
  languages jsonb not null
  frameworks jsonb not null
  match_hints jsonb not null
  required_evidence jsonb not null
  golden_path_id text
  status text not null
  false_positive_count integer not null
  source_entity_id text
  source_experience_id uuid
  metadata jsonb not null
  created_at timestamptz
  updated_at timestamptz
```

source mode:

- `entities`: 既存の `entities` / `experience_logs` と seed を読む。既定値。
- `dedicated`: 専用テーブルと seed だけを読む。専用テーブル未作成時は seed に degraded fallback する。
- `hybrid`: 専用テーブル、seed、既存 `entities` / `experience_logs` を読む。段階移行時に使う。

重複 ID の優先順位は `dedicated > seed > entities/experience` とする。専用テーブルは移行先の正規化済みデータなので、同じ ID が存在する場合は専用テーブル側を正とする。`hybrid` で片方の DB 読み込みが失敗した場合は、もう片方と seed で継続する。

`failure_firewall_patterns.false_positive_count` は専用テーブル側の集計値を正とし、`review_outcomes` 由来の動的加算は `seed` / `entities` / `experience` 由来の pattern にだけ適用する。これにより、移行後の二重計上を避ける。

専用テーブルを標準経路へ切り替える条件:

- Golden Path / failure pattern が合計 100 件を超える
- false positive / true positive の集計が必要になる
- Golden Path ごとの必須条件や閾値調整が必要になる
- `entities.metadata` だけではクエリが複雑になりすぎる

---

## 7. Diff 特徴抽出

### 7.1 正規化入力

`normalizeDiff(rawDiff)` の結果を基準にする。

抽出対象:

- 変更ファイル
- 変更言語
- hunk 単位の追加/削除行
- change type
- framework hint
- migration / config / infra などの分類

### 7.2 Risk Signals

既存の `extractRiskSignals` を使い、Failure Firewall 用に以下を追加する。

| Signal | 例 |
|---|---|
| `cache_invalidation` | mutation 後の UI 更新漏れ |
| `auth_bypass` | guard, middleware, token 検証の変更 |
| `permission_drift` | permission 関数の条件変更 |
| `transaction_missing` | 複数 DB 更新だが transaction なし |
| `destructive_db_change` | drop, truncate, delete 条件変更 |
| `schema_validation_gap` | Zod schema / request validation の欠落 |
| `async_error_swallowing` | catch で握りつぶす |
| `resource_leak` | process / watcher / timer cleanup 漏れ |
| `test_gap` | 事故パターンに対応するテスト追加なし |

### 7.3 AST / Symbol Features

TypeScript は Astmend の変更シンボルと影響範囲を使う。

初期版で抽出する特徴:

- changed symbols: function, class, type, interface
- added calls / removed calls
- changed imports
- changed exported API
- async function の error handling
- hook 名、mutation 名、query key 名
- transaction / lock / invalidate / validate などの API 呼び出し有無

TypeScript 以外は最初はテキスト特徴と risk signals のみで扱う。

### 7.4 Patch Embedding Text

embedding 用の文字列は raw diff ではなく、ノイズを落とした要約にする。

```text
project=gnosis
language=TypeScript
framework=SvelteKit
files=src/services/review/orchestrator.ts
riskSignals=cache_invalidation,input_validation
changedSymbols=runReviewStageC, retrieveGuidance
addedCalls=retrieveGuidance, searchSimilarFindings
removedCalls=
addedBehavior=state-changing mutation without invalidation
```

raw diff embedding は補助に留める。コメントやフォーマット変更に引っ張られやすいため。

---

## 8. Golden Path 検索と逸脱スコアリング

### 8.1 検索対象

検索は 5 系統を混ぜる。

1. `entities`: `procedure`, `skill`, `rule`, `decision` として保存された Golden Path
2. `experience_logs`: 実際にうまくいった成功体験
3. `entities`: `risk`, `lesson`, `rule` として保存された再発防止ルール
4. `vibe_memories`: 過去レビュー finding
5. `review_outcomes`: false positive / adopted / resolved のフィードバック

### 8.2 検索戦略

```typescript
type FirewallRetrievalQuery = {
  projectKey: string;
  language: string;
  framework?: string;
  riskSignals: string[];
  files: string[];
  changedSymbols: string[];
  normalizedPatchText: string;
};
```

取得候補:

- Golden Path vector similarity 上位 20 件
- risk signal が一致する Golden Path 上位 20 件
- file path / module が近い成功体験 上位 10 件
- 再発防止 pattern 上位 10 件
- false positive が少なく adopted / resolved が多い finding 上位 10 件

取得後に重複を消し、最大 10 件の Golden Path と最大 5 件の失敗証拠に絞る。ローカル LLM が使える場合だけ判定へ渡し、遅い場合はこの ranked list を先に返す。

### 8.3 スコアリング

初期スコアは `deviationScore` と `recurrenceScore` を分ける。

`deviationScore` は「今回の diff が Golden Path からどれだけ外れているか」を表す。

```text
deviationScore =
  0.30 * goldenPathApplicability +
  0.25 * missingRequiredSteps +
  0.20 * riskSignalOverlap +
  0.15 * astFeatureOverlap +
  0.10 * pathOrModuleAffinity -
  allowedAlternativeCredit
```

`recurrenceScore` は「その逸脱が過去失敗とどれだけ結びつくか」を表す。

```text
recurrenceScore =
  0.35 * failureEmbeddingSimilarity +
  0.25 * failureRiskSignalOverlap +
  0.20 * sameMissingStep +
  0.10 * outcomeWeight +
  0.10 * repeatedOccurrenceWeight -
  falsePositivePenalty
```

閾値:

| 条件 | 扱い |
|---|---|
| `deviationScore >= 0.80` かつ `recurrenceScore >= 0.70` | `error` 候補。ローカル LLM が使える場合は反証確認にかけ、使えない場合は `needs_confirmation` に留める |
| `deviationScore >= 0.80` かつ静的証拠が強い | `error` 候補。ただし過去失敗がなければ説明を強める |
| `deviationScore >= 0.65` | `warning` 候補。Golden Path 逸脱として要確認 |
| `recurrenceScore >= 0.65` だが Golden Path 不明 | `warning` 候補。成功手順の不足として登録候補にする |
| `deviationScore >= 0.45` | `info` 候補。近い Golden Path として表示 |
| それ未満 | 非表示 |

`outcomeWeight` は以下で調整する。

- 過去に `adopted` / `resolved`: 加点
- `falsePositive = true`: 大きく減点
- 同じ Golden Path 逸脱の false positive が連続: 閾値を上げる
- 代替実装が `allowedAlternatives` と一致: 減点

---

## 9. Rule + ローカル LLM 判定

### 9.1 ルールで即判定するもの

明確に判定できるものは LLM に渡す前に決める。

例:

- 変更ファイルが docs only なら code Golden Path / failure pattern は原則対象外
- Golden Path / pattern の `languages` と diff language が不一致なら除外
- `requiredEvidence` が 1 つも満たされないなら除外
- `allowedAlternatives` が満たされているなら逸脱扱いしない
- false positive が多い Golden Path / pattern は warning 以下に下げる

### 9.2 LLM に判定させるもの

LLM は Gemma4 等のローカル LLM を優先する。従量課金 API を常時使う設計にはしない。LLM は「似ているか」ではなく、「今回の diff が Golden Path の必須条件から外れているか」「その逸脱が過去失敗と同じ構造か」を判定する。

ローカル LLM は遅い前提で扱う。Failure Firewall は LLM 完了を待たない fast path を持ち、rule/scorer の結果を先に返せるようにする。LLM 判定は後続の補強、または明示的に `--with-llm` を指定した詳細実行として扱う。

CLI の `--with-llm` は、実行前に `LOCAL_LLM_API_BASE_URL/health` を短時間で確認する。preflight に失敗した場合は review を止めずに fast mode へフォールバックし、JSON 出力の `degradedReasons` に `local_llm_preflight_failed:<reason>` を残す。

判定プロンプトの要点:

- 汎用レビューをしない
- 候補 Golden Path ごとに、必須条件・許容代替・今回 diff の証拠を照合する
- Golden Path 逸脱だけでは原則 warning に留める
- 過去事例の症状、原因、修正と今回 diff の逸脱が対応している時だけ recurrence match にする
- 代替実装の可能性がある場合は `needs_confirmation` に落とす
- 失敗体験が不足している場合は「不足している失敗データ」ではなく「成功手順からの逸脱」として表現する
- 速度より根拠の明確さを優先し、タイムアウトを短く切りすぎない

出力:

```json
{
  "matches": [
    {
      "goldenPathId": "gp-cache-invalidation-mutation-001",
      "failurePatternId": "ff-cache-invalidation-mutation-001",
      "decision": "deviation_with_recurrence",
      "severity": "error",
      "confidence": "high",
      "filePath": "src/modules/users/hooks.ts",
      "lineNew": 42,
      "deviationScore": 0.88,
      "recurrenceScore": 0.82,
      "goldenPath": "state-changing mutation 後は該当 query key を invalidate または直接更新する",
      "missingRequiredStep": "成功後の cache update step が見当たらない",
      "sameStructureReason": "過去失敗と同じく state-changing mutation はあるが、成功後の query invalidation がない",
      "pastFailure": "Mutation後に UI が古い状態のまま残った",
      "evidence": [
        "useMutation が追加された",
        "queryClient.invalidateQueries が追加されていない"
      ],
      "suggestedAction": "onSuccess で該当 query key を invalidate する"
    }
  ]
}
```

---

## 10. 出力仕様

Failure Firewall の出力は「レビュー結果」ではなく「Golden Path 逸脱・再発検知レポート」として表現する。

### 10.1 Markdown

```markdown
# Failure Firewall

## Status

changes_requested

## Recurrence Matches

### [error] gp-cache-invalidation-mutation-001

この変更は「mutation 後は cache を更新する」という Golden Path から外れています。
さらに、過去にやった「mutation 後の cache invalidation 漏れ」と同じ構造です。

- Deviation: 0.88
- Recurrence: 0.82
- Confidence: high
- File: src/modules/users/hooks.ts:42
- Golden Path: state-changing mutation 後は該当 query key を invalidate または直接更新する
- Missing step: 成功後の cache update step が見当たらない
- Past failure: Mutation後に UI が古い状態のまま残った
- Same structure: state-changing mutation はあるが、成功後の query invalidation がない
- Required action: onSuccess で該当 query key を invalidate する
```

### 10.2 JSON

```typescript
type FailureFirewallOutput = {
  status: 'changes_requested' | 'needs_confirmation' | 'no_recurrence_detected';
  matches: FailureMatch[];
  goldenPathsEvaluated: number;
  candidatesEvaluated: number;
  degradedReasons: string[];
  metadata: {
    reviewedFiles: number;
    riskSignals: string[];
    knowledgeSources: string[];
    durationMs: number;
  };
};
```

---

## 11. 成功・失敗体験の登録フロー

### 11.1 基本方針

登録頻度を上げるには、ユーザーに毎回文章を書かせないことが重要である。Failure Firewall は「手動で反省を書く仕組み」ではなく、既存の作業節目から成功体験・失敗体験の候補を自動生成し、低摩擦で昇格できる形にする。

保存対象の優先順位:

1. 成功体験: 採用された実装、再利用可能な手順、レビューを通った修正方針
2. 手続き・スキル: 繰り返し使える作業順序、チェックポイント、判断基準
3. 失敗体験: 実害、手戻り、レビュー採用済みの重大指摘、再発可能な原因
4. 未確定候補: まだ一般化できないが、後で見返す価値がある観察

### 11.2 登録頻度を上げる仕組み

#### タスク開始時

`start_task` の `title`, `files`, `intent` から「今回使う可能性のある Golden Path」を検索し、task trace に紐づける。

保存はしない。ここでは候補だけを持つ。

#### 実装中の知識候補化

`record_task_note` または `finish_task` の学習項目として、以下を候補化する。

- 変更ファイルと risk signals
- 使った procedure / skill / rule
- 実装が従った手順
- 実装中に迷った判断
- テスト・型チェック・レビューで確認した項目

ここで保存するのは `draft` または `needs_review` の候補のみ。active knowledge にはしない。

#### レビュー完了時

`review_task` の結果から自動候補を作る。

- finding なし、または軽微な指摘のみで通った diff: success candidate
- 指摘があり、修正後に通った diff: success + failure pair candidate
- 採用された重大 finding: failure candidate
- dismissed / false positive: negative feedback

#### タスク完了時

`finish_task` で以下を自動抽出する。

- 実際に通った検証コマンド
- 最終的に採用された設計判断
- 途中で詰まった原因
- 次回も使うべき手順
- 次回避けるべき手順

agent は `learnedItems` を毎回 0-3 件だけ提案する。多すぎる候補は品質が落ちるため、1 タスクあたり active 昇格は原則 1 件までにする。

### 11.3 成功体験として保存する基準

成功体験は「たまたま動いた」ではなく、「次回も使う価値がある再現可能な型」として保存する。

保存してよい条件:

- レビュー、テスト、型チェック、ユーザー確認のいずれかを通過している
- どの状況で適用するかが説明できる
- 具体的な手順または必須条件に分解できる
- 他の選択肢より良かった理由がある
- 似た変更で再利用できる見込みがある

保存しない条件:

- 一度だけの作業メモ
- 単なる実装結果の要約
- 成功理由が「なんとなく」「エラーが出なかった」だけ
- プロジェクト固有すぎて再利用できない
- 既存 procedure / skill と同じ内容で差分がない

成功体験の種類:

| 種類 | 保存先 | 例 |
|---|---|---|
| Golden Path | `entities(type=procedure/skill/rule)` | mutation 後は query key を invalidate する |
| Success benchmark | `experience_logs(type=success)` | 実際に採用された修正 diff の要約 |
| Design decision | `entities(type=decision)` | 専用テーブル導入を Phase 2 に遅らせる |
| Command recipe | `entities(type=command_recipe)` | 実装後に通す verify コマンド |

成功体験の推奨形式:

```json
{
  "kind": "procedure",
  "category": "review",
  "title": "Mutation後の cache update Golden Path",
  "content": "状態を変更する mutation を追加したら、成功後に該当 query key を invalidate する。代替として setQueryData による直接更新も認める。",
  "tags": ["failure-firewall", "golden-path", "cache_invalidation", "tanstack-query"],
  "purpose": "UI更新漏れを防ぐため、state-changing mutation の成功後処理を検査する",
  "evidence": [
    {
      "type": "review",
      "uri": "review-case-id",
      "value": "レビュー済みの成功実装"
    }
  ]
}
```

### 11.4 失敗体験として保存する基準

失敗体験は「気に入らない実装」ではなく、「再発するとコストが発生する原因」として保存する。

失敗として保存する条件:

- 実害があった: バグ、データ不整合、セキュリティ問題、性能劣化、運用事故
- 手戻りが発生した: レビューで修正要求、テスト失敗、型エラー、仕様不一致
- ユーザーまたは reviewer が明示的に問題として採用した
- 同じ原因が別の場所で再発しうる
- 原因と修正方針を 1-3 文で説明できる

失敗として保存しない条件:

- 単なる好みの違い
- すぐ直した typo / format / import 整理
- 一度きりの環境問題
- 原因不明で再利用可能な教訓がない
- false positive と判断された review finding

失敗の重大度:

| Severity | 基準 | 扱い |
|---|---|---|
| `error` | 本番事故、データ破壊、認証認可、重大な手戻り | Golden Path 逸脱と一致したら block 候補 |
| `warning` | レビューで修正要求、テスト漏れ、保守性低下 | 逸脱時に warning 強化 |
| `info` | 軽微な手戻り、再利用可能な注意点 | 類似事例として提示 |

失敗体験の推奨形式:

```json
{
  "kind": "risk",
  "category": "review",
  "title": "Mutation後の query invalidation 漏れ",
  "content": "状態を変更する mutation を追加したら、成功後に該当 query key を invalidate する。過去に UI が古いまま残る事故が起きた。",
  "tags": ["failure-firewall", "cache_invalidation", "tanstack-query"],
  "evidence": [
    {
      "type": "file",
      "uri": "src/modules/users/hooks.ts",
      "value": "過去修正箇所"
    }
  ]
}
```

保存時または後段 enrichment で `metadata.failureFirewall` を補完する。

### 11.5 レビュー結果からの昇格

`review_task` の finding が採用されたら、以下の条件で pattern candidate を作る。

- severity が `error` または `warning`
- outcome が `adopted` または `resolved`
- false positive ではない
- rationale に再利用可能な原因が含まれる

candidate はすぐ active にせず、`status = needs_review` で保存する。ユーザーが採用したものだけ active にする。

### 11.6 成功・失敗ペアの保存

最も価値が高いのは、失敗単体ではなく「失敗 -> 修正後の成功」のペアである。

保存する情報:

- failure: 何が壊れたか
- cause: なぜ壊れたか
- fix: どう直したか
- goldenPath: 次回最初から従うべき手順
- evidence: レビュー、テスト、diff、ユーザー確認

このペアがあると、Failure Firewall は単に「危険」と言うだけでなく、「この成功手順に寄せればよい」と提示できる。

### 11.7 失敗完了からの昇格

`finish_task` で失敗または手戻りが記録された場合、`learnedItems` から pattern candidate を作る。

ただし、保存する前に以下のゲートを通す。

1. 再発可能か
2. 原因が説明できるか
3. 次回検知できる diff 上の特徴があるか
4. 対応する Golden Path に変換できるか
5. false positive 化しやすい曖昧な表現ではないか

### 11.8 Active 昇格ルール

自動生成された候補は最初 `needs_review` とする。`active` に昇格する条件は以下。

- success candidate: 2 回以上使われた、またはユーザーが明示採用した
- failure candidate: 採用済み finding、またはユーザーが失敗として明示した
- procedure / skill: 適用条件、必須手順、代替手段が書かれている
- false positive 履歴が少ない

`active` 昇格後も、false positive が 2 回続いたら `needs_review` に戻す。

---

## 12. 実装フェーズ

### Phase 0: 設計固定

成果物:

- この実行計画
- Golden Path / Failure pattern の最小 JSON schema
- MVP の CLI / MCP 入力仕様

完了条件:

- 新 primary MCP tool を増やさない方針が確認済み
- MVP で使う既存テーブルが確定済み
- 成功体験を主軸、失敗体験を重大度補強として扱う方針が確定済み
- false positive を記録する導線が確定済み

### Phase 1: MVP 検知パイプライン

実装:

- `src/services/failureFirewall/types.ts`
- `src/services/failureFirewall/diffFeatures.ts`
- `src/services/failureFirewall/retriever.ts`
- `src/services/failureFirewall/scorer.ts`
- `src/services/failureFirewall/index.ts`
- `src/services/failureFirewall/renderer.ts`

内容:

- raw diff を受け取る
- normalized diff / risk signals / patch embedding text を作る
- `entities`, `experience_logs`, `vibe_memories` から Golden Path と failure evidence を候補検索する
- ルールスコアで Golden Path deviation と recurrence evidence を ranked list にする
- LLM なしでも warning/info を返せるようにする

完了条件:

- fixture diff に対して既知 Golden Path 逸脱が返る
- docs only diff では code pattern が出ない
- false positive metadata がある pattern は順位が下がる

### Phase 2: ローカル LLM Adjudicator

実装:

- `src/services/failureFirewall/adjudicator.ts`
- ローカル LLM adapter との接続
- JSON schema validation
- slow response / degraded mode

内容:

- 上位 candidate だけローカル LLM に渡す
- Golden Path 逸脱か、許容代替か、過去失敗と同じ構造かを判定する
- deviation / deviation_with_recurrence / allowed_alternative / no_match を返す
- Gemma4 等を第一候補にし、外部の従量課金 API は標準経路にしない
- LLM 判定を待たずに、ルールベース結果だけで完了できる実行モードを維持する

完了条件:

- LLM なしの場合もルールベース結果を返す
- ローカル LLM ありの場合は evidence と反証を出せる
- JSON parse failure 時に degraded mode で落ちる
- ローカル LLM が遅い場合も、実行全体を失敗扱いにしない

### Phase 3: Review 統合

実装:

- `review_task` の `goal` または option で `failure_firewall` を有効化
- `runReviewStageC` の前段または後段に Failure Firewall を差し込む
- renderer に Failure Firewall セクションを追加
- CLI alias `bun run failure-firewall` を追加

内容:

- 汎用レビューとは別ステータスで再発検知を表示する
- severity error の deviation_with_recurrence がある場合は `changes_requested`
- 汎用 finding と Failure Firewall match を混ぜすぎない

完了条件:

- CLI で worktree diff を検知できる
- MCP `review_task` 経由で同じ結果を取得できる
- 既存 `review` コマンドの挙動を壊さない

### Phase 4: Golden Path / Pattern 登録・昇格

実装:

- review outcome から pattern candidate を作る
- `record_task_note` / `finish_task` の learned item から metadata を補完する
- Golden Path / pattern の active / needs_review / deprecated を扱う

内容:

- 採用された成功実装を Golden Path candidate にできる
- 採用された指摘だけ failure pattern にできる
- false positive は Golden Path / pattern score に反映する
- Golden Path の説明に「適用条件」「必須手順」「許容代替」「検証方法」を必須化する
- failure pattern の説明に「症状」「原因」「再発条件」「修正方針」を必須化する

完了条件:

- 手動登録した Golden Path / pattern が次回 diff で検索される
- 成功体験から作った Golden Path が warning を出せる
- false positive 登録後に同じ pattern のスコアが下がる
- active でない Golden Path / pattern はブロックしない

### Phase 5: 登録頻度向上

実装:

- `finish_task` で success candidate / failure candidate を 0-3 件提案する
- `review_task` 結果から success / failure / false positive feedback を自動候補化する
- `record_task_note` の入力に `goldenPath` 補完を追加する
- candidate の `needs_review` キューを monitor UI または CLI で確認できるようにする

内容:

- ユーザーが毎回手書きしなくても候補が増える
- 成功体験を優先的に蓄積する
- 失敗体験は基準を満たすものだけ保存する
- active 昇格は低摩擦だが無制限にしない

完了条件:

- 1 タスク完了時に成功候補が自動生成される
- review 採用済み finding から failure candidate が生成される
- false positive は次回スコアに反映される
- candidate が多すぎる場合に上位 3 件へ抑制される

### Phase 6: ローカル Hook / CLI 運用

実装:

- `review_task` から Failure Firewall をローカル実行
- CLI 用 JSON 出力
- local threshold 設定
- `--fast` と `--with-llm` の実行モード分離

内容:

- ローカル開発では warning 中心
- `--fast` は LLM を待たず、risk signal と Golden Path scoring だけで返す
- `--with-llm` は遅くてもよい詳細確認として、ローカル LLM の結果を待つ
- ローカル LLM が遅い、未起動、失敗した場合は degraded warning にする
- GitHub Actions や外部 CI の fail 条件は作らない

完了条件:

- review 前チェックとしてローカルで動く
- CLI で JSON を読み取りローカルの exit code を制御できる
- ローカル LLM / DB unavailable で開発を過剰に止めない
- 外部サーバー、GitHub Actions、従量課金 API なしで完結する

---

## 13. テスト計画

### 13.1 Unit Test

- `diffFeatures`: risk signal / changed symbol / patch summary の抽出
- `scorer`: Golden Path applicability、missing required steps、recurrence evidence、false positive penalty
- `retriever`: DB 依存を mock した候補取得
- `adjudicator`: LLM JSON parse / degraded mode
- `renderer`: Markdown / JSON 出力

### 13.2 Fixture Test

`test/fixtures/failure-firewall/` を作る。

| Fixture | 期待結果 |
|---|---|
| `cache-invalidation-missing.diff` | Golden Path 逸脱が warning、過去失敗証拠ありなら error |
| `cache-invalidation-present.diff` | no recurrence |
| `docs-only.diff` | no recurrence |
| `auth-guard-weakened.diff` | auth pattern が warning/error |
| `allowed-alternative-set-query-data.diff` | allowed alternative として no recurrence |
| `false-positive-known.diff` | warning 以下に降格 |

### 13.3 Integration Test

- `bun test src/services/failureFirewall/*.spec.ts`
- `bun run review --stage c --mode worktree --goal "failure_firewall --knowledge-source dedicated"`
- DB なしの場合の degraded mode
- embedding service 失敗時の fallback

### 13.4 品質ゲート

コード変更を含む実装時は以下を通す。

```bash
bun run verify:fast
```

レビューや DB 変更を含む場合は以下を通す。

```bash
bun run verify
```

---

## 14. 評価指標

### 14.1 MVP 成功条件

- 登録済み Golden Path 5 件に対して、対応 fixture の逸脱検知率 80% 以上
- docs only / formatting only の false positive 率 10% 未満
- `--fast` は通常 diff で開発を妨げない範囲に収める
- `--with-llm` はローカル LLM の preflight を行い、未起動時は degraded reason 付きで fast fallback する
- LLM なしでも候補提示ができる
- 失敗体験が 0 件でも、Golden Path 逸脱 warning を出せる
- 外部サーバー、GitHub Actions、従量課金 API なしで実行できる

### 14.2 継続運用 KPI

| KPI | 目標 |
|---|---:|
| Golden Path 逸脱検知の precision | 70% 以上 |
| success candidate の active 昇格率 | 30% 以上 |
| adopted match rate | 60% 以上 |
| false positive rate | 20% 未満 |
| active Golden Path 数 | 継続増加 |
| active failure pattern 数 | 必要十分に増加 |
| 同一 failureType の再発件数 | 減少傾向 |

---

## 15. リスクと対策

### 15.1 False Positive が多い

対策:

- docs only / language mismatch / requiredEvidence 不足をルールで除外する
- false positive feedback を score に反映する
- `allowedAlternatives` を Golden Path に必ず持たせる
- 初期値は block より warning を多くする

### 15.2 汎用レビューに戻ってしまう

対策:

- prompt に「汎用レビュー禁止、Golden Path 逸脱と再発検知のみ」と明記する
- output type を `FailureMatch` に限定する
- `Finding` と混ぜず renderer で別セクションにする

### 15.3 過去失敗データが少ない

対策:

- 最初は Golden Path seed を 5-10 件入れる
- 失敗体験は severity 昇格の補助に留める
- review outcome から candidate を作る
- `finish_task` の learnedItems から pattern を作る

### 15.4 類似度だけで誤判定する

対策:

- embedding similarity 単独では block しない
- Golden Path の appliesWhen / requiredSteps / allowedAlternatives を必須にする
- risk signal と requiredEvidence を補助条件にする
- LLM adjudicator に反証も出させる

### 15.5 DB schema が早期に複雑化する

対策:

- 既定値は `entities.metadata.failureFirewall` のままにする
- 専用テーブルは実装済みの `GNOSIS_FAILURE_FIREWALL_KNOWLEDGE_SOURCE` で段階切り替えする

### 15.6 成功体験が一般化されすぎる

対策:

- 成功体験をそのまま active Golden Path にしない
- 適用条件と許容代替が書けないものは `needs_review` に留める
- 2 回以上使われた、またはユーザーが明示採用したものを優先する
- 既存 procedure / skill との差分がない候補は統合する

---

## 16. 初期 Golden Path / Seed Pattern 案

Gnosis の既存ルールと相性が良い Golden Path から始める。失敗 pattern は対応する Golden Path の逸脱に紐づける。

### 16.1 Mutation 後の cache update

- Golden Path type: `mutation_cache_update`
- Failure pattern type: `missing_cache_invalidation`
- Signals: `cache_invalidation`, `external_api_error`
- Required steps:
  - state-changing mutation を追加/変更したら影響する query key を特定する
  - 成功後に `invalidateQueries` または `setQueryData` を使う
  - 高リスク変更では hook / repository のテストを追加する
- Allowed alternatives:
  - プロジェクト標準の full refresh
  - 明示的な optimistic update + rollback
- Required evidence:
  - state-changing mutation が追加/変更されている
  - `invalidateQueries` または同等処理がない
- Severity: `error`

### 16.2 認証・認可チェックの弱体化

- Golden Path type: `auth_permission_guard_preserved`
- Failure pattern type: `auth_guard_weakened`
- Signals: `auth`, `permission`
- Required steps:
  - guard / middleware / permission 変更時は保護対象を明記する
  - 条件緩和には対応するテストまたは仕様根拠を付ける
  - 認証バイパスを実装しない
- Required evidence:
  - guard / middleware / permission 条件が変更されている
  - テストまたは代替検証がない
- Severity: `error`

### 16.3 DB 破壊操作の条件漏れ

- Golden Path type: `destructive_db_operation_scoped`
- Failure pattern type: `destructive_db_without_scope`
- Signals: `deletion`, `destructive_db_change`
- Required steps:
  - delete / truncate / drop 相当の操作は scope 条件を明示する
  - tenant / user / project 境界を守る
  - migration / rollback 方針を確認する
- Required evidence:
  - delete / truncate / drop 相当の操作
  - tenant / user / project scope 条件が弱い
- Severity: `error`

### 16.4 複数更新の transaction 漏れ

- Golden Path type: `multi_write_transaction_boundary`
- Failure pattern type: `missing_transaction`
- Signals: `transaction`, `db_schema_change`
- Required steps:
  - 複数の永続化更新を同一ユースケースで行う場合は transaction 境界を検討する
  - 途中失敗時の rollback または補償処理を明示する
- Required evidence:
  - 複数の永続化更新
  - rollback 可能な transaction 境界がない
- Severity: `warning`

### 16.5 validation schema と実装の不一致

- Golden Path type: `schema_validation_kept_in_sync`
- Failure pattern type: `schema_validation_gap`
- Signals: `input_validation`
- Required steps:
  - API 入力変更時は Zod schema を同時に更新する
  - エラー形式とテストを追従する
- Required evidence:
  - API 入力または schema が変更されている
  - Zod validation / error mapping / test が追従していない
- Severity: `warning`

---

## 17. 実装順序チェックリスト

1. `GoldenPath`, `FailurePattern`, `FailureMatch`, `FailureFirewallOutput` の型を作る。
2. diff から `FailureDiffFeatures` を作る。
3. 既存 DB から Golden Path candidate と failure evidence を取得する。
4. `deviationScore` と `recurrenceScore` で上位 candidate に絞る。
5. LLM なしの Markdown / JSON 出力を作る。
6. Fixture test を作る。
7. ローカル LLM adjudicator を追加する。
8. `review_task` / CLI に統合する。
9. review outcome から success / failure candidate を作る。
10. `finish_task` から learnedItems を Golden Path 候補化する。
11. CLI に接続する。

---

## 18. 最小実装の受け入れ条件

最初の実用版は以下を満たせばよい。

- `bun run failure-firewall --mode worktree` で現在の diff を検査できる。
- 手動登録した Golden Path / failure pattern が既存 `entities` または専用テーブル経由で検索対象になる。
- Golden Path 逸脱がある場合、「どの成功手順から外れているか」を説明できる。
- 過去失敗と一致する場合、「過去の何と同じ構造か」を説明できる。
- deviation score、recurrence score、根拠、過去失敗、推奨対応が出る。
- docs only 変更では code pattern を出さない。
- ローカル LLM や embedding が失敗しても degraded mode として結果を返す。
- false positive を記録すると次回以降の score が下がる。
- 失敗体験が未登録でも Golden Path 逸脱 warning は出せる。
- GitHub Actions、外部 CI、外部ホストのサーバー、従量課金 API に依存しない。

---

## 19. 設計判断

### 19.1 新 primary MCP tool は増やさない

Agent-First の公開面は現在 primary 6 tool に整理されている。Failure Firewall を primary tool にすると、エージェントが `review_task` と使い分ける必要が出る。初期版では `review_task` のモードとして扱う。

### 19.2 Golden Path / Pattern の source of truth は切り替え可能

Gnosis の方針は structured knowledge を `entities` に寄せること。Failure Firewall も既定ではこれに合わせる。Golden Path は `procedure` / `skill` / `rule` / `decision`、failure pattern は `risk` / `lesson` / `rule` として扱う。

一方で、集計・閾値・性能の必要が出た時点で移行できるよう、専用テーブルは先に実装しておく。標準経路は `entities`、検証経路は `dedicated`、移行経路は `hybrid` とする。

### 19.3 成功体験を主軸にする

失敗体験は初期データが少なく、cold start が弱い。一方で procedure / skill / rule は成功体験に近く、すぐに使える。したがって、MVP は Golden Path 逸脱検知を主軸にし、失敗体験は severity と説明力を上げる証拠として使う。

### 19.4 ローカル LLM は最終判定に限定する

LLM に全 diff を自由レビューさせると汎用レビューになる。Failure Firewall では、候補検索とスコアリングをルールで行い、ローカル LLM は「Golden Path 逸脱か」「許容代替か」「過去失敗と同じ構造か」の判定だけに使う。Gemma4 等のローカル LLM を優先し、従量課金 API を常時使わない。ローカル LLM は遅い前提なので、fast path は LLM を待たずに完了できるようにする。

### 19.5 再発検知は block より説明責任を重視する

初期運用では誤ブロックが最大リスク。したがって、Golden Path 逸脱だけなら原則 warning にし、high confidence の再発証拠がある場合だけ error にする。必ず Golden Path、欠けている手順、許容代替の有無、過去失敗との対応関係を出す。

### 19.6 登録頻度は自動候補化で上げる

ユーザーに毎回手動登録を求めると続かない。`review_task` と `finish_task` から success / failure candidate を自動生成し、active 昇格だけを人間または高信頼ルールに委ねる。

### 19.7 外部インフラに依存しない

Failure Firewall は常にローカルで動く開発支援として設計する。GitHub Actions、外部 CI、外部ホストの常駐サーバー、従量課金 API の利用は標準経路に含めない。必要な出力は CLI / MCP で完結させる。
