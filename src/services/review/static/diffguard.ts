import { type ReviewMcpToolCaller, callReviewMcpTool } from '../mcp/caller.js';
import type { StaticAnalysisFinding } from '../types.js';

export interface DiffGuardAnalysis {
  files: { filePath: string; changeTypes: string[] }[];
  inferredFiles: string[];
}

function mapDiffGuardSeverity(level: string): StaticAnalysisFinding['severity'] {
  if (level === 'error') return 'error';
  if (level === 'warn' || level === 'warning') return 'warning';
  return 'info';
}

export async function analyzeDiffWithDiffGuard(
  unifiedDiff: string,
  caller?: ReviewMcpToolCaller,
): Promise<DiffGuardAnalysis | null> {
  const result = await callReviewMcpTool<any>(caller, 'mcp_diffguard_analyze_diff', {
    diff: unifiedDiff,
  });

  if (!result) return null;

  const files: DiffGuardAnalysis['files'] = [];
  const rawFiles = Array.isArray(result?.analysis?.files) ? (result.analysis.files as any[]) : [];
  for (const file of rawFiles) {
    files.push({
      filePath: String(file?.filePath ?? file?.path ?? file?.file ?? ''),
      changeTypes: Array.isArray(file?.changeTypes) ? file.changeTypes.map(String) : [],
    });
  }

  return {
    files,
    inferredFiles: Array.isArray(result?.inferredFiles) ? result.inferredFiles.map(String) : [],
  };
}

export async function runDiffGuard(
  unifiedDiff: string,
  projectRoot: string,
  caller?: ReviewMcpToolCaller,
): Promise<StaticAnalysisFinding[]> {
  const result = await callReviewMcpTool<any>(caller, 'mcp_diffguard_review_diff', {
    diff: unifiedDiff,
    workspaceRoot: projectRoot,
    enableLlm: false,
    format: 'json',
  });

  const rawFindings = Array.isArray(result?.findings) ? (result.findings as any[]) : [];
  const normalizedFindings: StaticAnalysisFinding[] = [];

  for (let index = 0; index < rawFindings.length; index++) {
    const finding = rawFindings[index] as Record<string, unknown>;
    const filePath = String(finding.file ?? finding.path ?? finding.file_path ?? '');
    if (!filePath) continue;

    normalizedFindings.push({
      id:
        typeof finding.id === 'string' && finding.id.trim() ? finding.id : `diffguard-${index + 1}`,
      file_path: filePath,
      line: typeof finding.line === 'number' ? finding.line : Number(finding.line ?? 0),
      severity: mapDiffGuardSeverity(String(finding.level ?? finding.severity ?? 'info')),
      message: String(finding.message ?? ''),
      rule_id:
        typeof finding.ruleId === 'string'
          ? finding.ruleId
          : typeof finding.rule === 'string'
            ? finding.rule
            : undefined,
      source: 'rule_engine',
    });
  }

  return normalizedFindings;
}
