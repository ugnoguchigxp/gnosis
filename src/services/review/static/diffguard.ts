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

  const analysis = Array.isArray(result.analysis?.files) ? result.analysis.files : [];

  return {
    files: analysis.map((file: any) => ({
      filePath: String(file.filePath ?? file.path ?? file.file ?? ''),
      changeTypes: Array.isArray(file.changeTypes) ? file.changeTypes.map(String) : [],
    })),
    inferredFiles: Array.isArray(result.inferredFiles) ? result.inferredFiles.map(String) : [],
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

  const findings = Array.isArray(result?.findings) ? result.findings : [];

  const normalizedFindings: StaticAnalysisFinding[] = [];

  for (const [index, finding] of findings.entries()) {
    const raw = finding as Record<string, unknown>;
    const filePath = String(raw.file ?? raw.path ?? raw.file_path ?? '');
    if (!filePath) continue;

    const normalized: StaticAnalysisFinding = {
      id: typeof raw.id === 'string' && raw.id.trim() ? raw.id : `diffguard-${index + 1}`,
      file_path: filePath,
      line: typeof raw.line === 'number' ? raw.line : Number(raw.line ?? 0),
      severity: mapDiffGuardSeverity(String(raw.level ?? raw.severity ?? 'info')),
      message: String(raw.message ?? ''),
      rule_id:
        typeof raw.ruleId === 'string'
          ? raw.ruleId
          : typeof raw.rule === 'string'
            ? raw.rule
            : undefined,
      source: 'custom',
    };

    normalizedFindings.push(normalized);
  }

  return normalizedFindings;
}
