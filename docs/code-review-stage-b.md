# Gnosis Code Review — Stage B: 情報付きレビュアー

**前提**: [共通基盤](./code-review-foundation.md) / [Stage A](./code-review-stage-a.md) が完成していること  
**依存 Stage**: Stage A  
**完成の定義**: 静的解析 + 構造化 diff + リスクスコアリングが統合されたレビューが出力されること

---

## 目標

```
diff → [DiffGuard.analyze_diff]        → 構造化 diff + 変更タイプ分類
     → [DiffGuard.review_diff]         → 決定論的ルールベース指摘
     → [Astmend.analyze_references]    → 変更シンボルの参照箇所
     → [Astmend.detect_impact]         → 影響を受ける宣言
     → [静的解析 (ESLint/tsc)]         → 言語固有チェック
     → [Review Planner]                → リスク判定 + LLM 使い分け
     → [LLM]                           → 総合レビュー
     → Markdown
```

- DiffGuard MCP で決定論的ルールベース指摘を追加 + diff 構造化を補強
- Astmend MCP で変更シンボルの参照解析・影響範囲検出を実行
- 静的解析（ESLint / tsc 等）を変更ファイル限定で実行
- Diff を構造化して行番号を完全保証（幻覚抑制を強化）
- Review Planner でリスクレベルを判定し LLM 使い分け

---

## 目次

1. [静的解析](#1-静的解析)
2. [Diff 構造化](#2-diff-構造化)
3. [Review Planner & LLM 使い分け](#3-review-planner--llm-使い分け)
4. [DiffGuard MCP 連携](#4-diffguard-mcp-連携)
5. [Astmend MCP 連携](#5-astmend-mcp-連携)
6. [Stage A からの差分](#6-stage-a-からの差分)
7. [エッジケース](#7-エッジケース)
8. [チェックリスト](#8-チェックリスト)

---

## 1. 静的解析

`src/services/review/static/` に実装する。

### 1-1. 実行ホワイトリスト

任意シェルコマンドの実行を禁止。言語ごとに固定コマンドのみ許可する。

```typescript
// src/services/review/static/runner.ts

const ALLOWED_TOOLS: Record<string, string[]> = {
  javascript:  ['eslint', 'prettier --check'],
  typescript:  ['eslint', 'tsc --noEmit'],
  python:      ['ruff', 'mypy'],
  rust:        ['cargo clippy'],
  go:          ['golangci-lint run'],
};

export interface StaticAnalysisFinding {
  tool: string;
  file_path: string;
  line: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  rule?: string;
}

export async function runStaticAnalysis(
  files: string[],
  projectRoot: string,
): Promise<{ findings: StaticAnalysisFinding[]; degraded: boolean }> {
  const language = detectLanguage(files[0]);
  const tools = ALLOWED_TOOLS[language] ?? [];

  for (const tool of tools) {
    if (!(await isToolAvailable(tool))) continue;

    try {
      const result = await runTool(tool, files, projectRoot);
      return { findings: result, degraded: false };
    } catch (err) {
      console.warn(`Static analysis tool failed (${tool}): ${err}`);
      // tool failure は警告のみ、レビュー継続
    }
  }

  return { findings: [], degraded: true };
}

async function isToolAvailable(tool: string): Promise<boolean> {
  try {
    // Bun.spawn を使用（execa は使わない）
    const proc = Bun.spawn([tool.split(' ')[0], '--version'], {
      stdout: 'pipe', stderr: 'pipe',
    });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}
```

### 1-2. 変更ファイル限定実行

```typescript
export async function runStaticAnalysisOnChanged(
  diffs: NormalizedDiff[],
  projectRoot: string,
): Promise<StaticAnalysisFinding[]> {
  const reviewableFiles = diffs
    .filter(d => !d.isBinary && !isGeneratedFile(d.filePath))
    .map(d => path.join(projectRoot, d.filePath));

  if (!reviewableFiles.length) return [];

  const { findings } = await runStaticAnalysis(reviewableFiles, projectRoot);

  // 変更行に含まれる指摘のみフィルタ（ノイズ削減）
  return findings.filter(f => {
    const diff = diffs.find(d => f.file_path.endsWith(d.filePath));
    if (!diff) return false;
    return diff.hunks.some(h =>
      f.line >= h.newStart && f.line < h.newStart + h.newLines,
    );
  });
}
```

### 1-3. モノレポ対策

```typescript
export async function findPackageRoot(filePath: string): Promise<string> {
  const CONFIG_FILES = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'];
  let dir = path.dirname(filePath);

  while (dir !== path.dirname(dir)) {
    for (const cfg of CONFIG_FILES) {
      if (await Bun.file(path.join(dir, cfg)).exists()) return dir;
    }
    dir = path.dirname(dir);
  }

  return process.cwd();
}
```

### 1-4. リスクシグナル抽出

```typescript
// src/services/review/static/signals.ts

const RISK_SIGNAL_PATTERNS: Record<string, RegExp[]> = {
  auth:                [/auth[_-]?(?:middleware|guard|token|jwt)/i, /requiresAuth/i],
  permission:          [/(?:can|has)[A-Z][a-z]+Permission/],
  payment:             [/stripe|payment|billing|charge/i],
  deletion:            [/delete|remove|drop|truncate/i],
  migration:           [/migration|migrate|ALTER TABLE|CREATE TABLE/i],
  transaction:         [/transaction|BEGIN|COMMIT|ROLLBACK/i],
  concurrency:         [/mutex|lock|semaphore|atomic|race/i],
  cache_invalidation:  [/invalidate|evict|flush.*cache/i],
  input_validation:    [/validate|sanitize|escape/i],
  external_api_error:  [/fetch|axios|got|http\.(?:get|post)/i],
  db_schema_change:    [/schema\.ts|\.sql|migration/i],
  config_changed:      [/\.env|config\.|settings\./i],
  tests_absent:        [/TODO.*test|FIXME.*test/i],
};

export function extractRiskSignals(diffs: NormalizedDiff[]): string[] {
  const signals = new Set<string>();

  for (const diff of diffs) {
    const content = diff.hunks.flatMap(h => h.lines.map(l => l.content)).join('\n');

    for (const [signal, patterns] of Object.entries(RISK_SIGNAL_PATTERNS)) {
      if (patterns.some(p => p.test(content))) signals.add(signal);
    }

    if (diff.classification.isMigration) signals.add('migration');
    if (diff.classification.isConfig)    signals.add('config_changed');
    if (diff.classification.isInfra)     signals.add('infra_change');
  }

  return [...signals];
}
```

### 1-5. ファイル分類

```typescript
// src/services/review/static/classifier.ts

export function classifyFile(filePath: string): FileClassification {
  const ext = path.extname(filePath).slice(1);
  const basename = path.basename(filePath);

  return {
    language: detectLanguage(filePath),
    isConfig: /\.(env|toml|ya?ml|json|ini)$/.test(filePath) || /config\b/i.test(basename),
    isMigration: /migration|migrate/i.test(filePath) || /\.sql$/.test(filePath),
    isTest: /\.(test|spec)\.[jt]sx?$/.test(filePath) || /^test\//.test(filePath),
    isInfra: /docker|terraform|ansible|k8s|kubernetes|helm/i.test(filePath),
    framework: detectFramework(filePath),
  };
}
```

---

## 2. Diff 構造化

`src/services/review/diff/` に実装する。

### 2-1. Diff 正規化

```typescript
// src/services/review/diff/normalizer.ts
import parseDiff from 'parse-diff';

export function normalizeDiff(rawDiff: string): NormalizedDiff[] {
  const files = parseDiff(rawDiff);

  return files.map(file => {
    const hunks: Hunk[] = file.chunks.map(chunk => ({
      oldStart: chunk.oldStart,
      oldLines: chunk.oldLines,
      newStart: chunk.newStart,
      newLines: chunk.newLines,
      lines: chunk.changes.map(c => ({
        type: c.type === 'add' ? 'added' : c.type === 'del' ? 'removed' : 'context',
        oldLineNo: 'ln1' in c ? c.ln1 : undefined,
        newLineNo: 'ln2' in c ? c.ln2 : ('ln' in c ? c.ln : undefined),
        content: c.content,
      })),
    }));

    const newLineMap = new Map<number, string>();
    const oldLineMap = new Map<number, string>();
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if (line.newLineNo !== undefined) newLineMap.set(line.newLineNo, line.content);
        if (line.oldLineNo !== undefined) oldLineMap.set(line.oldLineNo, line.content);
      }
    }

    return {
      filePath: file.to ?? file.from ?? 'unknown',
      changeType: detectChangeType(file),
      oldLineMap,
      newLineMap,
      hunks,
      language: detectLanguage(file.to ?? ''),
      fileSize: rawDiff.length,
      isBinary: file.binary ?? false,
      classification: classifyFile(file.to ?? ''),
    };
  });
}

function detectChangeType(file: parseDiff.File): NormalizedDiff['changeType'] {
  if (file.new) return 'added';
  if (file.deleted) return 'deleted';
  if (file.from !== file.to) return 'renamed';
  return 'modified';
}
```

### 2-2. 行番号検証（幻覚抑制強化版）

Stage B からはこの検証を必ず通す。Stage A の `validateFindingsBasic` を置き換える。

```typescript
// src/services/review/diff/validator.ts

export function validateFindingsFull(
  findings: Finding[],
  diffs: NormalizedDiff[],
): Finding[] {
  return findings.filter(finding => {
    // file_path 必須
    if (!finding.file_path || !finding.line_new) {
      console.warn('Finding missing file_path or line_new — discarded');
      return false;
    }

    const diff = diffs.find(d => d.filePath === finding.file_path);
    if (!diff) {
      console.warn(`Hallucination: file not in diff — ${finding.file_path}`);
      return false;
    }

    // 行番号が hunk 範囲内か
    const isInHunk = diff.hunks.some(h =>
      finding.line_new >= h.newStart &&
      finding.line_new < h.newStart + h.newLines,
    );
    if (!isInHunk) {
      console.warn(`Invalid line: ${finding.line_new} in ${finding.file_path}`);
      return false;
    }

    // 削除行のみへの指摘を弾く
    const line = diff.newLineMap.get(finding.line_new);
    if (!line || line.startsWith('-')) {
      console.warn(`Finding on deleted line: ${finding.line_new}`);
      return false;
    }

    // context 行への指摘は info に降格
    if (line.startsWith(' ')) {
      finding.severity = 'info';
    }

    // evidence が diff に存在するか確認
    const evidenceInDiff = diff.hunks.some(h =>
      h.lines.some(l => l.content.includes(finding.evidence)),
    );
    if (!evidenceInDiff) {
      finding.confidence = 'low';
    }

    return true;
  });
}
```

### 2-3. Finding 重複排除 & 統合

```typescript
export function deduplicateFindings(findings: Finding[]): Finding[] {
  const seen = new Map<string, Finding>();
  for (const f of findings) {
    const key = `${f.file_path}:${f.category}:${f.fingerprint}`;
    if (!seen.has(key)) seen.set(key, f);
  }
  return [...seen.values()];
}

export function mergeFindings(
  staticFindings: StaticAnalysisFinding[],
  llmFindings: Finding[],
): Finding[] {
  // 静的解析 → Finding 型に変換
  const converted: Finding[] = staticFindings.map(sf => ({
    id: crypto.randomUUID(),
    title: sf.message,
    severity: sf.severity,
    confidence: 'high' as const,
    file_path: sf.file_path,
    line_new: sf.line,
    category: 'maintainability' as const,
    rationale: `${sf.tool}: ${sf.message}${sf.rule ? ` (${sf.rule})` : ''}`,
    evidence: '',
    fingerprint: generateFingerprint({
      file_path: sf.file_path, category: 'maintainability', evidence: sf.message,
    } as any),
    needsHumanConfirmation: false,
    source: 'static_analysis' as const,
  }));

  // LLM finding と重複チェック（同一ファイル・行番号 ±2）
  const merged = [...converted];
  for (const llmF of llmFindings) {
    const isDuplicate = converted.some(sf =>
      sf.file_path === llmF.file_path &&
      Math.abs(sf.line_new - llmF.line_new) <= 2,
    );
    if (!isDuplicate) merged.push(llmF);
  }

  return merged;
}
```

---

## 3. Review Planner & LLM 使い分け

### 3-1. リスクスコアリング

```typescript
// src/services/review/planner/riskScorer.ts

const HIGH_RISK_SIGNALS = new Set([
  'auth', 'permission', 'payment', 'deletion', 'migration',
  'transaction', 'concurrency', 'cache_invalidation',
  'input_validation', 'external_api_error',
  // Astmend 由来のリスクシグナル
  'high_impact_symbol', 'cascading_change', 'api_break_risk',
]);

const LOW_RISK_SIGNALS = new Set([
  'comment_only', 'type_annotation', 'rename_only', 'style_change', 'docs_only',
]);

export interface ReviewPlan {
  riskLevel: 'low' | 'medium' | 'high';
  useHeavyLLM: boolean;
  expandContext: boolean;
  reason: string;
}

export function planReview(signals: string[]): ReviewPlan {
  const highRiskFound = signals.filter(s => HIGH_RISK_SIGNALS.has(s));
  const isLowRisk = signals.length > 0 && signals.every(s => LOW_RISK_SIGNALS.has(s));

  if (highRiskFound.length > 0) {
    return {
      riskLevel: 'high',
      useHeavyLLM: true,
      expandContext: true,
      reason: `High-risk signals: ${highRiskFound.join(', ')}`,
    };
  }

  if (isLowRisk) {
    return {
      riskLevel: 'low',
      useHeavyLLM: false,
      expandContext: false,
      reason: 'Low-risk changes only',
    };
  }

  return {
    riskLevel: 'medium',
    useHeavyLLM: true,
    expandContext: false,
    reason: 'Standard review',
  };
}
```

### 3-2. LLM 役割分担

| 役割 | ローカル LLM (`provider: 'local'`) | クラウド LLM (`provider: 'cloud'`) |
|------|-----------------------------------|-----------------------------------|
| diff 要約 | ✅ | - |
| 変更の論点列挙 | ✅ | - |
| 追加で読むべきファイル候補 | ✅ | - |
| 懸念点候補（低信頼度のみ） | ✅ | - |
| バグ候補の精査 | ❌ | ✅ |
| セキュリティ観点 | ❌ | ✅ |
| 設計論点の切り分け | ❌ | ✅ |
| 修正案提示と副作用説明 | ❌ | ✅ |
| 優先度付け・再レビュー要否 | ❌ | ✅ |
| 問題なし判定 / merge 可否 | **禁止** | **禁止** |

### 3-3. プロンプト V2（静的解析追加）

```typescript
// src/services/review/llm/promptBuilder.ts

export function buildReviewPromptV2(context: ReviewContextV2): string {
  const staticSection = context.staticAnalysisFindings.length > 0
    ? `## 静的解析結果（最優先で参照すること）\n\n${
        context.staticAnalysisFindings
          .map(f => `- [${f.tool}] ${f.file_path}:${f.line} — ${f.message}`)
          .join('\n')
      }\n`
    : '## 静的解析結果\n\n（実行されませんでした）\n';

  const impactSection = context.impactAnalysis
    ? buildImpactSection(context.impactAnalysis)
    : '## 影響範囲解析\n\n（Astmend MCP 未利用）\n';

  return `# Code Review Instructions

あなたは経験豊富なコードレビュアーです。

## リスクレベル: ${context.diffSummary.riskSignals.length > 0
    ? `**HIGH** (${context.diffSummary.riskSignals.join(', ')})`
    : 'MEDIUM'}

${staticSection}

${impactSection}

## レビュー優先順位

1. 静的解析結果を最重視する（linter/type checker の指摘は必ず言及）
2. 影響範囲解析で外部参照が指摘されたシンボルは追従漏れを重点チェック
3. 事実ベースで差分を見る（推測・仮定を避ける）
4. 根拠がある指摘だけ返す（diff 本文を引用すること）
5. 新行番号 line_new が必須（削除行のみへの指摘は不可）
6. 不確実なものは severity: "info" に下げる

## Git Diff

\`\`\`diff
${context.rawDiff}
\`\`\`

[出力は共通基盤の ReviewOutput JSON スキーマに従うこと]`;
}
```

---

## 4. DiffGuard MCP 連携

DiffGuard の決定論的ルールベース指摘を LLM の前に実行する。

### 4-1. diff 構造化補強（`analyze_diff`）

DiffGuard の `analyze_diff` ツールで変更タイプを分類し、`normalizeDiff` の結果を補強する。

```typescript
// src/services/review/static/diffguard.ts

export interface DiffGuardAnalysis {
  files: { filePath: string; changeTypes: string[] }[];
  inferredFiles: string[];
}

export async function analyzeDiffWithDiffGuard(
  unifiedDiff: string,
): Promise<DiffGuardAnalysis | null> {
  try {
    const result = await mcpClient.call('mcp_diffguard_analyze_diff', {
      diff: unifiedDiff,
    });

    return {
      files: (result.analysis?.files ?? []).map((f: any) => ({
        filePath: f.filePath,
        changeTypes: f.changeTypes ?? [],
      })),
      inferredFiles: result.inferredFiles ?? [],
    };
  } catch (err) {
    console.warn(`DiffGuard analyze_diff unavailable: ${err}`);
    return null;  // 縮退
  }
}
```

### 4-2. ルールベースレビュー（`review_diff`）

```typescript
export async function runDiffGuard(
  unifiedDiff: string,
  projectRoot: string,
): Promise<StaticAnalysisFinding[]> {
  try {
    const result = await mcpClient.call('mcp_diffguard_review_diff', {
      diff: unifiedDiff,
      workspaceRoot: projectRoot,
      enableLlm: false,   // 決定論的ルールのみ
      format: 'json',
    });

    return (result.findings ?? []).map((f: any) => ({
      tool: 'diffguard',
      file_path: f.file ?? f.path,
      line: f.line ?? 0,
      severity: mapDiffGuardSeverity(f.level),
      message: f.message,
      rule: f.ruleId,
    }));
  } catch (err) {
    console.warn(`DiffGuard review_diff unavailable: ${err}`);
    return [];  // 縮退: DiffGuard なしで続行
  }
}

function mapDiffGuardSeverity(level: string): 'error' | 'warning' | 'info' {
  switch (level) {
    case 'error': return 'error';
    case 'warn': return 'warning';
    default: return 'info';
  }
}
```

### 4-3. DiffGuard ルール対応表

DiffGuard が返す `ruleId` とコードレビューでの活用方法。

| ruleId | 名前 | 検出内容 | レビューでの活用 |
|--------|------|---------|---------------|
| `DG001` | `missing-update` | 関数シグネチャ変更に対する呼び出し側追従漏れ | severity: error、自動ブロッキング |
| `DG002` | `interface-impact` | interface 変更の未追従利用 | severity: error、Astmend impact と照合 |
| `DG003` | `unused-import` | 追加 import の未使用 | severity: warning |
| `DG004` | `di-violation` | Controller での直接 `new *Repository` | severity: warning |

---

## 5. Astmend MCP 連携

Astmend の AST ベース参照解析・影響範囲検出を利用して、Review Planner のリスク精度とプロンプトのコンテキストを強化する。

> Astmend は外部 MCP プロセスとして呼び出す。Gnosis 内に `ts-morph` 等の AST ライブラリは追加しない。

### 5-1. 変更シンボル抽出

diff から変更されたシンボル（関数・interface・class 等）を抽出する。

```typescript
// src/services/review/static/astmend.ts

import type { AstmendImpactSummary, AstmendSymbolImpact } from '../types.js';

interface ChangedSymbol {
  name: string;
  kind: 'function' | 'interface' | 'class' | 'type_alias' | 'enum' | 'variable';
  file: string;
}

/**
 * diff から変更されたシンボルを抽出する（正規表現ベース）。
 * Astmend に渡す target を決定するために使用する。
 */
export function extractChangedSymbols(diffs: NormalizedDiff[]): ChangedSymbol[] {
  const symbols: ChangedSymbol[] = [];

  for (const diff of diffs) {
    for (const hunk of diff.hunks) {
      const addedLines = hunk.lines
        .filter(l => l.type === 'added' || l.type === 'removed')
        .map(l => l.content);

      for (const line of addedLines) {
        // function / method 変更
        const funcMatch = line.match(
          /(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
        );
        if (funcMatch) {
          symbols.push({ name: funcMatch[1], kind: 'function', file: diff.filePath });
        }

        // interface 変更
        const ifaceMatch = line.match(
          /(?:export\s+)?interface\s+(\w+)/,
        );
        if (ifaceMatch) {
          symbols.push({ name: ifaceMatch[1], kind: 'interface', file: diff.filePath });
        }

        // class 変更
        const classMatch = line.match(
          /(?:export\s+)?class\s+(\w+)/,
        );
        if (classMatch) {
          symbols.push({ name: classMatch[1], kind: 'class', file: diff.filePath });
        }
      }
    }
  }

  // 重複排除
  const seen = new Set<string>();
  return symbols.filter(s => {
    const key = `${s.file}:${s.kind}:${s.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
```

### 5-2. 参照解析 + 影響範囲検出

```typescript
/**
 * Astmend MCP を呼び出して各シンボルの参照・影響を分析する。
 * Astmend 不在時は degraded: true を返して続行する。
 */
export async function analyzeImpactWithAstmend(
  symbols: ChangedSymbol[],
  projectRoot: string,
): Promise<AstmendImpactSummary> {
  if (symbols.length === 0) return { symbols: [], degraded: false };

  const results: AstmendSymbolImpact[] = [];

  for (const symbol of symbols) {
    const filePath = path.join(projectRoot, symbol.file);

    try {
      // 参照解析
      const refResult = await mcpClient.call('mcp_astmend_analyze_references_from_file', {
        filePath,
        target: { kind: symbol.kind, name: symbol.name },
      });

      // 影響範囲検出
      const impactResult = await mcpClient.call('mcp_astmend_detect_impact_from_file', {
        filePath,
        target: { kind: symbol.kind, name: symbol.name },
      });

      results.push({
        name: symbol.name,
        kind: symbol.kind,
        file: symbol.file,
        references: (refResult.references ?? []).map((r: any) => ({
          file: r.file ?? r.filePath,
          line: r.line,
          isDefinition: r.isDefinition ?? false,
        })),
        impactedDeclarations: (impactResult.result ?? []).map((d: any) => ({
          name: d.name,
          kind: d.kind,
          file: d.file ?? symbol.file,
        })),
      });
    } catch (err) {
      console.warn(`Astmend analysis failed for ${symbol.name}: ${err}`);
      // 個別シンボルの失敗はスキップ
    }
  }

  return {
    symbols: results,
    degraded: results.length === 0 && symbols.length > 0,
  };
}
```

### 5-3. Review Planner への影響反映

Astmend の結果をリスクスコアリングに組み込む。

```typescript
// riskScorer.ts 内で呼び出す

export function enrichRiskSignalsWithImpact(
  signals: string[],
  impact: AstmendImpactSummary,
): string[] {
  const enriched = [...signals];

  for (const symbol of impact.symbols) {
    // 参照が 5 箇所以上 → high_impact
    if (symbol.references.length >= 5) {
      enriched.push('high_impact_symbol');
    }

    // 影響を受ける宣言が存在 → cascading_change
    if (symbol.impactedDeclarations.length > 0) {
      enriched.push('cascading_change');
    }

    // 公開 API (export) の変更 + 外部参照あり → api_break_risk
    const externalRefs = symbol.references.filter(r => r.file !== symbol.file);
    if (externalRefs.length > 0) {
      enriched.push('api_break_risk');
    }
  }

  return [...new Set(enriched)];
}
```

### 5-4. プロンプトへの注入

```typescript
// promptBuilder.ts 内で使用

function buildImpactSection(impact: AstmendImpactSummary): string {
  if (impact.degraded || impact.symbols.length === 0) {
    return '## 影響範囲解析\n\n（Astmend MCP 利用不可のため省略）\n';
  }

  const lines = ['## 影響範囲解析（Astmend AST 解析結果）\n'];

  for (const sym of impact.symbols) {
    lines.push(`### ${sym.kind} \`${sym.name}\` (${sym.file})`);
    lines.push(`- 参照箇所: ${sym.references.length} 件`);

    const externalRefs = sym.references.filter(r => r.file !== sym.file);
    if (externalRefs.length > 0) {
      lines.push(`- **外部参照** (追従漏れ注意):`);
      for (const ref of externalRefs.slice(0, 10)) {
        lines.push(`  - ${ref.file}:${ref.line}`);
      }
    }

    if (sym.impactedDeclarations.length > 0) {
      lines.push(`- **影響を受ける宣言**:`);
      for (const d of sym.impactedDeclarations) {
        lines.push(`  - ${d.kind} \`${d.name}\` (${d.file})`);
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}
```

---

## 6. Stage A からの差分

| 項目 | Stage A | Stage B |
|------|---------|---------|
| diff | raw string | `NormalizedDiff[]` |
| 行番号検証 | ファイル存在確認のみ | hunk 範囲・削除行・context 行 |
| 静的解析 | なし | DiffGuard + Astmend + 言語別ツール |
| 影響範囲 | なし | Astmend 参照解析 + 影響宣言検出 |
| リスク判定 | 固定 `medium` | Review Planner（Astmend 影響データ込み） |
| LLM 使い分け | 常に cloud | low risk → local LLM |
| プロンプト | V1 (raw diff) | V2 (静的解析 + 影響範囲注入) |
| finding source | `heavy_llm` のみ | `static_analysis` + `diffguard` + LLM |

### オーケストレーター（Stage B）

```typescript
// src/services/review/orchestrator.ts (Stage B 版 — Stage A を拡張)

export async function runReviewStageB(req: ReviewRequest): Promise<ReviewOutput> {
  const startTime = Date.now();
  const degradedModes: DegradedMode[] = [];

  // --- Stage A と共通 ---
  validateAllowedRoot(req.repoPath);
  validateSessionId(req.sessionId);
  const rawDiff = await getDiff(req.repoPath, req.mode);
  if (!rawDiff.trim()) return buildEmptyResult('no_changes', startTime);
  enforceHardLimit(rawDiff);
  const maskedDiff = maskOrThrow(rawDiff, true);

  // --- Stage B 追加 ---
  const diffs = normalizeDiff(maskedDiff);

  // DiffGuard: diff 構造化補強 + ルールベースチェック
  const dgAnalysis = await analyzeDiffWithDiffGuard(maskedDiff);
  const diffGuardFindings = await runDiffGuard(maskedDiff, req.repoPath);

  // Astmend: 参照解析 + 影響範囲検出
  const changedSymbols = extractChangedSymbols(diffs);
  const impactAnalysis = await analyzeImpactWithAstmend(changedSymbols, req.repoPath);
  if (impactAnalysis.degraded) degradedModes.push(DegradedMode.ASTMEND_UNAVAILABLE);

  // 静的解析
  const { findings: staticFindings, degraded: staticDegraded } =
    await runStaticAnalysisOnChanged(diffs, req.repoPath);
  if (staticDegraded) degradedModes.push(DegradedMode.STATIC_ANALYSIS_UNAVAILABLE);

  // リスクシグナル + Astmend 影響反映 + Review Planner
  const baseSignals = extractRiskSignals(diffs);
  const riskSignals = enrichRiskSignalsWithImpact(baseSignals, impactAnalysis);
  const plan = planReview(riskSignals);

  // LLM レビュー（プロンプト V2 — 静的解析 + 影響範囲注入）
  const allStaticFindings = [...diffGuardFindings, ...staticFindings];
  const llmService = await getReviewLLMService(plan.useHeavyLLM ? 'cloud' : 'local');
  const { findings: llmFindings, summary, next_actions } = await reviewWithLLM(
    {
      instruction: '',
      projectInfo: detectProjectInfo(req.repoPath),
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
      outputSchema: REVIEW_OUTPUT_SCHEMA,
    },
    llmService,
  );

  // 幻覚抑制（Stage B: 厳密版）+ 統合
  const validatedFindings = validateFindingsFull(llmFindings, diffs);
  const merged = deduplicateFindings(mergeFindings(allStaticFindings, validatedFindings));

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
      astmend_impact_available: !impactAnalysis.degraded,
      knowledge_applied: [],
      degraded_mode: degradedModes.length > 0,
      degraded_reasons: degradedModes,
      local_llm_used: llmService.provider === 'local',
      heavy_llm_used: llmService.provider === 'cloud',
      review_duration_ms: Date.now() - startTime,
    },
    markdown: '',
  };
  result.markdown = renderReviewMarkdown(result);
  return result;
}
```

---

## 7. エッジケース

### 静的解析と LLM の重複

`mergeFindings` で同一ファイル・行番号 ±2 の重複は静的解析側を優先する。

### ローカル LLM 不可時のフォールバック

```typescript
// getReviewLLMService('local') が失敗 → cloud にフォールバック
// 両方不可 → ReviewError('E007')
```

### ローカル LLM が断定的な表現を出力

```typescript
function softenLocalLLMFindings(findings: Finding[]): Finding[] {
  return findings.map(f => {
    if (f.source === 'local_llm') {
      return { ...f, confidence: 'low' as const, needsHumanConfirmation: true };
    }
    return f;
  });
}
```

### Astmend MCP 不在時

```typescript
// Astmend MCP が利用不可 → impactAnalysis.degraded = true
// リスクシグナル enrichment をスキップ、プロンプトに「利用不可」と記載
// レビュー自体は続行（DiffGuard + 静的解析 + LLM で十分機能する）
```

### Astmend のシンボル解析が大量結果を返す場合

```typescript
// 参照箇所が 50 件超 → プロンプトには上位 10 件 + 合計数のみ注入
// 影響宣言が 20 件超 → 同様に上位 10 件に制限
```

### DiffGuard と Astmend の指摘重複

DiffGuard `DG001` (missing-update) と Astmend の外部参照検出が同一シンボルを指す場合、
DiffGuard の finding を正とする（より具体的な remediation を含むため）。

---

## 8. チェックリスト

### 静的解析

- [ ] `ALLOWED_TOOLS` ホワイトリスト実装
- [ ] `runStaticAnalysis` — `Bun.spawn` でツール実行
- [ ] `runStaticAnalysisOnChanged` — 変更ファイル限定 + 変更行フィルタ
- [ ] `findPackageRoot` — モノレポ対応
- [ ] `classifyFile` — ファイル分類
- [ ] `extractRiskSignals` — 各パターンのテスト
- [ ] ツール不在時の縮退テスト

### Diff 構造化

- [ ] `normalizeDiff` — added / modified / deleted / renamed
- [ ] `validateFindingsFull` — hunk 範囲 / 削除行 / context 行降格 / evidence 検証
- [ ] `deduplicateFindings` — fingerprint ベース
- [ ] `mergeFindings` — 静的解析 + LLM 統合、行番号 ±2 重複排除

### Review Planner

- [ ] `planReview` — high / medium / low 判定（`enrichRiskSignalsWithImpact` 込み）
- [ ] `getReviewLLMService` — local → cloud フォールバック
- [ ] `buildReviewPromptV2` — 静的解析結果 + 影響範囲注入

### DiffGuard 連携

- [ ] `analyzeDiffWithDiffGuard` — `analyze_diff` MCP 呼び出し
- [ ] `runDiffGuard` — `review_diff` MCP 呼び出し
- [ ] `mapDiffGuardSeverity` — level → severity マッピング
- [ ] DiffGuard 不在時の縮退テスト

### Astmend 連携

- [ ] `extractChangedSymbols` — diff からシンボル抽出（function / interface / class）
- [ ] `analyzeImpactWithAstmend` — `analyze_references_from_file` + `detect_impact_from_file`
- [ ] `enrichRiskSignalsWithImpact` — 影響データによるリスクシグナル補強
- [ ] `buildImpactSection` — プロンプト用影響範囲セクション生成
- [ ] Astmend 不在時の縮退テスト（`degraded: true` で続行）
- [ ] 大量参照時のプロンプト上限テスト

### E2E 検証

- [ ] `gnosis review run --enable-static-analysis` で findings に静的解析結果が含まれる
- [ ] risk_level が適切に判定される（Astmend 影響データ反映）
- [ ] 行番号が 100% 正確である（diff 内に存在する行のみ）
- [ ] DiffGuard / Astmend 片方不在でもレビューが完走する
