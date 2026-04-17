# Gnosis Code Review — Stage E: マルチ LLM レビュアー + レビュアーツール基盤

**前提**: [共通基盤](./code-review-foundation.md) / Stage A〜D が完成していること  
**依存 Stage**: Stage A（最低限）、Stage B 以降で完全活用  
**Version**: 1.0  
**完成の定義**: 環境変数 `GNOSIS_REVIEWER` で `gemma4|bonsai|bedrock|openai` を切り替えて各 LLM がレビューを実施でき、レビュアー LLM が自律的にファイル参照・Git 状況確認（読み取り専用）を行えること

---

## 目次

1. [背景と課題](#1-背景と課題)
2. [設計方針](#2-設計方針)
3. [Phase 1: Named Reviewer LLM 対応](#3-phase-1-named-reviewer-llm-対応)
4. [Phase 2: Reviewer Tool 基盤](#4-phase-2-reviewer-tool-基盤)
5. [Phase 3: tool_use 連携（全 LLM 対応）](#5-phase-3-tool_use-連携全-llm-対応)
6. [型定義の追加・変更](#6-型定義の追加変更)
7. [環境変数・設定](#7-環境変数設定)
8. [ディレクトリ構成への追加](#8-ディレクトリ構成への追加)
9. [実装チェックリスト](#9-実装チェックリスト)
10. [エッジケース](#10-エッジケース)

---

## 1. 背景と課題

### 現状

```
ReviewLLMService
  ├── provider: 'local'   → localProvider.ts (scriptPath=config.llmScript=gemma4固定)
  └── provider: 'cloud'   → cloudProvider.ts (env GNOSIS_REVIEW_LLM_PROVIDER で切り替え)
```

- `local-llm-cli.ts` は `LocalLlmAlias = 'gemma4' | 'bonsai' | 'openai' | 'bedrock'` を既に定義している
- しかし `ReviewLLMService` からは「gemma4 か bonsai か」を指定できない（`config.llmScript` 固定）
- `openai` / `bedrock` の alias は `ask-llm.ts` 経由でクラウド API を呼ぶが、`cloudProvider.ts` とは別経路
- MCP からコール元 LLM が Context を渡す際、**レビュアー LLM 自身がファイルや Git の状況を能動的に調べる手段がない**

### 解決したいこと

1. **Named Reviewer**: 環境変数 `GNOSIS_REVIEWER` で `gemma4 / bonsai / bedrock / openai` を切り替える（MCP / CLI からの指定は行わない）
2. **Reviewer Tools**: レビュアー LLM が自律的に使える「ファイル読み取り・Git 参照・コード検索・静的解析・Gnosis 知識参照・Web 検索」ツール群（**読み取り専用・編集不可**）
3. **Context 補完**: MCP コール元が渡した Context に不足があれば、レビュアーが Tool を使って自力補完する
4. **全 LLM で tool_use**: gemma4 / bonsai を含む全 LLM が tool_use / agentic loop を利用できる（能力に応じてモード分岐）
5. **Gnosis 経験の活用**: 過去のレビュー教訓・ガイダンス（rule / skill 両方）・知識クレームをレビュアーが動的に参照し、指摘の根拠として利用する
6. **静的解析の実行**: typecheck / lint をレビュアーがオンデマンドで実行し、その結果を指摘に統合する

---

## 2. 設計方針

### 2-1. LLM 分類の整理

```
ReviewerAlias
  ├── LOCAL
  │     ├── gemma4   (MLX バックエンド, 軽量 4bit, macOS Apple Silicon)
  │     └── bonsai   (Bonsai バックエンド, 1bit 超軽量)
  └── CLOUD
        ├── bedrock  (AWS Bedrock / Claude on Bedrock)
        └── openai   (OpenAI GPT-4o / gpt-4.1 等)
```

- `gemma4` / `bonsai` は既存 `local-llm-cli.ts` の alias を流用
- `bedrock` / `openai` は既存 `cloudProvider.ts` の `ReviewCloudProvider` を流用
- **新たなランタイム追加は最小限**。既存の alias 解決・起動メカニズムを再利用する
- **選択手段**: 環境変数 `GNOSIS_REVIEWER` のみ。MCP ツール引数・CLI フラグでの動的切り替えは行わない

### 2-2. Reviewer Tool の設計方針

```
ReviewerTool (LLM が呼び出せるツール)
  ├── 【鉄則】読み取り専用 — ファイル書き込み・Git 操作・シェル実行は一切持たない
  ├── 【鉄則】リポジトリルート外への参照は禁止（allowedRoots 制約を継承）
  ├── 出力サイズに上限（REVIEW_LIMITS 拡張）
  └── ツール実行結果は messages に追記してから再度 LLM に渡す
```

> **設計意図**: レビュアー LLM はコードを「見る」「指摘する」ことに特化する。
> 修正の適用・ファイル編集・コミット操作は一切レビュアーの責務外とする。
> これにより、レビュアーが誤ってコードを壊す事故を構造的に防ぐ。

### 2-3. Tool 呼び出しフロー

```
MCP コール元 LLM
  │  (reviewRequest + context)  ← LLM 選択は環境変数で決定済み
  ▼
Gnosis Review Orchestrator
  │
  ├─ [Phase 1] GNOSIS_REVIEWER から LLM を解決
  │
  ├─ [Phase 2] Reviewer Tools を定義（読み取り専用のみ）
  │
  └─ [Phase 3] LLM に Tools を提供 → agentic loop
                │
                ├── LLM が tool_call を返す（cloud: ネイティブ / local: プロンプト形式）
                │     └─ Orchestrator が tool を実行 → 結果を messages に追加
                ├── LLM が再度 tool_call を返す（最大 MAX_TOOL_ROUNDS 回）
                └── LLM が最終 JSON を返す → ReviewOutput
```

**LLM 別の tool_use 実装方式**:

| alias | tool_use 方式 | 備考 |
|-------|-------------|------|
| `bedrock` | Anthropic tool_use ブロック（ネイティブ） | `rawAssistantContent` 経由 |
| `openai` | OpenAI function_calling（ネイティブ） | `tool_calls` フィールド |
| `gemma4` | XML タグ形式プロンプト（擬似 tool_use） | `<tool_call>` パース |
| `bonsai` | XML タグ形式プロンプト（擬似 tool_use） | `<tool_call>` パース |

---

## 3. Phase 1: Named Reviewer LLM 対応

> **原則**: レビュアー LLM の選択は **環境変数 `GNOSIS_REVIEWER` のみ** で行う。
> MCP ツール引数・CLI フラグによる動的切り替えは提供しない。
> これにより、実行環境（ローカル開発機 / CI / MCP ホスト）ごとに適切な LLM を固定できる。

### 3-1. ReviewerAlias 型の追加

`src/services/review/types.ts` に追加：

```typescript
/** レビュアー LLM の名前指定 */
export type ReviewerAlias = 'gemma4' | 'bonsai' | 'bedrock' | 'openai';

// ReviewRequest からは reviewer フィールドを持たない
// LLM の選択は環境変数 GNOSIS_REVIEWER のみで決定する
```

### 3-2. localProvider.ts の拡張

現在: `scriptPath` は `config.llmScript` 固定  
変更後: `alias` を受け取り `local-llm-cli.ts` の `resolveLauncherPlan` を使って動的解決

```typescript
// src/services/review/llm/localProvider.ts

import { type LocalLlmAlias, resolveLauncherPlan } from '../../../scripts/local-llm-cli.js';

type LocalProviderOptions = {
  alias?: LocalLlmAlias;  // 'gemma4' | 'bonsai'
  scriptPath?: string;    // 後方互換: alias 未指定時のフォールバック
  timeoutMs?: number;
};

export function createLocalReviewLLMService(opts: LocalProviderOptions = {}): ReviewLLMService {
  const alias = opts.alias ?? 'gemma4';
  const plan = resolveLauncherPlan(alias, ['--output', 'text']);
  // plan.command / plan.args で spawn
  // ...
}
```

### 3-3. reviewer.ts の getReviewLLMService 変更

```typescript
// src/services/review/llm/reviewer.ts

/**
 * 環境変数 GNOSIS_REVIEWER からレビュアー LLM を解決して返す。
 * 引数は受け取らない — 選択は常に環境変数が唯一の決定源。
 */
export async function getReviewLLMService(): Promise<ReviewLLMService> {
  const alias = resolveReviewerAlias();

  switch (alias) {
    case 'gemma4':
      return createLocalReviewLLMService({ alias: 'gemma4' });
    case 'bonsai':
      return createLocalReviewLLMService({ alias: 'bonsai' });
    case 'bedrock':
      return createCloudReviewLLMService({ provider: 'bedrock' });
    case 'openai':
      return createCloudReviewLLMService({ provider: 'openai' });
  }
}

export function resolveReviewerAlias(): ReviewerAlias {
  const env = process.env.GNOSIS_REVIEWER?.trim().toLowerCase();
  if (env === 'gemma4' || env === 'bonsai' || env === 'bedrock' || env === 'openai') return env;
  return 'bedrock';  // デフォルト: bedrock
}
```

### 3-4. CLI・MCP への影響

- CLI (`gnosis review run`) に `--reviewer` フラグは**追加しない**
- MCP ツール (`run_review` 等) に `reviewer` パラメータは**追加しない**
- 実行時のレビュアーは `GNOSIS_REVIEWER` 環境変数から読み取り、`ReviewMetadata.reviewer_alias` に記録するのみ

```typescript
// orchestrator.ts での使用例
const llmService = await getReviewLLMService();  // 引数なし
const alias = resolveReviewerAlias();             // ログ・メタデータ記録用
```

---

## 4. Phase 2: Reviewer Tool 基盤

レビュアー LLM が自律的に実行できるツール群を `src/services/review/tools/` に実装する。

### 4-1. ツール一覧

ツールを **5 カテゴリ** に分類する。すべて読み取り専用（副作用なし）。

#### A. コード参照ツール

| ツール名 | 概要 | 制約 |
|---------|------|------|
| `read_file` | ファイル内容の取得（行範囲指定可） | allowedRoots 内のみ / 最大 MAX_TOOL_FILE_LINES 行 |
| `list_dir` | ディレクトリのファイル一覧 | allowedRoots 内のみ / 最大深さ 3 |
| `search_code` | リポジトリ内の grep 検索 | 固定文字列のみ / 最大 100 件マッチ |
| `get_symbols` | ファイル内のトップレベルシンボル一覧 (TS/JS) | Astmend MCP 経由 (縮退可) |

#### B. Git 参照ツール

| ツール名 | 概要 | 制約 |
|---------|------|------|
| `git_diff` | 指定 ref 間の diff 取得（ファイル限定可） | MAX_DIFF_LINES 適用 |
| `git_log` | コミット履歴の取得 | 最大 50 件 |
| `git_blame` | 行ごとの最終コミット情報 | 指定ファイル・行範囲のみ |
| `git_show` | 特定コミットの内容確認 | 最大 MAX_TOOL_FILE_LINES 行 |

#### C. 静的解析ツール

| ツール名 | 概要 | 制約 |
|---------|------|------|
| `run_typecheck` | tsc --noEmit を実行して型エラーを返す | 既存 `static/runner.ts` の `ALLOWED_TOOLS` を流用 / タイムアウト 20s |
| `run_lint` | ESLint / Ruff 等を実行して lint エラーを返す | 同上 / 変更ファイル限定で実行 |

> これらは既存の `runStaticAnalysis()` / `runTool()` を薄くラップするだけ。新規実装は最小限。

#### D. Gnosis 知識参照ツール

レビュアー LLM が Gnosis に蓄積された**プロジェクト固有の経験・ルール・ベストプラクティス**を動的に参照するためのツール群。
既存の Gnosis MCP サービス関数（`src/services/` 配下）を `ReviewerToolContext` 経由で呼び出す。

| ツール名 | 概要 | 参照先 | 制約 |
|---------|------|--------|------|
| `recall_lessons` | 過去の失敗・成功教訓を類似度検索で取得 | `experience_logs` | 最大 5 件 |
| `search_memory` | vibe_memories をセマンティック検索 | `vibe_memories` | 最大 5 件 |
| `get_guidance` | ルール・スキル・ベストプラクティスを取得 | Guidance Registry (`vibe_memories` の `metadata.kind='guidance'`) | always-on + on_demand 両方 |
| `search_knowledge` | knowFlow の構造化知識クレームを全文検索 | `knowledge_claims` | 最大 5 件 |

> **ベストプラクティスは `rule` 型と `skill` 型の両方に存在する。**
> - `rule`: 「〜してはいけない」「〜を必ず行う」といった禁止・義務規約
> - `skill`: 「〜の場合は〜の手順で対処する」といった条件付きの具体的手順・ノウハウ
>
> `get_guidance` ツールは `guidanceType` を `rule` に限定せず、**`rule` と `skill` の両方を取得する**。
> `scope: 'always'` の guidance は常に取得し、`scope: 'on_demand'` は diff の内容にマッチするものを取得する。

#### E. Web 検索ツール

| ツール名 | 概要 | 制約 |
|---------|------|------|
| `web_search` | セキュリティ脆弱性・外部仕様・ベストプラクティスを検索 | クエリ文字列のみ（URL 直接アクセス不可）/ 最大 5 件 |

> Web 検索は **セキュリティ情報（CVE 等）・外部 API 仕様・言語ランタイムの既知バグ** の確認に限定する用途を推奨。
> 実装は既存の Web 検索統合（KnowFlow の `search_web` または外部 Search API）を流用する。

### 4-2. 実装ファイル構成

```
src/services/review/tools/
  index.ts          # ReviewerToolRegistry + buildDefaultToolRegistry
  types.ts          # ReviewerTool 型定義 / ReviewerToolContext
  # --- A. コード参照 ---
  readFile.ts       # read_file / list_dir
  searchCode.ts     # search_code
  getSymbols.ts     # get_symbols (Astmend MCP ラッパー)
  # --- B. Git 参照 ---
  gitTools.ts       # git_diff / git_log / git_blame / git_show
  # --- C. 静的解析 ---
  staticAnalysis.ts # run_typecheck / run_lint (既存 runner.ts をラップ)
  # --- D. Gnosis 知識参照 ---
  gnosisTools.ts    # recall_lessons / search_memory / get_guidance / search_knowledge
  # --- E. Web 検索 ---
  webSearch.ts      # web_search
```

### 4-3. ReviewerTool 型定義

```typescript
// src/services/review/tools/types.ts

export interface ReviewerToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for input parameters */
  inputSchema: Record<string, unknown>;
}

export interface ReviewerToolContext {
  repoPath: string;              // allowedRoots で検証済みリポジトリルート
  mcpCaller?: ReviewMcpToolCaller; // Astmend 連携用
  /** Gnosis 知識参照に使うセッション ID（コードレビュー用セッション）*/
  gnosisSessionId: string;
  /**
   * Web 検索の実行関数。
   * 未提供時は web_search ツールが縮退モード（空結果）で動作する。
   * 既存の KnowFlow web 検索統合を注入する想定。
   */
  webSearchFn?: (query: string, limit: number) => Promise<string[]>;
  /** agentic loop の最大ラウンド数。省略時は REVIEW_LIMITS.MAX_TOOL_ROUNDS */
  maxToolRounds?: number;
}

/** Phase 3 で使用する型エイリアス */
export type ReviewContext = ReviewContextV1 | ReviewContextV2 | ReviewContextV3;
export type ReviewLLMResult = { findings: Finding[]; summary: string; next_actions: string[] };

export type ReviewerToolHandler = (
  args: Record<string, unknown>,
  ctx: ReviewerToolContext,
) => Promise<string>;  // LLM に返すテキスト結果

export interface ReviewerToolEntry {
  definition: ReviewerToolDefinition;
  handler: ReviewerToolHandler;
}
```

### 4-4. ツール定義の実装例

#### read_file

```typescript
// src/services/review/tools/readFile.ts

export const readFileToolEntry: ReviewerToolEntry = {
  definition: {
    name: 'read_file',
    description: 'リポジトリ内のファイル内容を取得します。行範囲を指定できます。',
    inputSchema: {
      type: 'object',
      required: ['file_path'],
      properties: {
        file_path: { type: 'string', description: 'リポジトリルートからの相対パス' },
        start_line: { type: 'integer', minimum: 1 },
        end_line: { type: 'integer', minimum: 1 },
      },
    },
  },
  async handler(args, ctx) {
    // 1. allowedRoots 検証
    // 2. path.join(ctx.repoPath, file_path) を安全に解決
    // 3. MAX_TOOL_FILE_LINES (デフォルト 200) を適用
    // 4. 内容を返す
  },
};
```

#### git_diff

```typescript
export const gitDiffToolEntry: ReviewerToolEntry = {
  definition: {
    name: 'git_diff',
    description: '指定した ref 間の diff を取得します。file_paths で絞り込めます。',
    inputSchema: {
      type: 'object',
      properties: {
        base_ref: { type: 'string', default: 'HEAD~1' },
        head_ref: { type: 'string', default: 'HEAD' },
        file_paths: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  async handler(args, ctx) {
    // simple-git を使用
    // MAX_DIFF_LINES で切り詰め
  },
};
```

#### search_code

```typescript
export const searchCodeToolEntry: ReviewerToolEntry = {
  definition: {
    name: 'search_code',
    description: 'リポジトリ内をキーワードで検索します。',
    inputSchema: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: { type: 'string', description: '検索パターン（正規表現不可・固定文字列）' },
        include_glob: { type: 'string', description: '対象ファイルのglobパターン' },
        max_results: { type: 'integer', default: 50, maximum: 100 },
      },
    },
  },
  async handler(args, ctx) {
    // Bun.$ または simple-git の grep 機能を使用
    // 固定文字列検索のみ（任意正規表現は禁止）
  },
};
```

#### gnosisTools.ts（Gnosis 知識参照）

```typescript
// src/services/review/tools/gnosisTools.ts
//
// 既存 Gnosis サービス関数を ReviewerTool としてラップする。
// DB アクセスは既存 services/ 関数を直接呼ぶ（MCP 経由ではなく直接呼び出し）。

import { recallExperienceLessons } from '../../../services/experience.js';
import { getAlwaysOnGuidance, getOnDemandGuidance } from '../../../services/guidance/search.js';
import { searchKnowledgeClaims } from '../../../services/knowledge.js';
import { searchMemory } from '../../../services/memory.js';

export const recallLessonsToolEntry: ReviewerToolEntry = {
  definition: {
    name: 'recall_lessons',
    description: 'Gnosis に蓄積された過去の失敗・成功教訓を、現在のレビュー内容に類似した事例から検索します。',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: '検索クエリ（レビュー中の問題・パターンの説明）' },
        limit: { type: 'integer', default: 5, maximum: 10 },
      },
    },
  },
  async handler(args, ctx) {
    const results = await recallExperienceLessons(
      ctx.gnosisSessionId,
      String(args.query),
      Number(args.limit ?? 5),
    );
    return JSON.stringify(results, null, 2);
  },
};

export const searchMemoryToolEntry: ReviewerToolEntry = {
  definition: {
    name: 'search_memory',
    description: 'Gnosis vibe_memories をセマンティック検索します。過去の観察・知見・設計決定を参照します。',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', default: 5, maximum: 10 },
      },
    },
  },
  async handler(args, ctx) {
    const results = await searchMemory(ctx.gnosisSessionId, String(args.query), Number(args.limit ?? 5));
    return JSON.stringify(results, null, 2);
  },
};

export const getGuidanceToolEntry: ReviewerToolEntry = {
  definition: {
    name: 'get_guidance',
    description: [
      'Gnosis Guidance Registry からルール・ベストプラクティスを取得します。',
      '`scope: always` のガイダンス（常時適用のルール）と、クエリに関連する `scope: on_demand` のガイダンスを返します。',
      'ガイダンスは rule 型（禁止・義務規約）と skill 型（手順・ノウハウ・ベストプラクティス）の両方を含みます。',
    ].join(' '),
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'レビュー対象コードの内容・懸念点の説明（on_demand 検索クエリに使用）' },
      },
    },
  },
  async handler(args, ctx) {
    // always-on: rule + skill 両方を取得
    const [always, onDemand] = await Promise.all([
      getAlwaysOnGuidance(),
      getOnDemandGuidance(String(args.query)),
    ]);
    const result = {
      always_on: always.map(g => ({ content: g.content, metadata: g.metadata })),
      on_demand: onDemand.map(g => ({ content: g.content, metadata: g.metadata, similarity: (g as { similarity?: number }).similarity })),
    };
    return JSON.stringify(result, null, 2);
  },
};

export const searchKnowledgeToolEntry: ReviewerToolEntry = {
  definition: {
    name: 'search_knowledge',
    description: 'KnowFlow が収集・検証した構造化知識クレームを全文検索します。セキュリティ・設計パターン等の外部知識に有効です。',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', default: 5, maximum: 10 },
      },
    },
  },
  async handler(args, ctx) {
    const results = await searchKnowledgeClaims(String(args.query), Number(args.limit ?? 5));
    return JSON.stringify(results, null, 2);
  },
};
```

#### staticAnalysis.ts（静的解析）

```typescript
// src/services/review/tools/staticAnalysis.ts
//
// 既存の ALLOWED_TOOLS を薄くラップする。
// 任意コマンド実行は不可。ホワイトリストのみ許可。
// run_typecheck と run_lint は実行するツールの種別を明示的に分離する。

import { runStaticAnalysisByKind } from '../static/runner.js';
// ↑ 既存 runStaticAnalysis を kind ('typecheck' | 'lint') で分岐する薄い拡張

export const runTypecheckToolEntry: ReviewerToolEntry = {
  definition: {
    name: 'run_typecheck',
    description: '変更ファイルに対して tsc --noEmit を実行し、型エラーを返します。TypeScript / JavaScript プロジェクト限定。',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: '対象ファイルのリスト（省略時は diff の変更ファイル全体）' },
      },
    },
  },
  async handler(args, ctx) {
    const files = Array.isArray(args.files) ? (args.files as string[]) : [];
    const { findings, degraded } = await runStaticAnalysisByKind('typecheck', files, ctx.repoPath);
    if (degraded) return '[typecheck unavailable: tsc not found or timed out]';
    return JSON.stringify(findings, null, 2);
  },
};

export const runLintToolEntry: ReviewerToolEntry = {
  definition: {
    name: 'run_lint',
    description: 'ESLint / Biome / Ruff / golangci-lint 等を実行し、lint エラーを返します。言語に応じたツールが自動選択されます。',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: '対象ファイルのリスト' },
      },
    },
  },
  async handler(args, ctx) {
    const files = Array.isArray(args.files) ? (args.files as string[]) : [];
    const { findings, degraded } = await runStaticAnalysisByKind('lint', files, ctx.repoPath);
    if (degraded) return '[lint unavailable: linter not found or timed out]';
    return JSON.stringify(findings, null, 2);
  },
};
```

> **実装注意**: 既存 `runStaticAnalysis()` に `kind` 引数を追加して `runStaticAnalysisByKind()` を実装する。
> - `kind: 'typecheck'` → `ALLOWED_TOOLS` から `tsc --noEmit` のみ抽出
> - `kind: 'lint'` → `ALLOWED_TOOLS` から `eslint` / `ruff` / `clippy` / `golangci-lint` のみ抽出
> これにより LLM が `run_typecheck` と `run_lint` を別々に呼んで異なる結果を得られる。

#### webSearch.ts（Web 検索）

```typescript
// src/services/review/tools/webSearch.ts

export const webSearchToolEntry: ReviewerToolEntry = {
  definition: {
    name: 'web_search',
    description: [
      'CVE・セキュリティ情報・外部仕様・言語ランタイムの既知バグをWeb検索します。',
      '依存ライブラリの脆弱性確認、セキュリティベストプラクティスの照合に使用してください。',
    ].join(' '),
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: '検索クエリ（例: "CVE-2024-XXXX", "express.js security best practices"）' },
        limit: { type: 'integer', default: 5, maximum: 10 },
      },
    },
  },
  async handler(args, ctx) {
    if (!ctx.webSearchFn) {
      return '[web_search unavailable: no search provider configured]';
    }
    const results = await ctx.webSearchFn(String(args.query), Number(args.limit ?? 5));
    return results.join('\n\n');
  },
};
```

### 4-5. ReviewerToolRegistry

```typescript
// src/services/review/tools/index.ts

export class ReviewerToolRegistry {
  private entries: Map<string, ReviewerToolEntry> = new Map();

  register(entry: ReviewerToolEntry): void {
    this.entries.set(entry.definition.name, entry);
  }

  /** cloud LLM の tool_use 定義形式に変換 */
  toLLMToolDefinitions(): LLMToolDefinition[] {
    return [...this.entries.values()].map(e => ({
      name: e.definition.name,
      description: e.definition.description,
      parameters: e.definition.inputSchema,
    }));
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ReviewerToolContext): Promise<string> {
    const entry = this.entries.get(name);
    if (!entry) throw new ReviewError('E012', `Unknown reviewer tool: ${name}`);
    return entry.handler(args, ctx);
  }
}

export function buildDefaultToolRegistry(): ReviewerToolRegistry {
  const registry = new ReviewerToolRegistry();

  // A. コード参照
  registry.register(readFileToolEntry);
  registry.register(listDirToolEntry);
  registry.register(searchCodeToolEntry);
  registry.register(getSymbolsToolEntry);

  // B. Git 参照
  registry.register(gitDiffToolEntry);
  registry.register(gitLogToolEntry);
  registry.register(gitBlameToolEntry);
  registry.register(gitShowToolEntry);

  // C. 静的解析
  registry.register(runTypecheckToolEntry);
  registry.register(runLintToolEntry);

  // D. Gnosis 知識参照
  registry.register(recallLessonsToolEntry);
  registry.register(searchMemoryToolEntry);
  registry.register(getGuidanceToolEntry);   // rule + skill 両方を返す
  registry.register(searchKnowledgeToolEntry);

  // E. Web 検索
  registry.register(webSearchToolEntry);

  return registry;
}
```

---

## 5. Phase 3: tool_use 連携（全 LLM 対応）

### 5-1. Agentic Loop の設計

**全ての LLM が tool_use に参加できる**。ただし、ネイティブ対応の有無によって内部実装が異なる。

```
┌──────────────────────────────────────────────────────────────┐
│ reviewWithTools(context, llmService, toolRegistry, toolCtx)  │
│                                                               │
│  bedrock / openai → Native tool_use (generateMessagesStructured)
│  gemma4 / bonsai  → Pseudo tool_use (XML タグ形式プロンプト)  │
└──────────────────────────────────────────────────────────────┘
```

### 5-2. Native tool_use (bedrock / openai)

```typescript
// src/services/review/llm/agenticReviewer.ts

export async function reviewWithNativeTools(
  context: ReviewContext,
  llmService: ReviewLLMService,
  toolRegistry: ReviewerToolRegistry,
  toolCtx: ReviewerToolContext,
  maxRounds: number,
): Promise<ReviewLLMResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(context) },
    { role: 'user', content: buildUserPrompt(context) },
  ];
  const tools = toolRegistry.toLLMToolDefinitions();

  for (let round = 0; round < maxRounds; round++) {
    const result = await llmService.generateMessagesStructured!(messages, { tools });

    if (!result.toolCalls?.length) {
      return parseReviewOutput(result.text);
    }

    for (const call of result.toolCalls) {
      const toolResult = await toolRegistry.execute(call.name, call.arguments, toolCtx);
      messages.push(buildToolResultMessage(call, toolResult, result.rawAssistantContent));
    }
  }

  // ラウンド上限到達 → ツールなしで最終回答を強制
  const finalResult = await llmService.generateMessagesStructured!(messages, {});
  return parseReviewOutput(finalResult.text);
}
```

### 5-3. Pseudo tool_use (gemma4 / bonsai)

Local LLM は `generateMessagesStructured` を持たない。
代わりに **XML タグ形式のプロンプト規約** でツール呼び出しを擬似的に実現する。

```
[System prompt に追加するツール仕様]
利用可能なツール:
- read_file(file_path, start_line?, end_line?) → ファイル内容を返す
- git_diff(base_ref?, head_ref?, file_paths?) → diff を返す
- search_code(pattern, include_glob?, max_results?) → 検索結果を返す
...

ツールを使う場合は以下の形式で出力してください:
<tool_call>
{"name": "read_file", "arguments": {"file_path": "src/foo.ts"}}
</tool_call>

ツールが不要になったら最終回答を JSON で出力してください:
<final_answer>
{ "findings": [...], "summary": "...", "next_actions": [...] }
</final_answer>
```

```typescript
// src/services/review/llm/pseudoToolReviewer.ts

export async function reviewWithPseudoTools(
  context: ReviewContext,
  llmService: ReviewLLMService,
  toolRegistry: ReviewerToolRegistry,
  toolCtx: ReviewerToolContext,
  maxRounds: number,
): Promise<ReviewLLMResult> {
  const toolSpec = buildToolSpecPrompt(toolRegistry);
  let conversationText = buildPseudoSystemPrompt(context, toolSpec);
  conversationText += '\n\n' + buildUserPrompt(context);

  for (let round = 0; round < maxRounds; round++) {
    const response = await llmService.generate(conversationText, { format: 'text' });

    // <final_answer> が返ったら終了
    const finalMatch = response.match(/<final_answer>([\s\S]*?)<\/final_answer>/);
    if (finalMatch) {
      return parseReviewOutput(finalMatch[1].trim());
    }

    // <tool_call> をパースして実行
    const toolCallMatch = response.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
    if (!toolCallMatch) {
      // タグなし → そのまま最終回答として処理
      return parseReviewOutput(response);
    }

    const call = JSON.parse(toolCallMatch[1].trim()) as { name: string; arguments: Record<string, unknown> };
    const toolResult = await toolRegistry.execute(call.name, call.arguments, toolCtx);

    // 会話履歴にツール結果を追記
    conversationText += `\n\nAssistant: ${response}\n\nTool Result (${call.name}):\n${toolResult}\n\nContinue reviewing.`;
  }

  // ラウンド上限 → ツールなしで最終回答を強制
  const forced = await llmService.generate(
    conversationText + '\n\nPlease output your final answer now in <final_answer> tags.',
    { format: 'text' },
  );
  const forcedMatch = forced.match(/<final_answer>([\s\S]*?)<\/final_answer>/);
  return parseReviewOutput(forcedMatch ? forcedMatch[1].trim() : forced);
}
```

### 5-4. 統合ルーター

```typescript
// src/services/review/llm/agenticReviewer.ts

export async function reviewWithTools(
  context: ReviewContext,
  llmService: ReviewLLMService,
  toolRegistry: ReviewerToolRegistry,
  toolCtx: ReviewerToolContext,
): Promise<ReviewLLMResult> {
  const maxRounds = toolCtx.maxToolRounds ?? REVIEW_LIMITS.MAX_TOOL_ROUNDS;

  if (llmService.generateMessagesStructured) {
    // bedrock / openai: ネイティブ tool_use
    return reviewWithNativeTools(context, llmService, toolRegistry, toolCtx, maxRounds);
  }

  // gemma4 / bonsai: XML タグ形式の擬似 tool_use
  return reviewWithPseudoTools(context, llmService, toolRegistry, toolCtx, maxRounds);
}
```

### 5-5. Orchestrator への統合

`src/services/review/orchestrator.ts` の `runReview()` を拡張：

```typescript
const llmService = await getReviewLLMService();  // 環境変数から解決
const toolRegistry = buildDefaultToolRegistry(); // 常に有効（読み取り専用のみ）
const toolCtx: ReviewerToolContext = {
  repoPath: request.repoPath,
  mcpCaller: deps.mcpCaller,
  // コードレビュー用の Gnosis セッション（知識参照・教訓検索に使用）
  gnosisSessionId: request.sessionId,
  // Web 検索プロバイダー（未設定時は縮退）
  webSearchFn: deps.webSearchFn,
  maxToolRounds: REVIEW_LIMITS.MAX_TOOL_ROUNDS,
};

const { findings, summary, next_actions } = await reviewWithTools(
  reviewContext, llmService, toolRegistry, toolCtx,
);
```

---

## 6. 型定義の追加・変更

### ReviewRequest への変更なし

```typescript
// ReviewRequest に新しいフィールドは追加しない。
// レビュアー LLM の選択は環境変数 GNOSIS_REVIEWER のみで行うため。
//
// ツール機能は常に有効（読み取り専用ツールのみのため無効化の必要なし）。
// maxToolRounds は REVIEW_LIMITS.MAX_TOOL_ROUNDS 定数で制御する。
```

### ReviewMetadata の拡張

```typescript
interface ReviewMetadata {
  // ...既存フィールド...
  reviewer_alias: ReviewerAlias;         // 環境変数 GNOSIS_REVIEWER から解決したレビュアー名
  tool_use_mode: 'native' | 'pseudo' | 'none';  // tool_use 方式
  tool_rounds_used: number;              // ツールループ回数 (0 = ツール呼び出しなし)
  tools_called: string[];                // 呼び出されたツール名リスト
}
```

### REVIEW_LIMITS の拡張

```typescript
export const REVIEW_LIMITS = {
  // ...既存...
  MAX_TOOL_FILE_LINES: 200,              // read_file の最大行数
  MAX_TOOL_RESULTS_CHARS: 8_000,        // ツール結果の最大文字数
  MAX_TOOL_ROUNDS: 5,                   // agentic loop の最大ラウンド数
  MAX_SEARCH_RESULTS: 100,              // search_code の最大マッチ数
} as const;
```

### ReviewErrors の拡張

```typescript
export const ReviewErrors = {
  // ...既存...
  E012: 'REVIEWER_TOOL_NOT_FOUND',
  E013: 'REVIEWER_TOOL_EXECUTION_FAILED',
  E014: 'TOOL_LOOP_MAX_ROUNDS_EXCEEDED',
} as const;
```

---

## 7. 環境変数・設定

> **原則**: LLM の選択はユーザーが環境変数で設定する。MCP ツール引数・CLI フラグでは制御しない。

### レビュアー LLM 選択

| 環境変数 | 型 | デフォルト | 説明 |
|---------|---|---------|------|
| `GNOSIS_REVIEWER` | string | `bedrock` | レビュアー LLM の alias。`gemma4` / `bonsai` / `bedrock` / `openai` のいずれか |

### Cloud LLM 認証・エンドポイント

| 環境変数 | 型 | デフォルト | 説明 |
|---------|---|---------|------|
| `GNOSIS_REVIEW_LLM_PROVIDER` | string | — | cloudProvider.ts の既存設定。**`GNOSIS_REVIEWER` が `bedrock` / `openai` の場合に自動設定されるため、通常は明示不要**。両方設定された場合は `GNOSIS_REVIEWER` が優先される |
| `GNOSIS_REVIEW_OPENAI_API_KEY` | string | — | OpenAI API キー |
| `GNOSIS_REVIEW_BEDROCK_REGION` | string | `us-east-1` | AWS Bedrock リージョン |
| `GNOSIS_REVIEW_BEDROCK_MODEL` | string | `us.anthropic.claude-sonnet-4-5` | Bedrock モデル ID |

### ツール動作チューニング

| 環境変数 | 型 | デフォルト | 説明 |
|---------|---|---------|------|
| `GNOSIS_MAX_TOOL_ROUNDS` | int | `5` | agentic loop の最大ラウンド数 |
| `GNOSIS_MAX_TOOL_FILE_LINES` | int | `200` | `read_file` の最大行数 |

> `GNOSIS_REVIEWER_TOOLS_ENABLED` は廃止。ツールは読み取り専用のみのため常時有効とする。

### profiles/default.toml への追加案

```toml
[review]
reviewer = "bedrock"          # GNOSIS_REVIEWER の既定値
max_tool_rounds = 5
max_tool_file_lines = 200
```

---

## 8. ディレクトリ構成への追加

```
src/
  services/
    review/
      # ...既存構成（foundation/, llm/, diff/, planner/ 等）...
      tools/                         ← Phase 2 新規
        types.ts                     # ReviewerTool 型定義 / ReviewerToolContext
        index.ts                     # ReviewerToolRegistry + buildDefaultToolRegistry
        readFile.ts                  # [A] read_file, list_dir
        searchCode.ts                # [A] search_code
        getSymbols.ts                # [A] get_symbols (Astmend MCP ラッパー)
        gitTools.ts                  # [B] git_diff, git_log, git_blame, git_show
        staticAnalysis.ts            # [C] run_typecheck, run_lint (runner.ts ラッパー)
        gnosisTools.ts               # [D] recall_lessons, search_memory, get_guidance, search_knowledge
        webSearch.ts                 # [E] web_search
      llm/
        types.ts                     # 既存 (変更なし)
        localProvider.ts             # alias 対応に拡張 ← Phase 1
        cloudProvider.ts             # 既存 (変更なし)
        promptBuilder.ts             # 既存 (変更なし)
        hallucinator.ts              # 既存 (変更なし)
        reviewer.ts                  # getReviewLLMService() を env変数ベースに変更 ← Phase 1
        agenticReviewer.ts           # reviewWithTools() ルーター ← Phase 3 新規
        nativeToolReviewer.ts        # bedrock/openai のネイティブ tool_use ← Phase 3 新規
        pseudoToolReviewer.ts        # gemma4/bonsai の XML タグ擬似 tool_use ← Phase 3 新規
      orchestrator.ts                # reviewer / tools 統合 ← Phase 1,3 拡張
      types.ts                       # ReviewerAlias 追加 ← Phase 1
      errors.ts                      # E012-E014 追加 ← Phase 2,3
      cli.ts                         # 変更なし（--reviewer フラグは追加しない）
  mcp/
    tools/
      review.ts                      # 変更なし（reviewer パラメータは追加しない）
```

---

## 9. 実装チェックリスト

### Phase 1: Named Reviewer LLM 対応

- [ ] `types.ts`: `ReviewerAlias` 型追加（`ReviewRequest` への追加は**なし**）
- [ ] `llm/localProvider.ts`: `alias` オプション対応、`resolveLauncherPlan` を活用した起動
- [ ] `llm/reviewer.ts`: `getReviewLLMService()` を引数なしに変更、`resolveReviewerAlias()` を環境変数から解決
- [ ] `orchestrator.ts`: `getReviewLLMService()` 引数なし呼び出しに変更、`reviewer_alias` を metadata に記録
- [ ] `orchestrator.ts`: `RunReviewDeps` に `webSearchFn?` を追加
- [ ] `errors.ts`: `REVIEW_LIMITS` に `MAX_TOOL_*` 定数追加
- [ ] テスト: `test/review-stage-e.test.ts` に各 alias の起動・切り替えユニットテスト追加

### Phase 2: Reviewer Tool 基盤

**A. コード参照ツール**
- [ ] `tools/types.ts`: `ReviewerToolDefinition / Handler / Entry / Context` 型定義（`gnosisSessionId` / `webSearchFn` を含む）
- [ ] `tools/readFile.ts`: `read_file` / `list_dir` 実装（allowedRoots 検証込み）
- [ ] `tools/searchCode.ts`: `search_code` 実装（固定文字列のみ）
- [ ] `tools/getSymbols.ts`: `get_symbols` 実装（Astmend MCP ラッパー、縮退可）

**B. Git 参照ツール**
- [ ] `tools/gitTools.ts`: `git_diff` / `git_log` / `git_blame` / `git_show` 実装

**C. 静的解析ツール**
- [ ] `static/runner.ts`: `runStaticAnalysisByKind(kind, files, root)` を追加（`kind: 'typecheck' | 'lint'` で ALLOWED_TOOLS を分岐）
- [ ] `tools/staticAnalysis.ts`: `run_typecheck` / `run_lint` 実装（`runStaticAnalysisByKind` をラップ）
- [ ] テスト: ツール利用不可時の縮退動作確認
- [ ] テスト: `run_typecheck` と `run_lint` が異なる結果を返すことを確認

**D. Gnosis 知識参照ツール**
- [ ] `tools/gnosisTools.ts`: `recall_lessons` 実装（`recallExperienceLessons` のラップ）
- [ ] `tools/gnosisTools.ts`: `search_memory` 実装（`searchMemory` のラップ）
- [ ] `tools/gnosisTools.ts`: `get_guidance` 実装 — `rule` + `skill` **両方** を返す（`getAlwaysOnGuidance` + `getOnDemandGuidance` を統合）
- [ ] `tools/gnosisTools.ts`: `search_knowledge` 実装（`searchKnowledgeClaims` のラップ）
- [ ] テスト: `get_guidance` が `guidanceType: 'skill'` のベストプラクティスも返すことを確認

**E. Web 検索ツール**
- [ ] `tools/webSearch.ts`: `web_search` 実装（`webSearchFn` 未設定時は縮退）
- [ ] テスト: `webSearchFn` 未設定時に `[web_search unavailable]` を返すことを確認

**共通**
- [ ] `tools/index.ts`: `ReviewerToolRegistry` / `buildDefaultToolRegistry` 実装（全 5 カテゴリ登録）
- [ ] `errors.ts`: `E012` / `E013` 追加
- [ ] `orchestrator.ts`: `ReviewerToolContext` に `gnosisSessionId` / `webSearchFn` を設定

### Phase 3: tool_use 連携（全 LLM 対応）

- [ ] `llm/nativeToolReviewer.ts`: `reviewWithNativeTools()` 実装（bedrock / openai）
- [ ] `llm/pseudoToolReviewer.ts`: `reviewWithPseudoTools()` 実装（gemma4 / bonsai、XML タグ形式）
- [ ] `llm/agenticReviewer.ts`: `reviewWithTools()` ルーター実装（native / pseudo の分岐）
- [ ] `cloudProvider.ts`: `generateMessagesStructured` の tool_use 拡張（bedrock / openai 両対応）
- [ ] `orchestrator.ts`: `reviewWithTools` を統合（ツール常時有効）
- [ ] `errors.ts`: `E014` / `MAX_TOOL_ROUNDS` 追加
- [ ] `types.ts`: `ReviewMetadata.reviewer_alias` / `tool_use_mode` / `tool_rounds_used` / `tools_called` 追加
- [ ] テスト: native ループのモックテスト（tool_call → result → final answer）
- [ ] テスト: pseudo ループのモックテスト（XML タグパース → ツール実行 → final_answer）

---

## 10. エッジケース

### Pseudo tool_use のコンテキスト肥大化

- `pseudoToolReviewer.ts` は `conversationText` を逐次追記するため、ラウンドが進むとトークン数が膨張する
- Local LLM のコンテキスト窓（gemma4: 約 8K tokens, bonsai: 約 4K tokens）を超える可能性がある
- **対策**: 各ラウンドの先頭で `conversationText` のトークン数を概算し、閾値（コンテキスト窓の 80%）を超えた場合は古いツール結果を `[previous tool results truncated]` に置換する
- それでも超える場合は `MAX_TOOL_ROUNDS` 到達前でもループを打ち切り、`W006_TOOL_LOOP_TRUNCATED` を記録する

### Local LLM (gemma4 / bonsai) が XML タグを出力しないケース

- XML タグなしで直接回答を返した場合は、そのテキストを `parseReviewOutput` で通常処理する
- `<tool_call>` と `<final_answer>` の両方がない場合は最終回答として処理してループを終了する

### Local LLM が不正な JSON を `<tool_call>` に入れるケース

- JSON.parse 失敗時は `E013` を記録してそのラウンドのツール呼び出しをスキップ
- 次のラウンドで LLM に「ツール呼び出しの形式が不正でした。続けてください」を追記して再試行

### Bedrock の tool_use 形式差異

- Bedrock (Anthropic Claude) の tool_use 形式は OpenAI と異なる
- `cloudProvider.ts` の `generateMessagesStructured` は既に `rawAssistantContent` を保持している
- Bedrock 向けには Anthropic 形式のツール結果 (`tool_result` block) を組み立てる必要がある

### ツール実行の無限ループ

- `MAX_TOOL_ROUNDS` で上限を設ける（デフォルト 5）
- 超過した場合は `ReviewWarnings.W006_TOOL_LOOP_TRUNCATED` を metadata に記録して続行

### read_file でバイナリファイルが指定された場合

- `isBinary` チェック（NUL バイト検出）を実施し、バイナリは `[binary file skipped]` を返す

### search_code で大量マッチが返る場合

- `MAX_SEARCH_RESULTS` (100件) で切り詰め、`[結果が切り詰められました: N件中100件表示]` を末尾に追記

### repoPath 外へのパストラバーサル攻撃

- `read_file` / `list_dir` の先頭で `path.resolve` + `startsWith(repoPath)` で検証
- 失敗した場合は `ReviewError('E001')` を throw（既存の allowedRoots 制約を流用）

### Astmend MCP 不在時の get_symbols

- `get_symbols` は縮退モードで `[]` を返す（`W005_ASTMEND_UNAVAILABLE` を記録）
- ツール自体は失敗しない（reviewer が別のツールで代替可能）

### Gnosis DB 未接続時の知識参照ツール

- `recall_lessons` / `search_memory` / `get_guidance` / `search_knowledge` は DB アクセスに失敗した場合、`[]` を返し `W007_GNOSIS_UNAVAILABLE` を記録する
- ツール自体は失敗しない（レビュアーは Gnosis なしでもコード参照・Git 参照で最低限のレビューを続行できる）

### get_guidance の結果が空の場合

- Guidance Registry に登録がない初期状態では always-on / on_demand ともに空配列を返す
- レビュアーはこれを正常な状態として扱い、Gnosis 知識なしで通常レビューを続行する

---

## 参考: 実装優先順位

```
優先度 HIGH   → Phase 1（Named Reviewer）
                  gemma4/bonsai/bedrock/openai を環境変数 GNOSIS_REVIEWER で切り替え可能にする
                  getReviewLLMService() を引数なしに変更し、env 変数のみで解決する

優先度 MEDIUM → Phase 2（Reviewer Tool 基盤）
                  read_file / git_diff / search_code の 3 ツールを先に実装
                  残り (list_dir / git_log / git_blame / get_symbols) は後追い可

優先度 LOW    → Phase 3（Agentic Loop）
                  native tool_use: bedrock → openai の順に実装
                  pseudo tool_use: gemma4 → bonsai の順に実装（XML タグ形式）
```
