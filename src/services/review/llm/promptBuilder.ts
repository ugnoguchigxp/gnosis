export interface ReviewProjectInfo {
  language: string;
  framework?: string;
}

export function buildReviewPromptV1(
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
  lines.push('1. **事実ベースで差分を見る** — 推測や仮定を避ける');
  lines.push('2. **根拠がある指摘だけ返す** — 具体的な証拠（diff 本文の引用）を示す');
  lines.push('3. **新行番号に紐づかない指摘は返さない** — 必ず `line_new` を指定する');
  lines.push('4. **不確実なものは severity: "info" に下げる** — 断定的な表現を避ける');
  lines.push('5. **「問題なし」とは絶対に言わない** — 指摘がない場合は findings を空にする');
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
    '      "category": "bug" | "security" | "performance" | "design" | "maintainability" | "test" | "validation",',
  );
  lines.push('      "rationale": "指摘理由（根拠明示）",');
  lines.push('      "suggested_fix": "修正案（省略可）",');
  lines.push('      "evidence": "diff本文からの引用",');
  lines.push('      "needsHumanConfirmation": false');
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
