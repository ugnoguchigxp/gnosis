import type {
  ReviewDocumentFinding,
  ReviewDocumentStatus,
} from '../reviewAgent/documentReviewer.js';
import type { GeneratedImplementationPlan } from './implementationPlanner.js';

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function includesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function containsTask(text: string, taskName: string): boolean {
  return normalizeText(text).includes(normalizeText(taskName));
}

function deriveStatus(findings: ReviewDocumentFinding[]): ReviewDocumentStatus {
  if (findings.some((finding) => finding.severity === 'error')) return 'changes_requested';
  if (findings.some((finding) => finding.severity === 'warning')) return 'needs_confirmation';
  return 'no_major_findings';
}

export function analyzeSpecAlignment(
  specText: string,
  referencePlan: GeneratedImplementationPlan | null,
): { findings: ReviewDocumentFinding[]; status: ReviewDocumentStatus } {
  const findings: ReviewDocumentFinding[] = [];
  const normalized = normalizeText(specText);

  if (!includesAny(normalized, [/\brequirements?\b/, /要件/])) {
    findings.push({
      title: 'Missing Requirements Section',
      severity: 'warning',
      confidence: 'high',
      category: 'missing_requirement',
      rationale: '仕様書に要件セクションが見当たらず、意図と範囲の確認が困難です。',
      suggestedFix: '「要件 / Requirements」セクションを追加してください。',
      evidence: 'requirements section not detected',
    });
  }

  if (!includesAny(normalized, [/\bacceptance\b/, /受け入れ/, /検証/, /\btest/])) {
    findings.push({
      title: 'Missing Acceptance Criteria',
      severity: 'warning',
      confidence: 'medium',
      category: 'testability',
      rationale: '受け入れ条件または検証方法の記述が不足しており、レビュー後の判定が曖昧です。',
      suggestedFix: '各主要要件に対する acceptance criteria を追加してください。',
      evidence: 'acceptance/test keywords not detected',
    });
  }

  if (referencePlan) {
    for (const task of referencePlan.tasks.filter((item) => item.isGoldenPath)) {
      if (containsTask(specText, task.name)) continue;
      findings.push({
        title: `Spec Missing Golden Path Concern: ${task.name}`,
        severity: 'info',
        confidence: 'medium',
        category: 'missing_requirement',
        rationale:
          '手続き記憶上の Golden Path タスクに対応する記述が仕様書に不足している可能性があります。',
        suggestedFix: `仕様書に "${task.name}" に関する要件または設計意図を追記してください。`,
        evidence: `reference_task_id=${task.id}, confidence=${task.confidence.toFixed(2)}`,
      });
    }
  }

  return {
    findings,
    status: deriveStatus(findings),
  };
}
