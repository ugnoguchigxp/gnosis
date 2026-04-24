import type {
  ReviewDocumentFinding,
  ReviewDocumentStatus,
} from '../reviewAgent/documentReviewer.js';
import type { GeneratedImplementationPlan } from './implementationPlanner.js';

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function containsTask(planText: string, taskName: string): boolean {
  return normalizeText(planText).includes(normalizeText(taskName));
}

function includesMitigationLanguage(planText: string): boolean {
  const normalized = normalizeText(planText);
  return (
    normalized.includes('mitigation') ||
    normalized.includes('caution') ||
    normalized.includes('対策') ||
    normalized.includes('回避')
  );
}

function deriveStatus(findings: ReviewDocumentFinding[]): ReviewDocumentStatus {
  if (findings.some((finding) => finding.severity === 'error')) return 'changes_requested';
  if (findings.some((finding) => finding.severity === 'warning')) return 'needs_confirmation';
  return 'no_major_findings';
}

export interface PlanAlignmentResult {
  findings: ReviewDocumentFinding[];
  status: ReviewDocumentStatus;
}

export function analyzePlanAlignment(
  planText: string,
  referencePlan: GeneratedImplementationPlan,
): PlanAlignmentResult {
  const findings: ReviewDocumentFinding[] = [];

  for (const task of referencePlan.tasks.filter((item) => item.isGoldenPath)) {
    if (containsTask(planText, task.name)) continue;
    findings.push({
      title: `Missing Golden Path Task: ${task.name}`,
      severity: 'warning',
      confidence: 'high',
      category: 'missing_requirement',
      rationale: '手続き記憶で高信頼と判定された Golden Path タスクが計画書に見当たりません。',
      suggestedFix: `計画書に "${task.name}" を明示し、受け入れ基準を追加してください。`,
      evidence: `reference_task_id=${task.id}, confidence=${task.confidence.toFixed(2)}`,
    });
  }

  const cautionTaskNames = referencePlan.tasks
    .filter((task) => task.cautionNotes.length > 0)
    .map((task) => task.name);
  if (cautionTaskNames.length > 0) {
    const hasMitigation = includesMitigationLanguage(planText);
    if (!hasMitigation) {
      findings.push({
        title: 'Missing Mitigation Notes For Caution Tasks',
        severity: 'warning',
        confidence: 'medium',
        category: 'risk',
        rationale:
          'followed_failure 履歴があるタスクが存在しますが、計画書に対策や回避方針の記述が不足しています。',
        suggestedFix: `次のタスクに対する mitigation セクションを追加してください: ${cautionTaskNames.join(
          ', ',
        )}`,
        evidence: `caution_tasks=${cautionTaskNames.join(', ')}`,
      });
    }
  }

  return {
    findings,
    status: deriveStatus(findings),
  };
}
