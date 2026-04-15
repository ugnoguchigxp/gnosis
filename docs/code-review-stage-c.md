# Gnosis Code Review — Stage C: 記憶するレビュアー

**前提**: [共通基盤](./code-review-foundation.md) / [Stage A](./code-review-stage-a.md) / [Stage B](./code-review-stage-b.md) が完成していること  
**依存 Stage**: Stage A + B  
**完成の定義**: 過去 finding と Guidance（Principle/Heuristic/Pattern）がプロンプトに注入されること

---

## 目標

```
diff → [静的解析] → [Guidance 検索] + [過去 finding 検索] → LLM → [finding 保存] → Markdown
```

- `vibe_memories` に finding を保存し、次回から類似 finding を検索
- `experience_logs` にレビュー実行ログを保存
- Guidance Registry から Principle/Heuristic/Pattern をプロンプトに注入
- `review_cases` / `review_outcomes` テーブルを追加（2 テーブルのみ）

---

## 目次

1. [DB マイグレーション](#1-db-マイグレーション)
2. [Guidance seed データ](#2-guidance-seed-データ)
3. [Knowledge Retrieval](#3-knowledge-retrieval)
4. [プロンプト V3](#4-プロンプト-v3)
5. [永続化](#5-永続化)
6. [オーケストレーター](#6-オーケストレーター)
7. [チェックリスト](#7-チェックリスト)

---

## 1. DB マイグレーション

`drizzle/` ディレクトリに追加する。

### SQL マイグレーション

```sql
-- drizzle/0009_code_review_cases.sql

CREATE TABLE IF NOT EXISTS review_cases (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  base_ref TEXT,
  head_ref TEXT,
  task_goal TEXT,
  trigger TEXT NOT NULL CHECK(trigger IN ('task_completed', 'checkpoint', 'manual')),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK(status IN ('running', 'completed', 'failed')),
  risk_level TEXT
    CHECK(risk_level IN ('low', 'medium', 'high')),
  review_status TEXT
    CHECK(review_status IN ('changes_requested', 'needs_confirmation', 'no_major_findings')),
  summary TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_review_cases_task   ON review_cases(task_id);
CREATE INDEX IF NOT EXISTS idx_review_cases_status ON review_cases(status);
CREATE INDEX IF NOT EXISTS idx_review_cases_repo   ON review_cases(repo_path, created_at DESC);

CREATE TABLE IF NOT EXISTS review_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_case_id TEXT NOT NULL REFERENCES review_cases(id) ON DELETE CASCADE,
  finding_id TEXT NOT NULL,
  outcome_type TEXT NOT NULL
    CHECK(outcome_type IN ('adopted', 'ignored', 'dismissed', 'resolved', 'pending')),
  followup_commit_hash TEXT,
  resolution_timestamp TIMESTAMPTZ,
  guidance_ids JSONB DEFAULT '[]',
  false_positive BOOLEAN DEFAULT FALSE,
  notes TEXT,
  auto_detected BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ,
  UNIQUE (review_case_id, finding_id)
);

CREATE INDEX IF NOT EXISTS idx_review_outcomes_case    ON review_outcomes(review_case_id);
CREATE INDEX IF NOT EXISTS idx_review_outcomes_outcome ON review_outcomes(outcome_type);
CREATE INDEX IF NOT EXISTS idx_review_outcomes_fp      ON review_outcomes(false_positive)
  WHERE false_positive = TRUE;
```

### Drizzle スキーマ追加（`src/db/schema.ts`）

```typescript
export const reviewCases = pgTable('review_cases', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  repoPath: text('repo_path').notNull(),
  baseRef: text('base_ref'),
  headRef: text('head_ref'),
  taskGoal: text('task_goal'),
  trigger: text('trigger').notNull(),
  status: text('status').notNull().default('running'),
  riskLevel: text('risk_level'),
  reviewStatus: text('review_status'),
  summary: text('summary'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, table => ({
  taskIdx: index('idx_review_cases_task').on(table.taskId),
  statusIdx: index('idx_review_cases_status').on(table.status),
}));

export const reviewOutcomes = pgTable('review_outcomes', {
  id: uuid('id').primaryKey().defaultRandom(),
  reviewCaseId: text('review_case_id')
    .references(() => reviewCases.id, { onDelete: 'cascade' })
    .notNull(),
  findingId: text('finding_id').notNull(),
  outcomeType: text('outcome_type').notNull(),
  followupCommitHash: text('followup_commit_hash'),
  resolutionTimestamp: timestamp('resolution_timestamp', { withTimezone: true }),
  guidanceIds: jsonb('guidance_ids').default([]),
  falsePositive: boolean('false_positive').default(false),
  notes: text('notes'),
  autoDetected: boolean('auto_detected').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
}, table => ({
  caseIdx: index('idx_review_outcomes_case').on(table.reviewCaseId),
  outcomeIdx: index('idx_review_outcomes_outcome').on(table.outcomeType),
  uniqueReviewFinding: unique().on(table.reviewCaseId, table.findingId),
}));
```

---

## 2. Guidance seed データ

Stage C 開始時に投入する。`applicability` は **metadata の構造化フィールド** として保存する（content 文字列への埋め込み不可、共通基盤 Section 3 `GuidanceItem` 参照）。

```typescript
// src/scripts/review/seedGuidance.ts
import { saveGuidance } from '../../services/guidance/register.js';

interface SeedEntry {
  title: string;
  content: string;
  tags: string[];
  priority: number;
  knowledgeType: 'principle' | 'heuristic' | 'pattern';
  applicability: {
    signals?: string[];
    fileTypes?: string[];
  };
}

export const SEED_PRINCIPLES: SeedEntry[] = [
  {
    title: '外部I/Oは失敗時挙動を確認',
    content: 'ネットワーク/ファイル/DBなど外部リソースへのアクセスは必ず失敗ケースを考慮する。チェック: try-catch有無 / タイムアウト設定 / リトライロジック / エラーメッセージの充実度',
    tags: ['principle', 'external-io', 'error-handling'],
    priority: 85,
    knowledgeType: 'principle',
    applicability: { signals: ['external_api_error', 'database', 'file_io'] },
  },
  {
    title: 'セキュリティ境界は入力から出力まで一貫して検証',
    content: 'ユーザー入力は受け取った場所でvalidateし、DBに入れる前・外部に返す前の全ポイントで検証する。',
    tags: ['principle', 'security', 'validation'],
    priority: 90,
    knowledgeType: 'principle',
    applicability: { signals: ['auth', 'input_validation', 'external_api_error'] },
  },
  {
    title: '状態変更は原子性を持たせる',
    content: '複数の状態を変える処理は全成功か全失敗かを保証する。部分的成功は最も危険な状態。',
    tags: ['principle', 'atomicity', 'transaction'],
    priority: 80,
    knowledgeType: 'principle',
    applicability: { signals: ['transaction', 'db_schema_change', 'deletion'] },
  },
  {
    title: '非同期処理のエラーハンドリングは同期より重要',
    content: 'async/awaitでもPromise.allでも、失敗時のロールバック・クリーンアップを必ず実装する。',
    tags: ['principle', 'async', 'error-handling'],
    priority: 75,
    knowledgeType: 'principle',
    applicability: { signals: ['concurrency'] },
  },
  {
    title: 'キャッシュの一貫性は楽観視しない',
    content: 'キャッシュ導入・無効化の変更は、staleデータのリスクを常に考慮する。',
    tags: ['principle', 'cache', 'consistency'],
    priority: 70,
    knowledgeType: 'principle',
    applicability: { signals: ['cache_invalidation'] },
  },
];

export const SEED_HEURISTICS: SeedEntry[] = [
  {
    title: 'config変更は見た目より事故率が高い',
    content: '設定ファイル変更の23%で本番事故。確認: 環境変数追加は.env.exampleに反映済みか / デフォルト値は安全か / 型チェックがあるか',
    tags: ['heuristic', 'config', 'ops'],
    priority: 75,
    knowledgeType: 'heuristic',
    applicability: { fileTypes: ['config'], signals: ['config_changed'] },
  },
  {
    title: 'エラーレスポンスは内部情報を漏洩させやすい',
    content: '例外メッセージやスタックトレースを直接クライアントに返すコードは要注意。',
    tags: ['heuristic', 'security', 'error-handling'],
    priority: 70,
    knowledgeType: 'heuristic',
    applicability: { signals: ['external_api_error', 'auth'] },
  },
  {
    title: 'テストのないロジック変更は後退リスクが高い',
    content: 'ビジネスロジックの変更にテスト追加がない場合は必ず指摘する。',
    tags: ['heuristic', 'testing'],
    priority: 65,
    knowledgeType: 'heuristic',
    applicability: { signals: ['tests_absent'] },
  },
  {
    title: 'N+1クエリは機能テストで検出されにくい',
    content: 'ループ内でDBアクセスするパターンは、小データセットのテストでは発覚しない。',
    tags: ['heuristic', 'performance', 'database'],
    priority: 65,
    knowledgeType: 'heuristic',
    applicability: { signals: ['database'] },
  },
  {
    title: '認証と認可は混同されやすい',
    content: '認証（誰か）と認可（何ができるか）は別レイヤーで管理する。変更時に両方確認する。',
    tags: ['heuristic', 'security', 'auth'],
    priority: 80,
    knowledgeType: 'heuristic',
    applicability: { signals: ['auth', 'permission'] },
  },
];

export const SEED_PATTERNS: SeedEntry[] = [
  {
    title: 'migration不足（再発率67%）',
    content: 'DBスキーマ変更時にmigrationファイルが含まれていない。検出: schema.ts変更 + migrations/配下にファイルなし',
    tags: ['pattern', 'migration', 'database'],
    priority: 80,
    knowledgeType: 'pattern',
    applicability: { signals: ['db_schema_change', 'migration'] },
  },
  {
    title: 'Promise未処理',
    content: 'async関数の戻り値をawaitせずに破棄しているパターン。エラーが握りつぶされる。',
    tags: ['pattern', 'async', 'bug'],
    priority: 75,
    knowledgeType: 'pattern',
    applicability: { signals: ['concurrency'] },
  },
  {
    title: 'エラー型の握りつぶし（catch(e) {}）',
    content: 'catch節で何もしない・ただconsole.logするだけのパターン。本番で問題が無音で起きる。',
    tags: ['pattern', 'error-handling', 'bug'],
    priority: 70,
    knowledgeType: 'pattern',
    applicability: { signals: ['external_api_error', 'database', 'file_io'] },
  },
  {
    title: '環境変数のデフォルト値がnull',
    content: 'process.env.FOO ?? null のようにnullがデフォルトで後続処理がクラッシュするパターン。',
    tags: ['pattern', 'config', 'bug'],
    priority: 65,
    knowledgeType: 'pattern',
    applicability: { signals: ['config_changed'] },
  },
];

// --- 登録スクリプト ---
export async function seedGuidance(): Promise<void> {
  const allSeeds = [
    ...SEED_PRINCIPLES.map(s => ({ ...s, scope: 'always' as const })),
    ...SEED_HEURISTICS.map(s => ({ ...s, scope: 'on_demand' as const })),
    ...SEED_PATTERNS.map(s => ({ ...s, scope: 'on_demand' as const })),
  ];

  for (const seed of allSeeds) {
    await saveGuidance({
      title: seed.title,
      content: seed.content,
      guidanceType: 'rule',
      scope: seed.scope,
      priority: seed.priority,
      tags: seed.tags,
      // applicability は metadata に構造化保存される
      // saveGuidance の metadata に追加するよう実装時に拡張する
    });
  }

  console.log(`Seeded ${allSeeds.length} guidance entries`);
}
```

> **実装注意**: 現在の `saveGuidance()` は metadata に `applicability` フィールドを持たない。
> Stage C 実装時に `saveGuidance` の input に `applicability?: GuidanceItem['applicability']` を追加し、
> `metadata` 内に格納するよう拡張する。

---

## 3. Knowledge Retrieval

`src/services/review/knowledge/` に実装する。

### 3-1. Guidance 検索スコアリング

```typescript
// src/services/review/knowledge/retriever.ts
import { getAlwaysOnGuidance, getOnDemandGuidance } from '../../../services/guidance/search.js';

interface RetrievalScore {
  semanticSimilarity: number;     // 0-1 (embedding 類似度)
  signalMatch: number;            // 0-1 (riskSignal の一致率)
  tagMatch: number;               // 0-1 (language/framework タグ一致)
  falsePositivePenalty: number;   // -0.2 per FP
}

export function calculateScore(score: RetrievalScore): number {
  let final = score.semanticSimilarity * 0.5;
  final += score.signalMatch * 0.3;
  final += score.tagMatch * 0.2;
  final += score.falsePositivePenalty;
  return Math.max(0, Math.min(1, final));
}

export async function retrieveGuidance(
  projectKey: string,
  riskSignals: string[],
  language: string,
  framework?: string,
): Promise<{
  principles: GuidanceItem[];
  heuristics: GuidanceItem[];
  patterns: GuidanceItem[];
  skills: GuidanceItem[];
}> {
  const signalQuery = riskSignals.join(' ');

  // 既存 API を使用
  const [alwaysOn, onDemand] = await Promise.all([
    getAlwaysOnGuidance().catch(() => []),
    getOnDemandGuidance(
      `${signalQuery} ${language} ${framework ?? ''}`.trim(),
    ).catch(() => []),
  ]);

  const allGuidance = [...alwaysOn, ...onDemand];

  // 誤検知ペナルティ計算
  const fpCounts = await getFalsePositiveCounts(
    allGuidance.map(g => (g.metadata as any)?.archiveKey).filter(Boolean),
  );

  const scored = allGuidance
    .map(g => {
      const meta = g.metadata as Record<string, any>;
      const tags: string[] = meta?.tags ?? [];
      const applicability = meta?.applicability as GuidanceItem['applicability'];

      return {
        guidance: toGuidanceItem(g),
        score: calculateScore({
          semanticSimilarity: (g as any).similarity ?? 0.5,
          signalMatch: applicability?.signals
            ? applicability.signals.filter(s => riskSignals.includes(s)).length / Math.max(riskSignals.length, 1)
            : 0,
          tagMatch: (tags.includes(language) ? 0.5 : 0) + (framework && tags.includes(framework) ? 0.5 : 0),
          falsePositivePenalty: -(fpCounts[(meta as any)?.archiveKey] ?? 0) * 0.2,
        }),
      };
    })
    .sort((a, b) => b.score - a.score)
    .filter(({ score }) => score > 0.3);

  // タイプ別に分類（tags で判別）
  const classify = (type: string, limit: number) =>
    scored.filter(s => s.guidance.tags.includes(type)).slice(0, limit).map(s => s.guidance);

  return {
    principles: classify('principle', 5),
    heuristics: classify('heuristic', 5),
    patterns: classify('pattern', 5),
    skills: classify('skill', 3),
  };
}

async function getFalsePositiveCounts(guidanceIds: string[]): Promise<Record<string, number>> {
  if (!guidanceIds.length) return {};

  const result = await db.execute(sql`
    SELECT
      guidance_id,
      COUNT(*) AS fp_count
    FROM review_outcomes,
    LATERAL jsonb_array_elements_text(guidance_ids) AS guidance_id
    WHERE false_positive = TRUE
      AND guidance_id = ANY(${guidanceIds})
    GROUP BY guidance_id
  `);

  return Object.fromEntries(result.rows.map(r => [r.guidance_id, Number(r.fp_count)]));
}
```

### 3-2. 過去 finding 検索

```typescript
// src/services/review/knowledge/retriever.ts (同ファイル)
import { searchMemory } from '../../../services/memory.js';

export async function searchSimilarFindings(
  projectKey: string,
  riskSignals: string[],
  language: string,
): Promise<string[]> {
  const memories = await searchMemory(
    `code-review-${projectKey}`,
    `${riskSignals.join(' ')} ${language}`,
    5,
  );

  return memories.map(m =>
    `過去の類似指摘: [${(m.metadata as any)?.category}] ${m.content.slice(0, 200)}`,
  );
}
```

### 3-3. 不適用 Guidance のフィルタリング

`applicability` は metadata 内の構造化フィールド（共通基盤 Section 3 `GuidanceItem.applicability`）を参照する。

```typescript
export function filterInapplicableGuidance(
  guidanceList: GuidanceItem[],
  context: { language: string; framework?: string; riskSignals: string[] },
): GuidanceItem[] {
  return guidanceList.filter(g => {
    if (!g.applicability) return true;  // applicability 未定義なら適用

    // excludedFrameworks チェック
    if (g.applicability.excludedFrameworks?.includes(context.framework ?? '')) {
      return false;
    }

    // signals チェック: on_demand なら signals マッチが必須
    if (g.applicability.signals?.length && g.scope === 'on_demand') {
      const hasMatch = g.applicability.signals.some(s => context.riskSignals.includes(s));
      if (!hasMatch) return false;
    }

    return true;
  });
}
```

---

## 4. プロンプト V3

```typescript
// src/services/review/llm/promptBuilder.ts

export function buildReviewPromptV3(context: ReviewContextV3): string {
  const sections: string[] = [];

  // 静的解析
  if (context.staticAnalysisFindings.length > 0) {
    sections.push(`## 静的解析結果（必ず参照すること）\n\n${
      context.staticAnalysisFindings
        .map(f => `- [${f.tool}] ${f.file_path}:${f.line} — ${f.message}`)
        .join('\n')
    }`);
  }

  // Principles
  if (context.recalledPrinciples.length > 0) {
    sections.push(`## 適用すべき原則 (Principles) — 最優先\n\n${
      context.recalledPrinciples.map((p, i) => `### ${i + 1}. ${p.title}\n${p.content}`).join('\n\n')
    }`);
  }

  // Heuristics
  if (context.recalledHeuristics.length > 0) {
    sections.push(`## 経験則 (Heuristics)\n\n${
      context.recalledHeuristics.map(h => `- **${h.title}**: ${h.content.split('\n')[0]}`).join('\n')
    }`);
  }

  // Patterns
  if (context.recalledPatterns.length > 0) {
    sections.push(`## 再発パターン (Patterns)\n\n${
      context.recalledPatterns.map(p => `- **${p.title}**: ${p.content.split('\n')[0]}`).join('\n')
    }`);
  }

  // 過去の類似指摘
  if (context.pastSimilarFindings.length > 0) {
    sections.push(`## 過去の類似指摘\n\n${context.pastSimilarFindings.join('\n')}`);
  }

  return `# Code Review Instructions

あなたは経験豊富なコードレビュアーです。以下のコンテキストを **優先順位通り** に使用してください。

## 優先順位

1. 静的解析結果（ツールが検出した事実）
2. 適用すべき原則（Principles）
3. 経験則・再発パターン（Heuristics / Patterns）
4. 差分の事実ベース分析
5. 過去の類似指摘（参考程度）

---

${sections.join('\n\n---\n\n')}

---

## レビュー必須ルール

1. 根拠のない指摘は返さない — evidence に diff の引用を含めること
2. 新行番号 line_new は必須 — 削除行への指摘は不可
3. 不確実なものは severity: "info", confidence: "low" にする
4. 「問題なし」とは言わない — findings が空なら空配列で返す
5. 適用した Guidance の title を knowledge_refs に含める

## Git Diff

\`\`\`diff
${context.rawDiff}
\`\`\`

[出力は共通基盤の ReviewOutput JSON スキーマに従うこと]`;
}
```

---

## 5. 永続化

### 5-1. レビュー結果保存

```typescript
// src/services/review/knowledge/persister.ts
import { saveExperience } from '../../../services/experience.js';
import { saveMemory } from '../../../services/memory.js';

export async function persistReviewCase(
  req: ReviewRequest,
  result: ReviewOutput,
): Promise<void> {
  const projectKey = getProjectKey(req.repoPath);

  // 1. review_cases に保存
  await db.insert(reviewCases).values({
    id: result.review_id,
    taskId: req.taskId,
    repoPath: req.repoPath,
    baseRef: req.baseRef,
    headRef: req.headRef,
    taskGoal: req.taskGoal,
    trigger: req.trigger,
    status: 'completed',
    riskLevel: result.metadata.risk_level,
    reviewStatus: result.review_status,
    summary: result.summary,
    completedAt: new Date(),
  }).onConflictDoUpdate({
    target: reviewCases.id,
    set: { status: 'completed', completedAt: new Date() },
  });

  // 2. experience_logs に実行ログ保存
  await saveExperience({
    sessionId: `code-review-${projectKey}`,
    scenarioId: result.review_id,
    attempt: 1,
    type: result.review_status === 'changes_requested' ? 'failure' : 'success',
    failureType: result.review_status === 'changes_requested' ? 'REVIEW_BLOCKING' : undefined,
    content: result.summary,
    metadata: {
      findingsCount: result.findings.length,
      riskLevel: result.metadata.risk_level,
      guidanceApplied: result.metadata.knowledge_applied,
      degradedModes: result.metadata.degraded_reasons,
      reviewDurationMs: result.metadata.review_duration_ms,
    },
  });

  // 3. finding を vibe_memories に保存（類似 finding 検索用）
  for (const finding of result.findings) {
    await saveMemory(
      `code-review-${projectKey}`,
      `[${finding.severity}:${finding.category}] ${finding.title}: ${finding.rationale}`,
      {
        reviewCaseId: result.review_id,
        filePath: finding.file_path,
        category: finding.category,
        guidanceRefs: finding.knowledge_refs ?? [],
        fingerprint: finding.fingerprint,
      },
    );
  }

  // 4. finding → Guidance 関係を KG に記録
  for (const finding of result.findings) {
    if (!finding.knowledge_refs?.length) continue;

    await saveMemory(
      'code-review-kg',
      `Finding "${finding.title}" (${finding.category}) was guided by: ${finding.knowledge_refs.join(', ')}`,
      {
        entities: [
          { id: `finding:${finding.fingerprint}`, type: 'finding', name: finding.title },
          ...finding.knowledge_refs.map(ref => ({ id: `guidance:${ref}`, type: 'guidance', name: ref })),
        ],
        relations: finding.knowledge_refs.map(ref => ({
          sourceId: `finding:${finding.fingerprint}`,
          targetId: `guidance:${ref}`,
          relationType: 'derived_from',
        })),
      },
    );
  }
}
```

### 5-2. フィードバック収集

```typescript
// finding の採用・却下を記録
export async function recordFeedback(
  reviewCaseId: string,
  findingId: string,
  outcomeType: 'adopted' | 'ignored' | 'dismissed' | 'resolved',
  options: { notes?: string; falsePositive?: boolean; guidanceIds?: string[] } = {},
): Promise<void> {
  await db.insert(reviewOutcomes).values({
    reviewCaseId,
    findingId,
    outcomeType,
    falsePositive: options.falsePositive ?? false,
    notes: options.notes,
    guidanceIds: options.guidanceIds ?? [],
    autoDetected: false,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: [reviewOutcomes.reviewCaseId, reviewOutcomes.findingId],
    set: { outcomeType, updatedAt: new Date() },
  });
}
```

### 5-3. 後続コミットからの自動フィードバック検出

```typescript
import { simpleGit } from 'simple-git';

export async function detectFeedbackFromCommit(
  reviewCaseId: string,
  commitHash: string,
  repoPath: string,
): Promise<void> {
  const git = simpleGit(repoPath);
  const commitDiff = await git.diff([`${commitHash}^`, commitHash]);
  const commitFiles = normalizeDiff(commitDiff);

  const pendingOutcomes = await db.select()
    .from(reviewOutcomes)
    .where(
      and(
        eq(reviewOutcomes.reviewCaseId, reviewCaseId),
        eq(reviewOutcomes.outcomeType, 'pending'),
      ),
    );

  for (const outcome of pendingOutcomes) {
    const finding = await getFindingById(reviewCaseId, outcome.findingId);
    if (!finding) continue;

    const wasAddressed = commitFiles.some(f =>
      f.filePath === finding.file_path &&
      f.hunks.some(h =>
        finding.line_new >= h.newStart &&
        finding.line_new < h.newStart + h.newLines,
      ),
    );

    if (wasAddressed) {
      await db.update(reviewOutcomes)
        .set({
          outcomeType: 'adopted',
          followupCommitHash: commitHash,
          resolutionTimestamp: new Date(),
          autoDetected: true,
          updatedAt: new Date(),
        })
        .where(eq(reviewOutcomes.id, outcome.id));
    }
  }
}
```

---

## 6. オーケストレーター

```typescript
// src/services/review/orchestrator.ts (Stage C 版)

export async function runReviewStageC(req: ReviewRequest): Promise<ReviewOutput> {
  const startTime = Date.now();
  const degradedModes: DegradedMode[] = [];
  const projectKey = getProjectKey(req.repoPath);

  // --- Stage A+B と共通 ---
  validateAllowedRoot(req.repoPath);
  validateSessionId(req.sessionId);
  const rawDiff = await getDiff(req.repoPath, req.mode);
  if (!rawDiff.trim()) return buildEmptyResult('no_changes', startTime);
  enforceHardLimit(rawDiff);
  const maskedDiff = maskOrThrow(rawDiff, true);
  const diffs = normalizeDiff(maskedDiff);

  // DiffGuard + Astmend + 静的解析（Stage B から継承）
  const diffGuardFindings = await runDiffGuard(maskedDiff, req.repoPath);
  const changedSymbols = extractChangedSymbols(diffs);
  const impactAnalysis = await analyzeImpactWithAstmend(changedSymbols, req.repoPath);
  if (impactAnalysis.degraded) degradedModes.push(DegradedMode.ASTMEND_UNAVAILABLE);

  const { findings: staticFindings, degraded: staticDegraded } =
    await runStaticAnalysisOnChanged(diffs, req.repoPath);
  if (staticDegraded) degradedModes.push(DegradedMode.STATIC_ANALYSIS_UNAVAILABLE);

  const baseSignals = extractRiskSignals(diffs);
  const riskSignals = enrichRiskSignalsWithImpact(baseSignals, impactAnalysis);
  const plan = planReview(riskSignals);

  // --- Stage C 追加: Knowledge Retrieval ---
  const language = detectPrimaryLanguage(diffs);
  const framework = detectFramework(req.repoPath);
  let knowledge = { principles: [] as GuidanceItem[], heuristics: [] as GuidanceItem[], patterns: [] as GuidanceItem[], skills: [] as GuidanceItem[] };
  let pastFindings: string[] = [];

  try {
    knowledge = await retrieveGuidance(projectKey, riskSignals, language, framework);
    knowledge = {
      principles: filterInapplicableGuidance(knowledge.principles, { language, framework, riskSignals }),
      heuristics: filterInapplicableGuidance(knowledge.heuristics, { language, framework, riskSignals }),
      patterns:   filterInapplicableGuidance(knowledge.patterns,   { language, framework, riskSignals }),
      skills:     filterInapplicableGuidance(knowledge.skills,     { language, framework, riskSignals }),
    };
    pastFindings = await searchSimilarFindings(projectKey, riskSignals, language);
  } catch (err) {
    console.warn(`Knowledge retrieval failed: ${err}`);
    degradedModes.push(DegradedMode.KNOWLEDGE_RETRIEVAL_FAILED);
  }

  // LLM レビュー（プロンプト V3）
  const allStaticFindings = [...diffGuardFindings, ...staticFindings];
  const llmService = await getReviewLLMService(plan.useHeavyLLM ? 'cloud' : 'local');
  const { findings: llmFindings, summary, next_actions } = await reviewWithLLM(
    {
      instruction: '',
      projectInfo: { language, framework },
      rawDiff: maskedDiff,
      diffSummary: {
        filesChanged: diffs.length,
        linesAdded: countAddedLines(diffs),
        linesRemoved: countRemovedLines(diffs),
        riskSignals,
      },
      selectedHunks: diffs,
      staticAnalysisFindings: allStaticFindings,
      impactAnalysis,
      recalledPrinciples: knowledge.principles,
      recalledHeuristics: knowledge.heuristics,
      recalledPatterns: knowledge.patterns,
      optionalSkills: knowledge.skills,
      pastSimilarFindings: pastFindings,
      outputSchema: REVIEW_OUTPUT_SCHEMA,
    },
    llmService,
  );

  const validatedFindings = validateFindingsFull(llmFindings, diffs);
  const merged = deduplicateFindings(mergeFindings(allStaticFindings, validatedFindings));
  const guidanceApplied = [...new Set(merged.flatMap(f => f.knowledge_refs ?? []))];

  const result: ReviewOutput = {
    review_id: crypto.randomUUID(),
    task_id: req.taskId,
    review_status: deriveReviewStatus(merged),
    findings: merged,
    summary,
    next_actions,
    rerun_review: merged.some(f => f.severity === 'error'),
    metadata: {
      reviewed_files: diffs.length,
      risk_level: plan.riskLevel,
      static_analysis_used: allStaticFindings.length > 0,
      knowledge_applied: guidanceApplied,
      degraded_mode: degradedModes.length > 0,
      degraded_reasons: degradedModes,
      local_llm_used: llmService.provider === 'local',
      heavy_llm_used: llmService.provider === 'cloud',
      review_duration_ms: Date.now() - startTime,
    },
    markdown: '',
  };
  result.markdown = renderReviewMarkdown(result);

  // --- Stage C 追加: 永続化 ---
  await persistReviewCase(req, result).catch(err =>
    console.warn(`Persistence failed (non-fatal): ${err}`),
  );

  return result;
}
```

---

## 7. チェックリスト

### DB マイグレーション

- [ ] `drizzle/0009_code_review_cases.sql` 作成・適用
- [ ] `src/db/schema.ts` に `reviewCases` / `reviewOutcomes` 追加
- [ ] `saveGuidance()` に `applicability` フィールドを追加（metadata 内）

### Guidance seed

- [ ] `seedGuidance.ts` 実装
- [ ] Principle ×5 + Heuristic ×5 + Pattern ×4 を投入
- [ ] `getOnDemandGuidance` で検索して取得できることを確認

### Knowledge Retrieval

- [ ] `retrieveGuidance` — `getAlwaysOnGuidance` + `getOnDemandGuidance` の組み合わせ
- [ ] `calculateScore` — スコアリングのユニットテスト
- [ ] `filterInapplicableGuidance` — signals マッチ / excludedFrameworks
- [ ] `searchSimilarFindings` — `searchMemory` のラッパー
- [ ] `getFalsePositiveCounts` — SQL 集計

### 永続化

- [ ] `persistReviewCase` — review_cases + experience_logs + vibe_memories + KG
- [ ] `recordFeedback` — 手動フィードバック
- [ ] `detectFeedbackFromCommit` — 後続コミットからの自動検出

### E2E 検証

- [ ] `gnosis review run` で `knowledge_applied` に Guidance が含まれる
- [ ] `vibe_memories` に finding が保存される
- [ ] 2 回目以降のレビューで `pastSimilarFindings` が注入される
