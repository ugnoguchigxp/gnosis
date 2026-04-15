# Gnosis Code Review — Stage A: 単発レビュアー

**前提**: [共通基盤](./code-review-foundation.md) を先に読むこと  
**依存 Stage**: なし（最初に実装する）  
**完成の定義**: `gnosis review run` を実行すると Markdown レビュー結果が返ること

---

## 目標

```
diff → secret masking → LLM → Markdown
```

- DB への書き込みなし（stateless）
- 知識注入なし
- 静的解析なし

---

## 目次

1. [設計上の決定事項](#1-設計上の決定事項)
2. [Foundation（安全境界）](#2-foundation安全境界)
3. [LLM レビューエンジン](#3-llm-レビューエンジン)
4. [Markdown 出力](#4-markdown-出力)
5. [オーケストレーター](#5-オーケストレーター)
6. [CLI](#6-cli)
7. [エッジケース](#7-エッジケース)
8. [チェックリスト](#8-チェックリスト)

---

## 1. 設計上の決定事項

Stage A 実装前に以下を決定する。

### sessionId の形式

```typescript
const projectKey = `${path.basename(repoPath)}:${branchName}`;
const sessionId = `code-review-${projectKey}`;
// 例: "code-review-gnosis:main"
```

- repo 単位を推奨（branch をまたいだ知識を共有するため）

### LLM 切り替え条件

- ローカル LLM: マスキング後も許可
- クラウド LLM: マスキング失敗時は **送信停止**（フォールバックなし）

### ハードリミット値

共通基盤 Section 4 `REVIEW_LIMITS` を参照。Stage A ではそのまま使用する。

---

## 2. Foundation（安全境界）

`src/services/review/foundation/` に実装する。

### 2-1. Allowed roots

```typescript
// src/services/review/foundation/allowedRoots.ts
import fs from 'fs';
import { ReviewError } from '../errors.js';

export function validateAllowedRoot(projectRoot: string): void {
  const allowedEnv = process.env.GNOSIS_ALLOWED_ROOTS;
  const allowed = allowedEnv
    ? allowedEnv.split(':').map(p => fs.realpathSync(p))
    : [process.cwd()];

  let realRoot: string;
  try {
    realRoot = fs.realpathSync(projectRoot);
  } catch {
    throw new ReviewError('E001', `Cannot resolve path: ${projectRoot}`);
  }

  if (!allowed.some(root => realRoot.startsWith(root))) {
    throw new ReviewError('E001', `Project root outside allowed paths: ${projectRoot}`);
  }
}
```

### 2-2. sessionId 検証

```typescript
// src/services/review/foundation/sessionId.ts
import { ReviewError } from '../errors.js';

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_:-]{1,256}$/;

export function validateSessionId(sessionId: string): void {
  if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new ReviewError('E002', `Invalid sessionId: "${sessionId}"`);
  }
}
```

### 2-3. Git diff 取得

```typescript
// src/services/review/foundation/gitDiff.ts
import { simpleGit } from 'simple-git';

export async function getDiff(
  repoPath: string,
  mode: 'git_diff' | 'worktree',
): Promise<string> {
  const git = simpleGit(repoPath);

  if (mode === 'git_diff') {
    const staged = await git.diff(['--cached']);
    if (staged.trim()) return staged;

    const unstaged = await git.diff();
    if (unstaged.trim()) return unstaged;

    return '';
  }

  // worktree: 追跡済みの全変更
  return await git.diff(['HEAD']);
}
```

### 2-4. ハードリミット

```typescript
// src/services/review/foundation/hardLimit.ts
import { ReviewError } from '../errors.js';
import { REVIEW_LIMITS } from '../errors.js';

export function enforceHardLimit(rawDiff: string): void {
  const lines = rawDiff.split('\n');

  if (lines.length > REVIEW_LIMITS.MAX_DIFF_LINES) {
    throw new ReviewError('E003',
      `Diff too large: ${lines.length} lines (limit: ${REVIEW_LIMITS.MAX_DIFF_LINES})`);
  }

  const changedFiles = (rawDiff.match(/^diff --git/gm) || []).length;
  if (changedFiles > REVIEW_LIMITS.MAX_FILES) {
    throw new ReviewError('E003',
      `Too many files: ${changedFiles} (limit: ${REVIEW_LIMITS.MAX_FILES})`);
  }
}
```

### 2-5. Secret masking

```typescript
// src/services/review/foundation/secretMask.ts
import { ReviewError } from '../errors.js';

interface MaskResult {
  masked: string;
  maskCount: number;
  hadSecrets: boolean;
}

const SECRET_PATTERNS = [
  { pattern: /api[_-]?key\s*[:=]\s*['"]([^'"]{8,})['"]/gi,  label: 'API_KEY' },
  { pattern: /bearer\s+([a-zA-Z0-9_\-\.]{20,})/gi,          label: 'BEARER_TOKEN' },
  { pattern: /AKIA[0-9A-Z]{16}/g,                            label: 'AWS_KEY' },
  { pattern: /-----BEGIN[A-Z ]+PRIVATE KEY-----[\s\S]+?-----END[A-Z ]+PRIVATE KEY-----/g, label: 'PRIVATE_KEY' },
  { pattern: /password\s*[:=]\s*['"]([^'"]{4,})['"]/gi,      label: 'PASSWORD' },
];

const EXCLUSION_PATTERNS = [
  /your[_-]api[_-]key/i,
  /xxx+/i,
  /\$\{[^}]+\}/,       // テンプレートリテラル
  /process\.env\./,
];

export function maskSecrets(input: string): MaskResult {
  let masked = input;
  let maskCount = 0;

  for (const { pattern, label } of SECRET_PATTERNS) {
    masked = masked.replace(pattern, (match) => {
      if (EXCLUSION_PATTERNS.some(ep => ep.test(match))) return match;
      maskCount++;
      return `[MASKED:${label}]`;
    });
  }

  return { masked, maskCount, hadSecrets: maskCount > 0 };
}

export function maskOrThrow(input: string, allowCloud: boolean): string {
  try {
    const { masked } = maskSecrets(input);
    return masked;
  } catch (err) {
    if (!allowCloud) return input; // ローカル LLM なら続行
    throw new ReviewError('E004', 'Secret masking failed; cannot send to cloud LLM');
  }
}
```

---

## 3. LLM レビューエンジン

Stage A では diff を構造化せず、マスキング済み raw diff を直接 LLM に渡す。

### 3-1. プロンプト V1（上位 LLM 用）

```typescript
// src/services/review/llm/promptBuilder.ts

export function buildReviewPromptV1(
  maskedDiff: string,
  projectInfo: { language: string; framework?: string },
): string {
  return `# Code Review Instructions

あなたは経験豊富なコードレビュアーです。以下の Git diff をレビューしてください。

## プロジェクト情報
- Language: ${projectInfo.language}
${projectInfo.framework ? `- Framework: ${projectInfo.framework}` : ''}

## レビュー方針

1. **事実ベースで差分を見る** — 推測や仮定を避ける
2. **根拠がある指摘だけ返す** — 具体的な証拠（diff 本文の引用）を示す
3. **新行番号に紐づかない指摘は返さない** — 必ず \`line_new\` を指定
4. **不確実なものは severity: "info" に下げる** — 断定的な表現を避ける
5. **「問題なし」とは絶対に言わない** — 指摘がない場合は findings を空にする

## 出力形式（JSON）

\`\`\`json
{
  "review_status": "changes_requested" | "needs_confirmation" | "no_major_findings",
  "findings": [
    {
      "id": "f-001",
      "title": "簡潔なタイトル",
      "severity": "error" | "warning" | "info",
      "confidence": "high" | "medium" | "low",
      "file_path": "相対パス",
      "line_new": 42,
      "category": "bug" | "security" | "performance" | "design" | "maintainability" | "test" | "validation",
      "rationale": "指摘理由（根拠明示）",
      "suggested_fix": "修正案（省略可）",
      "evidence": "diff本文からの引用",
      "needsHumanConfirmation": false
    }
  ],
  "summary": "変更の概要と主要な指摘の要約",
  "next_actions": ["IDEが次にすべきアクション"]
}
\`\`\`

## Git Diff

\`\`\`diff
${maskedDiff}
\`\`\``;
}
```

### 3-2. 幻覚抑制（簡易版）

Stage A では行番号マッピングがないため、簡易検証のみ行う。
Stage B で `validateFindingsFull` に置き換わる。

```typescript
// src/services/review/llm/hallucinator.ts

export function validateFindingsBasic(
  findings: Finding[],
  rawDiff: string,
): Finding[] {
  const diffFiles = extractFilePathsFromDiff(rawDiff);

  return findings.filter(finding => {
    // file_path が diff に存在するか
    if (!diffFiles.includes(finding.file_path)) {
      console.warn(`Hallucination: file not in diff — ${finding.file_path}`);
      return false;
    }

    // severity enum 妥当性
    if (!['error', 'warning', 'info'].includes(finding.severity)) {
      return false;
    }

    // rationale が空でないか
    if (!finding.rationale?.trim()) {
      return false;
    }

    return true;
  });
}

function extractFilePathsFromDiff(diff: string): string[] {
  const matches = diff.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm);
  return [...matches].map(m => m[2]);
}
```

### 3-3. fingerprint 生成

```typescript
// src/services/review/llm/hallucinator.ts (同ファイル)
import { createHash } from 'crypto';

export function generateFingerprint(finding: Omit<Finding, 'fingerprint'>): string {
  const key = `${finding.file_path}:${finding.category}:${finding.evidence.slice(0, 100)}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}
```

### 3-4. LLM 呼び出し

`ReviewLLMService` インターフェース（共通基盤 Section 6）を使用する。

```typescript
// src/services/review/llm/reviewer.ts
import { REVIEW_LIMITS } from '../errors.js';
import { ReviewError } from '../errors.js';
import type { ReviewLLMService } from './types.js';

export async function reviewWithLLM(
  context: ReviewContextV1,
  llmService: ReviewLLMService,
): Promise<{ findings: Finding[]; summary: string; next_actions: string[] }> {
  const prompt = buildReviewPromptV1(context.rawDiff, context.projectInfo);

  let rawOutput: string;
  try {
    rawOutput = await Promise.race([
      llmService.generate(prompt, { format: 'json' }),
      rejectAfter(REVIEW_LIMITS.LLM_TIMEOUT_MS),
    ]);
  } catch (err) {
    if (err instanceof TimeoutError) {
      return { findings: [], summary: 'Review timed out', next_actions: [] };
    }
    throw new ReviewError('E006', `LLM error: ${err}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    return { findings: [], summary: rawOutput.slice(0, 200), next_actions: [] };
  }

  const validated = validateFindingsBasic(parsed.findings ?? [], context.rawDiff);
  return {
    findings: validated.map(f => ({
      ...f,
      fingerprint: generateFingerprint(f),
      source: llmService.provider === 'local' ? 'local_llm' : 'heavy_llm',
    } as Finding)),
    summary: parsed.summary ?? '',
    next_actions: parsed.next_actions ?? [],
  };
}

function rejectAfter(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new TimeoutError()), ms),
  );
}

class TimeoutError extends Error {
  constructor() { super('Timeout'); this.name = 'TimeoutError'; }
}
```

---

## 4. Markdown 出力

```typescript
// src/services/review/render/markdown.ts

export function renderReviewMarkdown(result: ReviewOutput): string {
  const lines: string[] = [];

  lines.push('# Code Review Results\n');

  // 縮退運転警告
  if (result.metadata.degraded_mode) {
    lines.push('> ⚠️ **Degraded Mode**: 一部機能が利用不可のためレビュー範囲が制限されています\n');
    for (const reason of result.metadata.degraded_reasons) {
      lines.push(`> - ${reason}`);
    }
    lines.push('');
  }

  // サマリー
  lines.push(`## Summary\n\n${result.summary}\n`);

  // メタデータ
  lines.push('## Metadata\n');
  lines.push(`- Reviewed files: ${result.metadata.reviewed_files}`);
  lines.push(`- Risk level: **${result.metadata.risk_level}**`);
  lines.push(`- Static analysis: ${result.metadata.static_analysis_used ? '✅' : '❌ (not run)'}`);
  if (result.metadata.knowledge_applied.length > 0) {
    lines.push(`- Knowledge applied: ${result.metadata.knowledge_applied.join(', ')}`);
  }
  lines.push('');

  // 指摘なし
  if (result.findings.length === 0) {
    lines.push('## ✅ No Major Issues Found\n');
    lines.push('重大な問題は検出されませんでした。ただし、このレビューは LLM 補助によるものです。');
    return lines.join('\n');
  }

  // 指摘を severity 順にグループ化
  const order: Array<Finding['severity']> = ['error', 'warning', 'info'];
  const grouped = Object.groupBy(result.findings, f => f.severity);
  const icons: Record<string, string> = { error: '🔴', warning: '🟡', info: 'ℹ️' };

  for (const sev of order) {
    const findings = grouped[sev];
    if (!findings?.length) continue;

    lines.push(`## ${icons[sev]} ${sev.charAt(0).toUpperCase() + sev.slice(1)} (${findings.length})\n`);

    const byFile = Object.groupBy(findings, f => f.file_path);

    for (const [file, ffindings] of Object.entries(byFile)) {
      lines.push(`### \`${file}\`\n`);

      for (const f of ffindings!) {
        lines.push(`#### Line ${f.line_new}: ${f.title}`);
        lines.push(`**Category**: ${f.category} | **Confidence**: ${f.confidence}${f.needsHumanConfirmation ? ' | ⚠️ 要確認' : ''}\n`);
        lines.push(`${f.rationale}\n`);

        if (f.evidence) {
          lines.push('**Evidence**:');
          lines.push('```');
          lines.push(f.evidence);
          lines.push('```\n');
        }

        if (f.suggested_fix) {
          lines.push('**Suggested Fix**:');
          lines.push('```');
          lines.push(f.suggested_fix);
          lines.push('```\n');
        }
      }
    }
  }

  // 次のアクション
  if (result.next_actions.length > 0) {
    lines.push('## Next Actions\n');
    for (const action of result.next_actions) {
      lines.push(`- ${action}`);
    }
  }

  return lines.join('\n');
}
```

---

## 5. オーケストレーター

```typescript
// src/services/review/orchestrator.ts (Stage A 版)

export async function runReviewStageA(req: ReviewRequest): Promise<ReviewOutput> {
  const startTime = Date.now();

  // 1. 入力検証
  validateAllowedRoot(req.repoPath);
  validateSessionId(req.sessionId);

  // 2. diff 取得
  let rawDiff: string;
  try {
    rawDiff = await getDiff(req.repoPath, req.mode);
  } catch (err) {
    throw new ReviewError('E005', `Git diff failed: ${err}`);
  }

  if (!rawDiff.trim()) {
    return buildEmptyResult('no_changes', startTime);
  }

  // 3. ハードリミット
  enforceHardLimit(rawDiff);

  // 4. Secret masking
  const maskedDiff = maskOrThrow(rawDiff, /* allowCloud */ true);

  // 5. LLM レビュー
  const llmService = await getReviewLLMService('cloud');
  const { findings, summary, next_actions } = await reviewWithLLM(
    {
      instruction: '',
      projectInfo: detectProjectInfo(req.repoPath),
      rawDiff: maskedDiff,
      outputSchema: REVIEW_OUTPUT_SCHEMA,
    },
    llmService,
  );

  // 6. 結果構築 + Markdown 生成
  const result: ReviewOutput = {
    review_id: crypto.randomUUID(),
    task_id: req.taskId,
    review_status: deriveReviewStatus(findings),
    findings,
    summary,
    next_actions,
    rerun_review: findings.some(f => f.severity === 'error'),
    metadata: {
      reviewed_files: countChangedFiles(rawDiff),
      risk_level: 'medium',       // Stage B で精緻化
      static_analysis_used: false,
      knowledge_applied: [],
      degraded_mode: false,
      degraded_reasons: [],
      local_llm_used: llmService.provider === 'local',
      heavy_llm_used: llmService.provider === 'cloud',
      review_duration_ms: Date.now() - startTime,
    },
    markdown: '',
  };
  result.markdown = renderReviewMarkdown(result);

  return result;
}

// --- ヘルパー ---

function deriveReviewStatus(findings: Finding[]): ReviewStatus {
  if (findings.some(f => f.severity === 'error')) return 'changes_requested';
  if (findings.some(f => f.needsHumanConfirmation)) return 'needs_confirmation';
  return 'no_major_findings';
}

function buildEmptyResult(reason: string, startTime: number): ReviewOutput {
  return {
    review_id: crypto.randomUUID(),
    review_status: 'no_major_findings',
    findings: [],
    summary: reason === 'no_changes' ? 'No changes detected' : reason,
    next_actions: [],
    rerun_review: false,
    metadata: {
      reviewed_files: 0,
      risk_level: 'low',
      static_analysis_used: false,
      knowledge_applied: [],
      degraded_mode: false,
      degraded_reasons: [],
      local_llm_used: false,
      heavy_llm_used: false,
      review_duration_ms: Date.now() - startTime,
    },
    markdown: '',
  };
}

function countChangedFiles(rawDiff: string): number {
  return (rawDiff.match(/^diff --git/gm) || []).length;
}
```

---

## 6. CLI

```bash
# 基本レビュー
gnosis review run \
  --task-id task-123 \
  --repo /workspace/app \
  --base main \
  --head HEAD \
  --goal "ユーザー更新APIに認可を追加"

# hook 経由（IDE から自動呼び出し）
gnosis hook task-completed \
  --task-id task-123 \
  --repo /workspace/app \
  --base main \
  --head HEAD

# MCP 向け助言出力（JSON）
gnosis mcp advise --task-id task-123 --format json
```

---

## 7. エッジケース

### 入力系

```typescript
// rename only — レビュー不要
if (diff.changeType === 'renamed' && diff.hunks.length === 0) {
  return { findings: [], summary: 'File renamed with no content changes' };
}

// binary file — スキップ
if (diff.isBinary) {
  return { findings: [], summary: 'Binary file change detected (skipped)' };
}

// generated / vendor file — スキップ
const SKIP_PATTERNS = ['node_modules/', 'vendor/', '.min.js', '.min.css', 'dist/'];
if (SKIP_PATTERNS.some(p => diff.filePath.includes(p))) {
  return { findings: [], summary: 'Generated/vendor file (skipped)' };
}

// lock file — 依存変更の通知のみ
if (/package-lock\.json|yarn\.lock|bun\.lockb|Cargo\.lock/.test(diff.filePath)) {
  return { findings: [createInfo('Dependencies updated')], summary: 'Lock file changed' };
}
```

### Git 系

```typescript
// detached HEAD — 警告のみ、続行
if (await git.revparse(['--abbrev-ref', 'HEAD']) === 'HEAD') {
  console.warn('Detached HEAD state detected');
}

// no staged / no unstaged — 両方試して空なら終了
if (!rawDiff.trim()) {
  return buildEmptyResult('no_changes', startTime);
}
```

### Secret 系

```typescript
// .env ファイル — 全行マスク
if (/\.env(\.|$)/.test(filePath)) {
  return maskEntireFile(content);
}

// コメント内の credential
const COMMENT_SECRET = /(?:\/\/|#)\s*.*(?:key|token|password)\s*[:=]\s*\S+/i;
```

---

## 8. チェックリスト

### 設計決定

- [ ] sessionId 形式の決定（repo 単位 or branch 込み）
- [ ] `GNOSIS_ALLOWED_ROOTS` 環境変数の設定
- [ ] LLM サービス接続確認（`ReviewLLMService` の cloud / local 両方）

### Foundation

- [ ] `validateAllowedRoot` — 境界外パスで E001
- [ ] `validateSessionId` — 不正 ID で E002
- [ ] `getDiff` — staged / unstaged / worktree の各モード
- [ ] `enforceHardLimit` — 過大 diff で E003
- [ ] `maskSecrets` — 各 SECRET_PATTERNS + EXCLUSION_PATTERNS
- [ ] `maskOrThrow` — cloud 送信停止パス

### LLM レビュー

- [ ] `buildReviewPromptV1` — プロンプト生成
- [ ] `validateFindingsBasic` — ファイル存在確認 / severity / rationale
- [ ] `generateFingerprint` — sha256 ベース
- [ ] `reviewWithLLM` — タイムアウト / 非 JSON 返却 / 正常系
- [ ] `ReviewLLMService` — localProvider / cloudProvider の実装

### Markdown + CLI

- [ ] `renderReviewMarkdown` — 指摘あり / なし / 縮退の各パターン
- [ ] `gnosis review run` コマンド
- [ ] E2E テスト: 実リポジトリで findings + Markdown が出力される
