# Gnosis Code Review — Stage D: 進化するレビュアー

**前提**: [共通基盤](./code-review-foundation.md) / [Stage A〜C](./code-review-stage-c.md) が完成していること  
**依存 Stage**: Stage C（`review_outcomes` にフィードバックデータが蓄積していること）  
**完成の定義**: Guidance が使用データから自動昇格され、KPI ダッシュボードで計測できること

---

## 目標

```
review_outcomes + experience_logs → Guidance 候補抽出 → 承認 → active 昇格
                                 → KPI 計測 → ダッシュボード
findings + Astmend.apply_patch    → 安全な修正候補生成 → レビュー結果に添付
```

- 繰り返し採用された finding から新しい Pattern/Heuristic を自動候補化
- Astmend MCP で AST ベースの安全な修正候補を自動生成
- 誤検知率・採用率などの KPI を `review_outcomes` の集計クエリで算出
- 知識の品質管理（誤検知が多い Guidance の priority 自動降格）

> ⚠️ **前提データ量**: Stage C で最低 **50 件以上のレビュー実行 + フィードバック記録** が溜まっていないと候補抽出が機能しない。

---

## 目次

1. [Knowledge Evolution（自動知識生成）](#1-knowledge-evolution自動知識生成)
2. [Astmend 修正候補生成](#2-astmend-修正候補生成)
3. [KPI 計測](#3-kpi-計測)
4. [KPI ダッシュボード](#4-kpi-ダッシュボード)
5. [昇格・降格条件](#5-昇格降格条件)
6. [CLI コマンド](#6-cli-コマンド)
7. [リスクと対策](#7-リスクと対策)
8. [チェックリスト](#8-チェックリスト)

---

## 1. Knowledge Evolution（自動知識生成）

### 1-1. Pattern 候補抽出

`review_outcomes` + `vibe_memories` から繰り返し採用された finding の共通構造を検出する。

```typescript
// src/services/review/knowledge/evolution.ts

interface GuidanceCandidate {
  type: 'pattern' | 'heuristic';
  title: string;
  content: string;
  tags: string[];
  evidenceReviewIds: string[];
  supportCount: number;
  adoptionRate: number;
}

export async function extractPatternCandidates(): Promise<GuidanceCandidate[]> {
  // 同一カテゴリ + ファイルパターンで 3 件以上採用された finding を抽出
  const recurring = await db.execute(sql`
    SELECT
      vm.metadata->>'category'             AS category,
      vm.metadata->>'filePath'             AS file_pattern,
      COUNT(*)                             AS total_count,
      SUM(CASE WHEN ro.outcome_type = 'adopted' THEN 1 ELSE 0 END) AS adopted_count,
      ARRAY_AGG(DISTINCT ro.review_case_id) AS review_ids,
      (
        SELECT jsonb_agg(DISTINCT guidance_id)
        FROM review_outcomes ro2
        CROSS JOIN LATERAL jsonb_array_elements_text(ro2.guidance_ids) AS guidance_id
        WHERE ro2.review_case_id = ANY(ARRAY_AGG(ro.review_case_id))
      ) AS common_guidance_ids
    FROM review_outcomes ro
    JOIN vibe_memories vm
      ON vm.metadata->>'reviewCaseId' = ro.review_case_id
      AND vm.dedupe_key IS NOT NULL
    WHERE ro.outcome_type IN ('adopted', 'ignored', 'dismissed')
    GROUP BY vm.metadata->>'category', vm.metadata->>'filePath'
    HAVING COUNT(*) >= 3
      AND SUM(CASE WHEN ro.outcome_type = 'adopted' THEN 1 ELSE 0 END)::float / COUNT(*) >= 0.6
    ORDER BY adopted_count DESC
    LIMIT 20
  `);

  return recurring.rows.map(row => ({
    type: 'pattern' as const,
    title: `[候補] 繰り返し採用: ${row.category} (${row.file_pattern ?? '任意ファイル'})`,
    content: `採用率: ${(row.adopted_count / row.total_count * 100).toFixed(0)}% (${row.adopted_count}/${row.total_count}件)\n関連Guidance: ${row.common_guidance_ids?.join(', ') ?? 'なし'}`,
    tags: ['pattern', row.category],
    evidenceReviewIds: row.review_ids,
    supportCount: row.total_count,
    adoptionRate: row.adopted_count / row.total_count,
  }));
}
```

### 1-2. LLM 支援候補精製

自動抽出した候補を LLM で整形・タイトル付け・applicability 定義する。

```typescript
export async function refineCandidateWithLLM(
  candidate: GuidanceCandidate,
  sampleFindings: string[],
  llmService: ReviewLLMService,
): Promise<{ title: string; content: string; tags: string[]; priority: number; applicability: GuidanceItem['applicability'] }> {
  const prompt = `以下のコードレビューパターン候補を、Guidance として登録可能な形式に整形してください。

## 候補情報
- カテゴリ: ${candidate.tags.join(', ')}
- 採用率: ${(candidate.adoptionRate * 100).toFixed(0)}%
- 件数: ${candidate.supportCount}件

## 代表的な finding サンプル（最大5件）
${sampleFindings.slice(0, 5).join('\n')}

## 出力形式（JSON）
{
  "title": "簡潔で具体的なタイトル（20文字以内）",
  "content": "説明文",
  "tags": ["pattern", ...関連タグ],
  "priority": 50-90の整数,
  "applicability": { "signals": [...], "fileTypes": [...] }
}`;

  const raw = await llmService.generate(prompt, { format: 'json' });
  return JSON.parse(raw);
}
```

### 1-3. 自動昇格

```typescript
interface PromotionCriteria {
  minSupportCount: number;
  maxFalsePositiveRate: number;
  minAdoptionRate: number;
}

const PROMOTION_CRITERIA: Record<string, PromotionCriteria> = {
  pattern:   { minSupportCount: 5,  maxFalsePositiveRate: 0.10, minAdoptionRate: 0.60 },
  heuristic: { minSupportCount: 10, maxFalsePositiveRate: 0.20, minAdoptionRate: 0.50 },
  // Principle は手動作成のみ（自動昇格なし）
};

export async function runAutoPromotion(): Promise<{ promoted: string[]; degraded: string[] }> {
  const candidates = await extractPatternCandidates();
  const promoted: string[] = [];
  const degraded: string[] = [];

  for (const candidate of candidates) {
    const criteria = PROMOTION_CRITERIA[candidate.type];
    if (!criteria) continue;

    const shouldPromote =
      candidate.supportCount >= criteria.minSupportCount &&
      (1 - candidate.adoptionRate) <= criteria.maxFalsePositiveRate &&
      candidate.adoptionRate >= criteria.minAdoptionRate;

    if (shouldPromote) {
      // LLM で整形してから Guidance に登録
      const sampleFindings = await getSampleFindings(candidate.evidenceReviewIds);
      const llmService = await getReviewLLMService('cloud');
      const refined = await refineCandidateWithLLM(candidate, sampleFindings, llmService);

      await saveGuidance({
        title: refined.title,
        content: refined.content,
        guidanceType: 'rule',
        scope: 'on_demand',
        priority: refined.priority,
        tags: refined.tags,
      });
      promoted.push(refined.title);
    }
  }

  // 誤検知が多い active Guidance の priority を降格
  const activeGuidance = await getAlwaysOnGuidance();
  const onDemandGuidance = await getOnDemandGuidance('', 100);
  for (const g of [...activeGuidance, ...onDemandGuidance]) {
    const meta = g.metadata as Record<string, any>;
    const guidanceId = meta?.archiveKey;
    if (!guidanceId) continue;

    const metrics = await getGuidanceMetrics(guidanceId);
    if (metrics.falsePositiveRate > 0.30 && metrics.supportCount > 5) {
      // priority を 20 下げる（saveGuidance で上書き）
      const newPriority = Math.max(0, (meta?.priority ?? 50) - 20);
      await saveGuidance({
        title: meta?.title ?? 'Unknown',
        content: g.content,
        guidanceType: meta?.guidanceType ?? 'rule',
        scope: meta?.scope ?? 'on_demand',
        priority: newPriority,
        tags: meta?.tags ?? [],
        archiveKey: guidanceId,
      });
      degraded.push(meta?.title ?? guidanceId);
    }
  }

  return { promoted, degraded };
}
```

### 1-4. Guidance メトリクス計算

新規テーブル不要。`review_outcomes` の集計クエリで算出する。

```typescript
interface GuidanceMetrics {
  guidanceId: string;
  supportCount: number;
  adoptedCount: number;
  falsePositiveCount: number;
  adoptionRate: number;
  falsePositiveRate: number;
  lastAppliedAt: Date | null;
}

export async function getGuidanceMetrics(guidanceId: string): Promise<GuidanceMetrics> {
  const result = await db.execute(sql`
    SELECT
      COUNT(*) AS support_count,
      SUM(CASE WHEN outcome_type = 'adopted' THEN 1 ELSE 0 END) AS adopted_count,
      SUM(CASE WHEN false_positive = TRUE THEN 1 ELSE 0 END) AS fp_count,
      MAX(created_at) AS last_applied_at
    FROM review_outcomes
    WHERE guidance_ids @> ${JSON.stringify([guidanceId])}::jsonb
      AND outcome_type != 'pending'
  `);

  const row = result.rows[0];
  const supportCount = Number(row.support_count) || 0;
  const adoptedCount = Number(row.adopted_count) || 0;
  const fpCount = Number(row.fp_count) || 0;

  return {
    guidanceId,
    supportCount,
    adoptedCount,
    falsePositiveCount: fpCount,
    adoptionRate: supportCount > 0 ? adoptedCount / supportCount : 0,
    falsePositiveRate: supportCount > 0 ? fpCount / supportCount : 0,
    lastAppliedAt: row.last_applied_at,
  };
}
```

---

## 2. Astmend 修正候補生成

レビューで検出された finding に対して、Astmend MCP の `apply_patch_to_text` を使い **構文を壊さない修正候補** を自動生成する。

> Astmend はファイルを書き換えない。diff と updatedText を返すのみで、適用判断は人間が行う。

### 2-1. 修正可能な finding の判定

すべての finding に修正候補を生成するわけではない。以下の条件を満たすものだけ対象とする。

```typescript
// src/services/review/knowledge/fixSuggester.ts

interface FixSuggestion {
  findingId: string;
  operation: Record<string, unknown>;  // Astmend PatchOperation
  diff: string;
  updatedText: string;
  confidence: 'high' | 'medium';
}

const FIXABLE_CATEGORIES = new Set([
  'unused-import',        // DG003: remove_import
  'missing-import',       // add_import
  'missing-parameter',    // update_function: add_param
  'interface-property',   // update_interface: add_property
]);

export function isFixable(finding: Finding): boolean {
  return (
    FIXABLE_CATEGORIES.has(finding.category) &&
    finding.confidence !== 'low' &&
    finding.file_path !== undefined
  );
}
```

### 2-2. Astmend パッチ生成

```typescript
export async function generateFixSuggestion(
  finding: Finding,
  projectRoot: string,
): Promise<FixSuggestion | null> {
  const operation = buildPatchOperation(finding);
  if (!operation) return null;

  const filePath = path.join(projectRoot, finding.file_path);

  try {
    // ファイル内容を読み込んで apply_patch_to_text で検証
    const sourceText = await Bun.file(filePath).text();

    const result = await mcpClient.call('mcp_astmend_apply_patch_to_text', {
      operation,
      sourceText,
    });

    if (!result.success) {
      // Astmend が拒否（SYMBOL_NOT_FOUND, CONFLICT 等）→ 修正候補なし
      console.warn(`Astmend rejected fix for ${finding.id}: ${result.rejects?.[0]?.reason}`);
      return null;
    }

    return {
      findingId: finding.id,
      operation,
      diff: result.diff,
      updatedText: result.updatedText,
      confidence: result.rejects.length === 0 ? 'high' : 'medium',
    };
  } catch (err) {
    console.warn(`Astmend fix generation failed: ${err}`);
    return null;  // 縮退: 修正候補なしで続行
  }
}

function buildPatchOperation(finding: Finding): Record<string, unknown> | null {
  switch (finding.category) {
    case 'unused-import':
      return {
        type: 'remove_import',
        file: finding.file_path,
        module: finding.evidence,  // import 元モジュールパス
      };

    case 'missing-import':
      return {
        type: 'add_import',
        file: finding.file_path,
        module: finding.metadata?.module,
        specifiers: finding.metadata?.specifiers ?? [],
      };

    case 'missing-parameter':
      return {
        type: 'update_function',
        file: finding.file_path,
        name: finding.metadata?.functionName,
        changes: {
          add_param: {
            name: finding.metadata?.paramName,
            type: finding.metadata?.paramType ?? 'unknown',
          },
        },
      };

    case 'interface-property':
      return {
        type: 'update_interface',
        file: finding.file_path,
        name: finding.metadata?.interfaceName,
        changes: {
          add_property: {
            name: finding.metadata?.propertyName,
            type: finding.metadata?.propertyType ?? 'unknown',
          },
        },
      };

    default:
      return null;
  }
}
```

### 2-3. Markdown 出力への統合

```typescript
// render/markdown.ts に追加

function renderFixSuggestion(fix: FixSuggestion): string {
  return [
    `#### 🔧 修正候補 (confidence: ${fix.confidence})`,
    '',
    '```diff',
    fix.diff,
    '```',
    '',
    '> この修正は Astmend AST パッチエンジンにより生成されました。',
    '> ファイルへの適用は行われていません。内容を確認して手動で適用してください。',
    '',
  ].join('\n');
}
```

### 2-4. 制限事項

- **Astmend が対応する操作のみ**: `update_function`, `update_interface`, `add_import`, `remove_import`, `update_constructor`
- **ファイル保存しない**: Astmend は diff と updatedText を返すのみ
- **複数ファイルにまたがる修正は対象外**: 1 finding = 1 ファイルの修正のみ
- **Astmend 不在時は修正候補セクション自体を省略**

---

## 3. KPI 計測

```typescript
// src/services/review/metrics/calculator.ts

export interface ReviewKPIs {
  totalReviews: number;
  totalFindings: number;
  avgFindingsPerReview: number;
  precisionRate: number;              // adopted / total
  falsePositiveRate: number;          // FP / total
  knowledgeContributionRate: number;  // findings with guidance / total
  zeroFpDays: number;                 // 連続 FP ゼロ日数
  avgReviewDurationMs: number;
  precisionByCategory: Record<string, number>;
}

export async function calculateMetrics(
  timeRange: { start: Date; end: Date },
  projectKey?: string,
): Promise<ReviewKPIs> {
  const sessionFilter = projectKey
    ? sql`AND rc.repo_path LIKE ${'%' + projectKey + '%'}`
    : sql``;

  const base = await db.execute(sql`
    SELECT
      COUNT(DISTINCT rc.id) AS total_reviews,
      COUNT(ro.id)          AS total_findings,
      SUM(CASE WHEN ro.outcome_type = 'adopted' THEN 1 ELSE 0 END) AS adopted,
      SUM(CASE WHEN ro.false_positive = TRUE    THEN 1 ELSE 0 END) AS fp_count,
      SUM(CASE WHEN jsonb_array_length(ro.guidance_ids) > 0 THEN 1 ELSE 0 END) AS with_guidance,
      AVG(EXTRACT(EPOCH FROM (rc.completed_at - rc.created_at)) * 1000) AS avg_duration_ms
    FROM review_cases rc
    JOIN review_outcomes ro ON ro.review_case_id = rc.id
    WHERE rc.created_at BETWEEN ${timeRange.start} AND ${timeRange.end}
      AND rc.status = 'completed'
      ${sessionFilter}
  `);

  const row = base.rows[0];
  const total = Math.max(Number(row.total_findings), 1);

  return {
    totalReviews: Number(row.total_reviews) || 0,
    totalFindings: Number(row.total_findings) || 0,
    avgFindingsPerReview: Number(row.total_findings) / Math.max(Number(row.total_reviews), 1),
    precisionRate: Number(row.adopted) / total,
    falsePositiveRate: Number(row.fp_count) / total,
    knowledgeContributionRate: Number(row.with_guidance) / total,
    zeroFpDays: await calculateZeroFpDays(timeRange),
    avgReviewDurationMs: Number(row.avg_duration_ms) || 0,
    precisionByCategory: await calculatePrecisionByCategory(timeRange),
  };
}

async function calculateZeroFpDays(timeRange: { start: Date; end: Date }): Promise<number> {
  const fpByDay = await db.execute(sql`
    SELECT
      DATE_TRUNC('day', rc.created_at) AS day,
      SUM(CASE WHEN ro.false_positive THEN 1 ELSE 0 END) AS fp_count
    FROM review_cases rc
    JOIN review_outcomes ro ON ro.review_case_id = rc.id
    WHERE rc.created_at BETWEEN ${timeRange.start} AND ${timeRange.end}
    GROUP BY 1
    ORDER BY 1 DESC
  `);

  let consecutiveZero = 0;
  for (const row of fpByDay.rows) {
    if (Number(row.fp_count) === 0) consecutiveZero++;
    else break;
  }
  return consecutiveZero;
}

async function calculatePrecisionByCategory(
  timeRange: { start: Date; end: Date },
): Promise<Record<string, number>> {
  const result = await db.execute(sql`
    SELECT
      vm.metadata->>'category' AS category,
      COUNT(*) AS total,
      SUM(CASE WHEN ro.outcome_type = 'adopted' THEN 1 ELSE 0 END) AS adopted
    FROM review_outcomes ro
    JOIN vibe_memories vm
      ON vm.metadata->>'reviewCaseId' = ro.review_case_id
    JOIN review_cases rc ON rc.id = ro.review_case_id
    WHERE rc.created_at BETWEEN ${timeRange.start} AND ${timeRange.end}
    GROUP BY vm.metadata->>'category'
  `);

  return Object.fromEntries(
    result.rows.map(r => [r.category, Number(r.adopted) / Math.max(Number(r.total), 1)]),
  );
}
```

---

## 4. KPI ダッシュボード

```typescript
// src/services/review/metrics/dashboard.ts

export interface Dashboard {
  // 直近 7 日
  weeklyKPIs: ReviewKPIs;

  // 知識の状態
  guidanceSummary: {
    activePrinciples: number;
    activeHeuristics: number;
    activePatterns: number;
    candidateCount: number;
    degradedCount: number;
  };

  // KPI 目標達成状況
  targets: {
    precisionRate:         { current: number; target: 0.60; achieved: boolean };
    zeroFpDays:            { current: number; target: 7;    achieved: boolean };
    knowledgeContribution: { current: number; target: 0.40; achieved: boolean };
  };
}

export async function getDashboard(): Promise<Dashboard> {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const kpis = await calculateMetrics({ start: weekAgo, end: now });

  const summary = await getGuidanceSummary();

  return {
    weeklyKPIs: kpis,
    guidanceSummary: summary,
    targets: {
      precisionRate: {
        current: kpis.precisionRate,
        target: 0.60,
        achieved: kpis.precisionRate >= 0.60,
      },
      zeroFpDays: {
        current: kpis.zeroFpDays,
        target: 7,
        achieved: kpis.zeroFpDays >= 7,
      },
      knowledgeContribution: {
        current: kpis.knowledgeContributionRate,
        target: 0.40,
        achieved: kpis.knowledgeContributionRate >= 0.40,
      },
    },
  };
}

async function getGuidanceSummary(): Promise<Dashboard['guidanceSummary']> {
  const always = await getAlwaysOnGuidance(100);
  const onDemand = await getOnDemandGuidance('', 100);
  const all = [...always, ...onDemand];

  const countByTag = (tag: string) =>
    all.filter(g => ((g.metadata as any)?.tags ?? []).includes(tag)).length;

  return {
    activePrinciples: countByTag('principle'),
    activeHeuristics: countByTag('heuristic'),
    activePatterns: countByTag('pattern'),
    candidateCount: 0, // extractPatternCandidates().length でもよいが重い
    degradedCount: all.filter(g => ((g.metadata as any)?.priority ?? 50) < 30).length,
  };
}
```

---

## 5. 昇格・降格条件

### 昇格条件

| 知識タイプ | 必要件数 | 最大 FP 率 | 最小採用率 | 追加条件 |
|-----------|--------|---------|---------|--------|
| **Pattern** | 5 件 | 10% | 60% | - |
| **Heuristic** | 10 件 | 20% | 50% | - |
| **Principle** | - | - | - | 手動作成のみ |
| **Skill** | 3 件 | 5% | 80% | 手動確認必須 |

### 降格条件

| 条件 | アクション |
|------|-----------|
| FP 率 > 30%（5 件以上） | priority を 20 下げる |
| FP 率 > 50%（10 件以上） | scope を `on_demand` に変更 |
| 採用率 < 20%（20 件以上） | 手動確認待ちに戻す |

---

## 6. CLI コマンド

```bash
# KPI レポート
gnosis review metrics --project gnosis --days 30

# Guidance 候補一覧
gnosis review guidance candidates

# 手動承認して昇格
gnosis review guidance promote --id <candidate-id>

# 誤検知として記録
gnosis review feedback --review-id <id> --finding-id <fid> --outcome dismissed --false-positive

# 採用として記録
gnosis review feedback --review-id <id> --finding-id <fid> --outcome adopted

# 後続コミットから自動フィードバック検出
gnosis review feedback detect --review-id <id> --commit <hash>

# 自動昇格（dry-run）
gnosis review guidance auto-promote --dry-run
```

---

## 7. リスクと対策

| リスク | 対策 |
|--------|------|
| ローカル LLM が自信満々に誤る | 判定禁止・候補抽出のみ・always tentative |
| 上位 LLM コストが高い | 差分中心・高リスク時のみ拡張文脈・Review Planner |
| 誤検知が多く IDE が信用しなくなる | severity/confidence 分離・FP 記録・known FP 参照 |
| Guidance が雑多なメモ置き場になる | tag taxonomy 固定・priority 管理・自動降格 |
| 自然文出力で IDE が扱いづらい | JSON schema 固定・findings/next_actions 構造化 |
| Stage D の候補が空（データ不足） | Stage C で 50 件以上蓄積してから着手 |
| 自動昇格が暴走して品質低下 | 昇格条件を保守的に設定・dry-run 必須 |
| Astmend 修正候補が誤り | `apply_patch_to_text` の rejects を確認、confidence 付与、手動適用必須 |
| Astmend 不在時の UX 低下 | 修正候補セクションごとスキップ、レビュー自体には影響なし |

---

## 8. チェックリスト

### Knowledge Evolution

- [ ] `extractPatternCandidates` — SQL 集計クエリ
- [ ] `refineCandidateWithLLM` — LLM 整形
- [ ] `runAutoPromotion` — 昇格 + 降格ロジック
- [ ] `getGuidanceMetrics` — review_outcomes 集計
- [ ] 昇格テスト（モックデータで閾値検証）
- [ ] 降格テスト（FP 率超過で priority ダウン）

### Astmend 修正候補

- [ ] `isFixable` — fixable カテゴリ判定
- [ ] `buildPatchOperation` — finding → Astmend PatchOperation 変換
- [ ] `generateFixSuggestion` — `apply_patch_to_text` MCP 呼び出し
- [ ] `renderFixSuggestion` — Markdown 出力
- [ ] Astmend 不在時の縮退テスト（修正候補セクションスキップ）
- [ ] Astmend が rejects を返した場合のハンドリングテスト
- [ ] 各 fixable カテゴリの正常系テスト（unused-import, missing-parameter, interface-property）

### KPI

- [ ] `calculateMetrics` — 基本 KPI 計算
- [ ] `calculateZeroFpDays` — 連続 FP ゼロ日数
- [ ] `calculatePrecisionByCategory` — カテゴリ別精度
- [ ] `getDashboard` — ダッシュボード集約

### CLI

- [ ] `gnosis review metrics` コマンド
- [ ] `gnosis review guidance candidates` コマンド
- [ ] `gnosis review guidance promote` コマンド
- [ ] `gnosis review guidance auto-promote --dry-run` コマンド
- [ ] `gnosis review feedback` コマンド（手動 + 自動検出）

### 達成目標

- [ ] Precision rate **60% 以上**
- [ ] Knowledge Contribution rate **40% 以上**
- [ ] Zero FP Days **7 日連続** 達成
- [ ] Pattern が自動候補として 5 件以上抽出された
