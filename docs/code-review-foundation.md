# Gnosis Code Review Agent — 共通基盤

**Version**: 1.1  
**役割**: 全 Stage で共通参照するスキーマ・型定義・制約・技術スタック

---

## 目次

1. [スコープと基本思想](#1-スコープと基本思想)
2. [Stage マップ](#2-stageマップ)
3. [共通型定義](#3-共通型定義)
4. [エラー定義と制約定数](#4-エラー定義と制約定数)
5. [既存リソース活用マッピング](#5-既存リソース活用マッピング)
6. [LLM サービスインターフェース](#6-llm-サービスインターフェース)
7. [技術スタック](#7-技術スタック)
8. [ディレクトリ構成](#8-ディレクトリ構成)

---

## 1. スコープと基本思想

### 対象

- 単一ローカル環境で動くレビューオーケストレータ
- Git リポジトリに対する差分レビュー
- IDE エージェントの task completed / checkpoint イベントからの起動
- ローカル LLM と上位 LLM の使い分け
- Gnosis へのローカル知識蓄積
- MCP 向け助言生成

### 対象外

- チーム共有ナレッジ / リモート同期 / Web UI
- 常駐バックエンドサーバー / 自動マージ判定 / 完全自動修正適用

### 基本思想

#### CLI ファースト

システムは常駐サーバーではなく CLI 群として実装する。hook や MCP は CLI を呼ぶ入口。

#### 差分中心

レビュー対象は Git diff を中心に構築する。必要時のみ周辺ファイル・依存ファイルを追加取得する。

#### ローカル LLM は補助、上位 LLM が主判定

ローカル軽量 LLM は要約・論点抽出・影響範囲推定に限定する。**問題なし判定や最終結論は出させない**。

#### 知識の優先順位

1. **Principle**: 変わりにくい原則
2. **Heuristic**: 相対正答率を上げる経験則
3. **Pattern**: 再発しやすい問題の型
4. **Skill**: 条件一致時のみ有効な具体手順（最後に使う）

---

## 2. Stage マップ

各 Stage は独立してデプロイ可能な垂直スライスとして設計する。

```
Stage A: 単発レビュアー
  ├─ 安全境界 (root validation, secret masking)
  ├─ Git diff 取得
  └─ LLM → Markdown 出力
        ↓ 完成したら使い始め、実データを蓄積する

Stage B: 情報付きレビュアー
  ├─ DiffGuard MCP（決定論チェック + diff 構造化）
  ├─ Astmend MCP（参照解析 + 影響範囲検出）
  ├─ 静的解析統合（ESLint / tsc 等）
  └─ Review Planner (リスクスコアリング + LLM 使い分け)

Stage C: 記憶するレビュアー
  ├─ vibe_memories への finding 保存
  ├─ experience_logs への実行ログ保存
  ├─ Guidance Registry から Principle/Heuristic/Pattern 注入
  └─ review_cases / review_outcomes テーブル追加

Stage D: 進化するレビュアー
  ├─ Guidance 自動昇格メカニズム
  ├─ Astmend MCP による安全な修正候補生成
  ├─ KPI 計測ダッシュボード
  └─ フィードバックループ完成
```

| Stage | 依存 | 新規テーブル | 主な外部依存 |
|-------|------|-------------|-------------|
| A | なし | なし | LLM Service |
| B | A | なし | DiffGuard MCP, Astmend MCP |
| C | A+B | `review_cases`, `review_outcomes` | Guidance Registry |
| D | A+B+C | なし（集計クエリのみ） | Astmend MCP（修正候補） |

---

## 3. 共通型定義

すべての Stage で共有する型。`src/services/review/types.ts` に配置する。

### ReviewRequest

```typescript
interface ReviewRequest {
  taskId: string;
  repoPath: string;
  baseRef: string;
  headRef: string;
  taskGoal?: string;
  changedFiles?: string[];
  trigger: 'task_completed' | 'checkpoint' | 'manual';
  sessionId: string;
  mode: 'git_diff' | 'worktree';
  enableStaticAnalysis?: boolean;       // Stage B 以降
  enableKnowledgeRetrieval?: boolean;   // Stage C 以降
}
```

### Finding

```typescript
interface Finding {
  id: string;                    // uuid
  title: string;
  severity: 'error' | 'warning' | 'info';
  confidence: 'high' | 'medium' | 'low';
  file_path: string;             // リポジトリルートからの相対パス
  line_new: number;              // 新ファイルの行番号（必須）
  end_line?: number;
  category: FindingCategory;
  rationale: string;             // 指摘理由（証拠ベース）
  suggested_fix?: string;        // 修正案（副作用の説明を含む）
  evidence: string;              // diff 本文からの引用
  knowledge_refs?: string[];     // 参照した Guidance ID (Stage C〜)
  fingerprint: string;           // sha256(file_path + category + evidence_snippet).slice(0,16)
  needsHumanConfirmation: boolean;
  source: FindingSource;
}

type FindingCategory =
  | 'bug'
  | 'security'
  | 'performance'
  | 'design'
  | 'maintainability'
  | 'test'
  | 'validation';

type FindingSource =
  | 'local_llm'
  | 'heavy_llm'
  | 'static_analysis'
  | 'rule_engine';
```

### ReviewOutput

```typescript
interface ReviewOutput {
  review_id: string;
  task_id?: string;
  review_status: ReviewStatus;
  findings: Finding[];
  summary: string;
  next_actions: string[];
  rerun_review: boolean;
  metadata: ReviewMetadata;
  markdown: string;
}

type ReviewStatus =
  | 'changes_requested'
  | 'needs_confirmation'
  | 'no_major_findings';  // 「問題なし」ではない

interface ReviewMetadata {
  reviewed_files: number;
  risk_level: 'low' | 'medium' | 'high';
  static_analysis_used: boolean;
  knowledge_applied: string[];
  degraded_mode: boolean;
  degraded_reasons: DegradedMode[];
  local_llm_used: boolean;
  heavy_llm_used: boolean;
  review_duration_ms: number;
}

enum DegradedMode {
  STATIC_ANALYSIS_UNAVAILABLE = 'static_analysis_unavailable',
  KNOWLEDGE_RETRIEVAL_FAILED = 'knowledge_retrieval_failed',
  DIFF_SIZE_LIMITED = 'diff_size_limited',
  LLM_TIMEOUT = 'llm_timeout',
}
```

### NormalizedDiff（Stage B 以降）

```typescript
interface NormalizedDiff {
  filePath: string;
  changeType: 'added' | 'modified' | 'deleted' | 'renamed';
  oldLineMap: Map<number, string>;
  newLineMap: Map<number, string>;
  hunks: Hunk[];
  language: string;
  fileSize: number;
  isBinary: boolean;
  classification: FileClassification;
}

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

interface DiffLine {
  type: 'context' | 'added' | 'removed';
  oldLineNo?: number;
  newLineNo?: number;
  content: string;
}

interface FileClassification {
  language: string;
  isConfig: boolean;
  isMigration: boolean;
  isTest: boolean;
  isInfra: boolean;
  framework?: string;
}
```

### Astmend MCP レスポンス型（Stage B 以降）

Astmend MCP の応答を Gnosis 内部で保持するための型。

```typescript
interface AstmendImpactSummary {
  /** 変更されたシンボルごとの参照・影響情報 */
  symbols: AstmendSymbolImpact[];
  /** Astmend MCP が利用不可だった場合 true */
  degraded: boolean;
}

interface AstmendSymbolImpact {
  name: string;
  kind: 'function' | 'interface' | 'class' | 'type_alias' | 'enum' | 'variable';
  file: string;
  /** analyze_references の結果: 参照箇所 */
  references: { file: string; line: number; isDefinition: boolean }[];
  /** detect_impact の結果: 影響を受ける宣言 */
  impactedDeclarations: { name: string; kind: string; file: string }[];
}
```

### ReviewContext（段階的拡張）

```typescript
// Stage A
interface ReviewContextV1 {
  instruction: string;
  projectInfo: { language: string; framework?: string };
  rawDiff: string;
  outputSchema: object;
}

// Stage B: 静的解析 + 構造解析追加
interface ReviewContextV2 extends ReviewContextV1 {
  diffSummary: {
    filesChanged: number;
    linesAdded: number;
    linesRemoved: number;
    riskSignals: string[];
  };
  selectedHunks: NormalizedDiff[];
  staticAnalysisFindings: StaticAnalysisFinding[];
  impactAnalysis?: AstmendImpactSummary;  // Astmend MCP が利用可能な場合
}

// Stage C: 知識注入追加
interface ReviewContextV3 extends ReviewContextV2 {
  recalledPrinciples: GuidanceItem[];
  recalledHeuristics: GuidanceItem[];
  recalledPatterns: GuidanceItem[];
  optionalSkills: GuidanceItem[];
  pastSimilarFindings: string[];
}
```

### GuidanceItem（Stage C 以降）

Guidance Registry の `vibe_memories` に `metadata.kind='guidance'` として保存される。
`applicability` は content 文字列ではなく **metadata 内の構造化フィールド** として保持する。

```typescript
interface GuidanceItem {
  id: string;
  title: string;
  content: string;
  guidanceType: 'rule' | 'skill';
  scope: 'always' | 'on_demand';
  priority: number;
  tags: string[];
  applicability?: {
    signals?: string[];       // マッチするリスクシグナル名
    fileTypes?: string[];     // 'config' | 'migration' | 'test' 等
    languages?: string[];
    frameworks?: string[];
    excludedFrameworks?: string[];
  };
}
```

> **実装注意**: `saveGuidance()` の `metadata` に `applicability` を JSON として格納する。
> content 内に `applicability: {...}` を文字列で埋め込む方式は採用しない。

---

## 4. エラー定義と制約定数

`src/services/review/errors.ts` に配置する。

```typescript
export class ReviewError extends Error {
  constructor(
    public readonly code: keyof typeof ReviewErrors,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'ReviewError';
  }
}

export const ReviewErrors = {
  E001: 'ROOT_VALIDATION_FAILED',
  E002: 'SESSION_ID_INVALID',
  E003: 'DIFF_TOO_LARGE',
  E004: 'SECRET_MASKING_FAILED',
  E005: 'GIT_COMMAND_FAILED',
  E006: 'LLM_TIMEOUT',
  E007: 'LLM_UNAVAILABLE',
  E008: 'DB_ERROR',
  E009: 'STATIC_ANALYSIS_FAILED',
  E010: 'DIFFGUARD_MCP_ERROR',
  E011: 'ASTMEND_MCP_ERROR',
} as const;

export const ReviewWarnings = {
  W001: 'DEGRADED_MODE',
  W002: 'NO_CHANGES_DETECTED',
  W003: 'BINARY_FILES_SKIPPED',
  W004: 'DIFFGUARD_UNAVAILABLE',
  W005: 'ASTMEND_UNAVAILABLE',
} as const;

export const REVIEW_LIMITS = {
  MAX_DIFF_LINES: 500,
  MAX_FILES: 20,
  MAX_LINES_PER_FILE: 300,
  MAX_SESSION_ID_LENGTH: 256,
  LLM_TIMEOUT_MS: 30_000,
  EXECUTION_RECORD_TTL_DAYS: 30,
} as const;
```

---

## 5. 既存リソース活用マッピング

> ⚠️ **鉄則**: 新規テーブルの前に既存テーブルで代替できないか確認する。

| 役割 | 使用リソース | 既存 API 関数 | Stage |
|------|-------------|-------------|-------|
| レビュー実行ログ | `experience_logs` | `saveExperience()` | C〜 |
| 過去 finding 検索 | `vibe_memories` | `saveMemory()` / `searchMemory()` | C〜 |
| Principle / Heuristic / Pattern | Guidance Registry (`vibe_memories` の `metadata.kind='guidance'`) | `saveGuidance()` / `getAlwaysOnGuidance()` / `getOnDemandGuidance()` | C〜 |
| finding → Guidance 関係追跡 | `entities` + `relations` (KG) | `saveMemory()` with entities/relations | C〜 |
| レビューケース管理 | **`review_cases`** (新規) | Stage C で実装 | C〜 |
| finding 採用/却下追跡 | **`review_outcomes`** (新規) | Stage C で実装 | C〜 |

### 既存関数シグネチャ（実装時参照）

```typescript
// src/services/experience.ts
saveExperience(input: ExperienceInput): Promise<void>
// ExperienceInput = { sessionId, scenarioId, attempt, type, content, failureType?, metadata? }

// src/services/memory.ts
saveMemory(sessionId: string, content: string, metadata?: Record<string, unknown>): Promise<VibeMemory>
searchMemory(sessionId: string, query: string, limit?: number): Promise<VibeMemory[]>

// src/services/guidance/register.ts
saveGuidance(input: {
  title: string; content: string; guidanceType: GuidanceType;
  scope: GuidanceScope; priority: number; tags?: string[];
  archiveKey?: string; sessionId?: string;
}): Promise<{ id: string; archiveKey: string }>

// src/services/guidance/search.ts
getAlwaysOnGuidance(limit?: number): Promise<GuidanceRow[]>
getOnDemandGuidance(query: string, limit?: number, minSimilarity?: number): Promise<GuidanceRow[]>
getGuidanceContext(query: string): Promise<string>
```

> ❌ **命名衝突注意**: `knowledge_sources` は既存テーブル（KnowFlow の URL ソース管理）。コードレビュー用に同名テーブルは作らない。

---

## 6. LLM サービスインターフェース

既存の `src/services/llm.ts` はローカル LLM の shell script 実行（`spawnSync`）に特化している。
コードレビュー用に以下の抽象インターフェースを `src/services/review/llm/types.ts` に定義する。

```typescript
/**
 * コードレビュー用 LLM インターフェース。
 * 既存 llm.ts のラッパーとクラウド API 呼び出しの両方をこのインターフェースで統一する。
 */
interface ReviewLLMService {
  generate(prompt: string, options?: { format?: 'json' | 'text' }): Promise<string>;
  readonly provider: 'local' | 'cloud';
}
```

### 実装ファイル

| ファイル | 役割 |
|---------|------|
| `llm/localProvider.ts` | 既存 `llm.ts` の shell script 呼び出しを `ReviewLLMService` でラップ。`Bun.spawn` で非同期化。 |
| `llm/cloudProvider.ts` | 環境変数 `GNOSIS_REVIEW_LLM_PROVIDER` で OpenAI / Anthropic / Google を切り替え。 |
| `llm/reviewer.ts` | `getReviewLLMService(preference)` でプロバイダーを取得。cloud 不可時は local にフォールバック。両方不可なら `ReviewError('E007')`。 |

### ローカル LLM の制限事項

- 既存 `llm.ts` は `spawnSync` でブロッキング実行する。`Bun.spawn` の非同期版に変換するか Worker で実行する
- タイムアウトは `REVIEW_LIMITS.LLM_TIMEOUT_MS` を適用
- ローカル LLM には **判定（問題なし / merge 可否 / 高重大度の確定）を出させない**

---

## 7. 技術スタック

### 言語・ランタイム

- **TypeScript** (^6.0.2) + **Bun** (1.3.12)

### データベース

- **PostgreSQL** + **pgvector** / **Drizzle ORM** (^0.45.2)

### 既存依存（追加不要）

```json
{
  "@modelcontextprotocol/sdk": "^1.29.0",
  "drizzle-orm": "^0.45.2",
  "pg": "^8.16.3",
  "zod": "^3.25.76"
}
```

### 追加が必要なライブラリ

```json
{
  "simple-git": "^3.21.0",
  "parse-diff": "^0.11.1"
}
```

### 外部 MCP ツール（兄弟リポジトリ）

| MCP サーバー | リポジトリ | 利用 Stage | 用途 |
|-------------|-----------|-----------|------|
| **DiffGuard** | `../DiffGuard` | B〜 | diff 構造化 (`analyze_diff`)、決定論ルールチェック (`review_diff`)、バッチレビュー (`review_batch`) |
| **Astmend** | `../Astmend` | B〜D | 参照解析 (`analyze_references_from_text`)、影響範囲検出 (`detect_impact_from_text`)、AST パッチ適用 (`apply_patch_to_text`) |

両ツールとも `stdio` MCP で起動する。不在時は縮退動作で続行する（Section 4 `E010`/`E011` 参照）。

> **AST 解析はプロセス内ライブラリとして組み込まない**。Astmend MCP を外部プロセスとして呼び出すことで、
> Gnosis 本体の依存を増やさずに AST レベルの構造解析を利用する。

### 使わないもの

- ❌ tree-sitter / ts-morph（AST は Astmend MCP 経由で利用）
- ❌ Docker 化 / マイクロサービス化
- ❌ `execa`（Bun 環境では `Bun.spawn` / `Bun.$` を使う）

---

## 8. ディレクトリ構成

```
src/
  services/
    review/
      types.ts               # 共通型 (Section 3) + ReviewLLMService
      errors.ts              # ReviewError, エラーコード, REVIEW_LIMITS
      foundation/
        allowedRoots.ts
        sessionId.ts
        gitDiff.ts
        secretMask.ts
        hardLimit.ts
      static/                # Stage B〜
        runner.ts
        classifier.ts
        signals.ts
        diffguard.ts         # DiffGuard MCP 連携
        astmend.ts           # Astmend MCP 連携（参照解析・影響範囲）
      diff/                  # Stage B〜
        normalizer.ts
        lineMap.ts
        validator.ts
      planner/               # Stage B〜
        riskScorer.ts
        contextExpander.ts
      llm/
        types.ts             # ReviewLLMService
        localProvider.ts     # 既存 llm.ts ラッパー
        cloudProvider.ts     # クラウド API
        promptBuilder.ts     # V1/V2/V3
        hallucinator.ts
        reviewer.ts
      knowledge/             # Stage C〜
        retriever.ts
        scorer.ts
        persister.ts
        evolution.ts         # Stage D
        fixSuggester.ts      # Stage D: Astmend 修正候補生成
      render/
        markdown.ts
      metrics/               # Stage D
        calculator.ts
        dashboard.ts
      orchestrator.ts
  mcp/
    tools/
      review.ts
  scripts/
    review.ts                # CLI エントリーポイント
    review/
      seedGuidance.ts        # Stage C: Guidance 初期データ投入
```
