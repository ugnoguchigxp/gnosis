import { buildImpactSection } from '../static/astmend.js';
import type { ReviewContextV1, ReviewContextV2, ReviewContextV3 } from '../types.js';

export interface ReviewProjectInfo {
  language: string;
  framework?: string;
}

function buildStaticSection(context: ReviewContextV2): string {
  if (context.staticAnalysisFindings.length === 0) {
    return '## 静的解析結果\n\n（実行されませんでした）\n';
  }

  const lines = ['## 静的解析結果（最優先で参照すること）', ''];
  for (const finding of context.staticAnalysisFindings) {
    lines.push(
      `- [${finding.source}] ${finding.file_path}:${finding.line ?? 0} — ${finding.message}${
        finding.rule_id ? ` (${finding.rule_id})` : ''
      }`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

function buildGuidanceSection(
  title: string,
  items: Array<{ title: string; content: string }>,
): string {
  if (items.length === 0) {
    return '';
  }

  const lines = [`## ${title}`, ''];
  for (const [index, item] of items.entries()) {
    lines.push(`### ${index + 1}. ${item.title}`);
    lines.push(item.content.trim());
    lines.push('');
  }

  return lines.join('\n');
}

function buildDiffSummarySection(context: ReviewContextV2): string {
  const riskLabel =
    context.diffSummary.riskSignals.length > 0
      ? `HIGH (${context.diffSummary.riskSignals.join(', ')})`
      : 'MEDIUM';

  return [
    '## Diff Summary',
    '',
    `- Files changed: ${context.diffSummary.filesChanged}`,
    `- Lines added: ${context.diffSummary.linesAdded}`,
    `- Lines removed: ${context.diffSummary.linesRemoved}`,
    `- Risk level hint: ${riskLabel}`,
    '',
  ].join('\n');
}

function buildV1Instruction(
  maskedDiff: string,
  projectInfo: ReviewProjectInfo,
  instruction = '',
): string {
  const lines: string[] = [
    '# Code Review Instructions',
    '',
    'あなたは経験豊富なコードレビュアーです。以下の Git diff をレビューしてください。',
    '',
    '## プロジェクト情報',
    `- Language: ${projectInfo.language}`,
  ];

  if (projectInfo.framework) {
    lines.push(`- Framework: ${projectInfo.framework}`);
  }

  lines.push('');

  if (instruction.trim()) {
    lines.push('## レビュー目的');
    lines.push('');
    lines.push(instruction.trim());
    lines.push('');
  }

  lines.push('## レビュー方針');
  lines.push('');
  lines.push('1. 事実ベースで差分を見る — 推測や仮定を避ける');
  lines.push('2. 根拠がある指摘だけ返す — 具体的な証拠（diff 本文の引用）を示す');
  lines.push('3. 新行番号に紐づかない指摘は返さない — 必ず line_new を指定する');
  lines.push('4. 不確実なものは severity: "info" に下げる — 断定的な表現を避ける');
  lines.push('5. 「問題なし」とは絶対に言わない — 指摘がない場合は findings を空にする');
  lines.push('');
  lines.push('## 出力形式（JSON）');
  lines.push('');
  lines.push('```json');
  lines.push('{');
  lines.push(
    '  "review_status": "changes_requested" | "needs_confirmation" | "no_major_findings",',
  );
  lines.push('  "findings": [');
  lines.push('    {');
  lines.push('      "id": "f-001",');
  lines.push('      "title": "簡潔なタイトル",');
  lines.push('      "severity": "error" | "warning" | "info",');
  lines.push('      "confidence": "high" | "medium" | "low",');
  lines.push('      "file_path": "相対パス",');
  lines.push('      "line_new": 42,');
  lines.push(
    '      "category": "bug" | "security" | "performance" | "design" | "maintainability" | "test" | "validation" | "unused-import" | "missing-import" | "missing-parameter" | "interface-property",',
  );
  lines.push('      "rationale": "指摘理由（根拠明示）",');
  lines.push('      "suggested_fix": "修正案（省略可）",');
  lines.push('      "evidence": "diff本文からの引用",');
  lines.push('      "needsHumanConfirmation": false,');
  lines.push('      "metadata": { "module": "任意" }');
  lines.push('    }');
  lines.push('  ],');
  lines.push('  "summary": "変更の概要と主要な指摘の要約",');
  lines.push('  "next_actions": ["IDEが次にすべきアクション"]');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push('## Git Diff');
  lines.push('');
  lines.push('```diff');
  lines.push(maskedDiff);
  lines.push('```');

  return lines.join('\n');
}

export function buildReviewPromptV1(
  maskedDiff: string,
  projectInfo: ReviewProjectInfo,
  instruction = '',
): string {
  return buildV1Instruction(maskedDiff, projectInfo, instruction);
}

export function buildReviewPromptV2(context: ReviewContextV2): string {
  const parts: string[] = [
    '# Code Review Instructions',
    '',
    'あなたは経験豊富なコードレビュアーです。静的解析と影響範囲解析を最優先で参照してください。',
    '',
    '## プロジェクト情報',
    `- Language: ${context.projectInfo.language}`,
  ];

  if (context.projectInfo.framework) {
    parts.push(`- Framework: ${context.projectInfo.framework}`);
  }

  parts.push('');
  parts.push(buildDiffSummarySection(context));
  parts.push(buildStaticSection(context));
  parts.push(
    context.impactAnalysis
      ? buildImpactSection(context.impactAnalysis)
      : '## 影響範囲解析\n\n（Astmend MCP 未利用）\n',
  );

  if (context.instruction.trim()) {
    parts.push('## レビュー目的');
    parts.push('');
    parts.push(context.instruction.trim());
    parts.push('');
  }

  parts.push('## レビュー優先順位');
  parts.push('');
  parts.push('1. 静的解析結果を最重視する（linter/type checker の指摘は必ず言及）');
  parts.push('2. 影響範囲解析で外部参照が指摘されたシンボルは追従漏れを重点チェック');
  parts.push('3. 事実ベースで差分を見る（推測・仮定を避ける）');
  parts.push('4. 根拠がある指摘だけ返す（diff 本文を引用すること）');
  parts.push('5. 新行番号 line_new が必須（削除行のみへの指摘は不可）');
  parts.push('6. 不確実なものは severity: "info" に下げる');
  parts.push('');
  parts.push('## Git Diff');
  parts.push('');
  parts.push('```diff');
  parts.push(context.rawDiff);
  parts.push('```');
  parts.push('');
  parts.push('[出力は共通基盤の ReviewOutput JSON スキーマに従うこと]');

  return parts.join('\n');
}

export function buildReviewPromptV3(context: ReviewContextV3): string {
  const parts: string[] = [
    '# Code Review Instructions',
    '',
    'あなたは経験豊富なコードレビュアーです。静的解析、影響範囲解析、過去の成功実装（Golden Path）、Guidance を優先順位通りに参照してください。',
    '',
    '## プロジェクト情報',
    `- Language: ${context.projectInfo.language}`,
  ];

  if (context.projectInfo.framework) {
    parts.push(`- Framework: ${context.projectInfo.framework}`);
  }

  parts.push('');
  parts.push(buildDiffSummarySection(context));
  parts.push(buildStaticSection(context));
  parts.push(
    context.impactAnalysis
      ? buildImpactSection(context.impactAnalysis)
      : '## 影響範囲解析\n\n（Astmend MCP 未利用）\n',
  );

  if (context.pastSuccessBenchmarks.length > 0) {
    parts.push('## 過去の成功実装 (Golden Path)');
    parts.push('以下の過去の成功例をベンチマークとして参照し、今回の実装が整合しているか、またはより良いアプローチを選択しているかを確認してください。');
    parts.push('');
    parts.push(...context.pastSuccessBenchmarks.map((entry) => `- ${entry}`));
    parts.push('');
  }

  parts.push(buildGuidanceSection('適用すべき原則 (Principles)', context.recalledPrinciples));
  parts.push(buildGuidanceSection('経験則 (Heuristics)', context.recalledHeuristics));
  parts.push(buildGuidanceSection('再発パターン (Patterns)', context.recalledPatterns));

  if (context.optionalSkills.length > 0) {
    parts.push(buildGuidanceSection('補助スキル (Optional Skills)', context.optionalSkills));
  }

  if (context.pastSimilarFindings.length > 0) {
    parts.push('## 過去の類似指摘 (Failure Cases)');
    parts.push('過去に問題となった以下のケースを回避できているか確認してください。');
    parts.push('');
    parts.push(...context.pastSimilarFindings.map((entry) => `- ${entry}`));
    parts.push('');
  }

  if (context.instruction.trim()) {
    parts.push('## レビュー目的');
    parts.push('');
    parts.push(context.instruction.trim());
    parts.push('');
  }

  parts.push('## レビュー優先順位');
  parts.push('');
  parts.push('1. 静的解析結果を最重視する（linter/type checker の指摘は必ず言及）');
  parts.push('2. 過去の成功実装（Golden Path）をベンチマークとし、ベストプラクティスに従っているか評価する');
  parts.push('3. Guidance の内容は diff と突き合わせて根拠ベースで適用する');
  parts.push('4. 過去の類似指摘（失敗例）は再発防止の観点で参照する');
  parts.push('5. 影響範囲解析で外部参照が指摘されたシンボルは追従漏れを重点チェック');
  parts.push('6. 事実ベースで差分を見る（推測・仮定を避ける）');
  parts.push('7. 根拠がある指摘だけ返す（diff 本文を引用すること）');
  parts.push('8. 新行番号 line_new が必須（削除行のみへの指摘は不可）');
  parts.push('9. 不確実なものは severity: "info" に下げる');
  parts.push('');
  parts.push('## Git Diff');
  parts.push('');
  parts.push('```diff');
  parts.push(context.rawDiff);
  parts.push('```');
  parts.push('');
  parts.push('[出力は共通基盤の ReviewOutput JSON スキーマに従うこと]');

  return parts.join('\n');
}

export function buildReviewPrompt(context: ReviewContextV1 | ReviewContextV2): string {
  if ('recalledPrinciples' in context) {
    return buildReviewPromptV3(context as ReviewContextV3);
  }

  return 'diffSummary' in context
    ? buildReviewPromptV2(context)
    : buildV1Instruction(context.rawDiff, context.projectInfo, context.instruction);
}
