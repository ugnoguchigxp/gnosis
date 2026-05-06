import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { recallExperienceLessons } from '../experience.js';
import { getAlwaysOnGuidance, getOnDemandGuidance } from '../guidance/search.js';
import { searchMemory } from '../memory.js';
import { type ProcedureResult, queryProcedure } from '../procedure.js';
import { ReviewError } from '../review/errors.js';
import { validateAllowedRoot } from '../review/foundation/allowedRoots.js';
import { validateSessionId } from '../review/foundation/sessionId.js';
import { getReviewLLMService } from '../review/llm/reviewer.js';
import type { ReviewLLMPreference, ReviewLLMService } from '../review/llm/types.js';

const MAX_DOCUMENT_BYTES = 200 * 1024;
const MAX_DOCUMENT_CHUNKS = 24;
const MAX_INPUT_TOKENS_PER_CHUNK = 3_000;
const DOCUMENT_REVIEW_TIMEOUT_MS = 180_000;
const LESSON_LIMIT = 5;
const MEMORY_LIMIT = 5;
const GUIDANCE_LIMIT = 8;

const DOCUMENT_CATEGORY_SET = new Set([
  'ambiguity',
  'missing_requirement',
  'inconsistency',
  'risk',
  'testability',
  'operability',
  'security',
  'maintainability',
] as const);

type DocumentFindingCategory =
  | 'ambiguity'
  | 'missing_requirement'
  | 'inconsistency'
  | 'risk'
  | 'testability'
  | 'operability'
  | 'security'
  | 'maintainability';

export type ReviewDocumentType = 'spec' | 'plan';
export type ReviewDocumentStatus = 'changes_requested' | 'needs_confirmation' | 'no_major_findings';

export interface ReviewDocumentFinding {
  title: string;
  severity: 'error' | 'warning' | 'info';
  confidence: 'high' | 'medium' | 'low';
  location?: { section?: string; line?: number };
  category: DocumentFindingCategory;
  rationale: string;
  suggestedFix?: string;
  evidence?: string;
  knowledgeRefs?: string[];
}

export interface ReviewDocumentOutput {
  reviewId: string;
  documentType: ReviewDocumentType;
  status: ReviewDocumentStatus;
  findings: ReviewDocumentFinding[];
  summary: string;
  nextActions: string[];
  appliedContext: {
    procedureIds: string[];
    lessonIds: string[];
    guidanceIds: string[];
    memoryIds: string[];
  };
  guidanceCandidates?: Array<{
    title: string;
    content: string;
    guidanceType: 'rule' | 'skill';
    scope: 'always' | 'on_demand';
  }>;
  markdown: string;
}

export interface ReviewDocumentInput {
  repoPath: string;
  documentPath?: string;
  content?: string;
  documentType: ReviewDocumentType;
  goal?: string;
  context?: string;
  sessionId?: string;
  llmPreference?: ReviewLLMPreference;
}

type ReviewDocumentDeps = {
  readFile?: (filePath: string) => Promise<string>;
  llmService?: ReviewLLMService;
  now?: () => number;
  queryProcedureFn?: typeof queryProcedure;
  recallLessonsFn?: typeof recallExperienceLessons;
  searchMemoryFn?: typeof searchMemory;
  getAlwaysGuidanceFn?: typeof getAlwaysOnGuidance;
  getOnDemandGuidanceFn?: typeof getOnDemandGuidance;
  timeoutMs?: number;
};

function deriveRepoKey(repoPath: string): string {
  return repoPath.replace(/[^a-zA-Z0-9_:-]/g, '-').replace(/-+/g, '-');
}

function resolveSessionId(repoPath: string, provided?: string): string {
  if (provided?.trim()) return provided.trim();
  return `review-doc:${deriveRepoKey(repoPath)}`;
}

function isWithin(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function splitIntoChunks(content: string): string[] {
  const lines = content.split('\n');
  const chunks: string[] = [];
  let buffer: string[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    chunks.push(buffer.join('\n'));
    buffer = [];
  };

  for (const line of lines) {
    const candidate = buffer.length === 0 ? line : `${buffer.join('\n')}\n${line}`;
    if (estimateTokens(candidate) <= MAX_INPUT_TOKENS_PER_CHUNK) {
      buffer.push(line);
      continue;
    }
    flush();
    if (estimateTokens(line) <= MAX_INPUT_TOKENS_PER_CHUNK) {
      buffer.push(line);
      continue;
    }

    const sliceChars = MAX_INPUT_TOKENS_PER_CHUNK * 4;
    for (let start = 0; start < line.length; start += sliceChars) {
      chunks.push(line.slice(start, start + sliceChars));
    }
  }
  flush();

  if (chunks.length > MAX_DOCUMENT_CHUNKS) {
    throw new ReviewError(
      'E015',
      `Document requires too many chunks (${chunks.length}, limit: ${MAX_DOCUMENT_CHUNKS})`,
    );
  }

  return chunks.length > 0 ? chunks : [''];
}

function normalizeCategory(value: unknown): DocumentFindingCategory {
  if (typeof value !== 'string') return 'maintainability';
  return DOCUMENT_CATEGORY_SET.has(value as DocumentFindingCategory)
    ? (value as DocumentFindingCategory)
    : 'maintainability';
}

function normalizeSeverity(value: unknown): 'error' | 'warning' | 'info' {
  if (value === 'error' || value === 'warning' || value === 'info') return value;
  return 'warning';
}

function normalizeConfidence(value: unknown): 'high' | 'medium' | 'low' {
  if (value === 'high' || value === 'medium' || value === 'low') return value;
  return 'low';
}

function normalizeFindings(raw: unknown): ReviewDocumentFinding[] {
  if (!Array.isArray(raw)) return [];
  const findings: ReviewDocumentFinding[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.title !== 'string' || candidate.title.trim().length === 0) continue;
    if (typeof candidate.rationale !== 'string' || candidate.rationale.trim().length === 0)
      continue;

    const location =
      candidate.location && typeof candidate.location === 'object'
        ? {
            section:
              typeof (candidate.location as Record<string, unknown>).section === 'string'
                ? ((candidate.location as Record<string, unknown>).section as string)
                : undefined,
            line:
              typeof (candidate.location as Record<string, unknown>).line === 'number'
                ? ((candidate.location as Record<string, unknown>).line as number)
                : undefined,
          }
        : undefined;

    findings.push({
      title: candidate.title.trim(),
      severity: normalizeSeverity(candidate.severity),
      confidence: normalizeConfidence(candidate.confidence),
      category: normalizeCategory(candidate.category),
      rationale: candidate.rationale.trim(),
      suggestedFix:
        typeof candidate.suggestedFix === 'string' && candidate.suggestedFix.trim().length > 0
          ? candidate.suggestedFix.trim()
          : undefined,
      evidence:
        typeof candidate.evidence === 'string' && candidate.evidence.trim().length > 0
          ? candidate.evidence.trim()
          : undefined,
      knowledgeRefs: Array.isArray(candidate.knowledgeRefs)
        ? candidate.knowledgeRefs.filter((v): v is string => typeof v === 'string')
        : undefined,
      location,
    });
  }
  return findings;
}

function deriveStatus(findings: ReviewDocumentFinding[]): ReviewDocumentStatus {
  if (findings.some((finding) => finding.severity === 'error')) return 'changes_requested';
  if (findings.some((finding) => finding.severity === 'warning')) return 'needs_confirmation';
  return 'no_major_findings';
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ReviewError('E016', `Document review timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function loadDocumentContent(
  input: ReviewDocumentInput,
  readFile: (filePath: string) => Promise<string>,
): Promise<{ content: string; documentPath?: string; repoPath: string }> {
  const hasPath = typeof input.documentPath === 'string' && input.documentPath.trim().length > 0;
  const hasContent = typeof input.content === 'string' && input.content.length > 0;
  if ((hasPath && hasContent) || (!hasPath && !hasContent)) {
    throw new ReviewError('E013', 'Either documentPath or content must be provided exclusively.');
  }

  const repoPath = path.resolve(input.repoPath || process.cwd());
  validateAllowedRoot(repoPath);

  if (hasContent) {
    return { content: input.content ?? '', repoPath };
  }

  const relativePath = input.documentPath?.trim() ?? '';
  const fullPath = path.resolve(repoPath, relativePath);
  if (!isWithin(repoPath, fullPath)) {
    throw new ReviewError('E014', `documentPath must be inside repoPath: ${relativePath}`);
  }

  try {
    const content = await readFile(fullPath);
    return { content, documentPath: relativePath, repoPath };
  } catch (error) {
    throw new ReviewError(
      'E014',
      `Failed to read documentPath "${relativePath}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function reviewDocument(
  input: ReviewDocumentInput,
  deps: ReviewDocumentDeps = {},
): Promise<ReviewDocumentOutput> {
  const now = deps.now ?? Date.now;
  const startAt = now();
  const readFile = deps.readFile ?? ((filePath: string) => fs.readFile(filePath, 'utf8'));
  const timeoutMs = deps.timeoutMs ?? DOCUMENT_REVIEW_TIMEOUT_MS;

  return withTimeout(
    (async () => {
      const loaded = await loadDocumentContent(input, readFile);
      const contentBytes = Buffer.byteLength(loaded.content, 'utf8');
      if (contentBytes > MAX_DOCUMENT_BYTES) {
        throw new ReviewError(
          'E015',
          `Document size exceeded: ${contentBytes} bytes (limit: ${MAX_DOCUMENT_BYTES})`,
        );
      }

      const chunks = splitIntoChunks(loaded.content);
      const sessionId = resolveSessionId(loaded.repoPath, input.sessionId);
      validateSessionId(sessionId);
      const querySeed = `${input.goal ?? `${input.documentType} review`}\n${input.context ?? ''}\n${
        chunks[0]?.slice(0, 1_000) ?? ''
      }`.trim();

      const queryProcedureFn = deps.queryProcedureFn ?? queryProcedure;
      const recallLessonsFn = deps.recallLessonsFn ?? recallExperienceLessons;
      const searchMemoryFn = deps.searchMemoryFn ?? searchMemory;
      const getAlwaysGuidanceFn = deps.getAlwaysGuidanceFn ?? getAlwaysOnGuidance;
      const getOnDemandGuidanceFn = deps.getOnDemandGuidanceFn ?? getOnDemandGuidance;

      const [procedure, lessons, memories, alwaysGuidance, onDemandGuidance] = await Promise.all([
        queryProcedureFn(input.goal ?? `${input.documentType} review`, {
          context: input.context,
          project: path.basename(loaded.repoPath),
          domains: ['planning'],
          languages: ['markdown'],
          repo: loaded.repoPath,
        }).catch(() => null),
        recallLessonsFn(sessionId, querySeed, LESSON_LIMIT).catch(() => []),
        searchMemoryFn(sessionId, querySeed, MEMORY_LIMIT).catch(() => []),
        getAlwaysGuidanceFn(GUIDANCE_LIMIT, sessionId).catch(() => []),
        getOnDemandGuidanceFn(querySeed, GUIDANCE_LIMIT, undefined, sessionId).catch(() => []),
      ]);

      const llmService =
        deps.llmService ?? (await getReviewLLMService(input.llmPreference, { invoker: 'service' }));
      const prompt = buildDocumentReviewPrompt({
        documentType: input.documentType,
        goal: input.goal,
        context: input.context,
        documentPath: loaded.documentPath,
        chunks,
        procedure,
        lessons,
        memories,
        alwaysGuidance,
        onDemandGuidance,
      });

      let rawOutput: string;
      try {
        rawOutput = await llmService.generate(prompt, { format: 'json' });
      } catch (error) {
        if (error instanceof ReviewError && error.code === 'E006') throw error;
        throw new ReviewError(
          'E017',
          `Document review LLM call failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(rawOutput.trim()) as Record<string, unknown>;
      } catch {
        throw new ReviewError('E017', 'Document review LLM returned non-JSON payload');
      }

      const findings = normalizeFindings(parsed.findings);
      const summary =
        typeof parsed.summary === 'string' && parsed.summary.trim().length > 0
          ? parsed.summary.trim()
          : `Document review completed (${input.documentType}).`;
      const nextActions = Array.isArray(parsed.nextActions)
        ? parsed.nextActions.filter(
            (v): v is string => typeof v === 'string' && v.trim().length > 0,
          )
        : [];
      const guidanceCandidates = Array.isArray(parsed.guidanceCandidates)
        ? parsed.guidanceCandidates
            .map((item) => {
              if (!item || typeof item !== 'object') return null;
              const raw = item as Record<string, unknown>;
              if (
                typeof raw.title !== 'string' ||
                typeof raw.content !== 'string' ||
                (raw.guidanceType !== 'rule' && raw.guidanceType !== 'skill') ||
                (raw.scope !== 'always' && raw.scope !== 'on_demand')
              ) {
                return null;
              }
              return {
                title: raw.title,
                content: raw.content,
                guidanceType: raw.guidanceType,
                scope: raw.scope,
              };
            })
            .filter(
              (
                item,
              ): item is {
                title: string;
                content: string;
                guidanceType: 'rule' | 'skill';
                scope: 'always' | 'on_demand';
              } => item !== null,
            )
        : undefined;

      const result: ReviewDocumentOutput = {
        reviewId: randomUUID(),
        documentType: input.documentType,
        status: deriveStatus(findings),
        findings,
        summary,
        nextActions,
        appliedContext: {
          procedureIds: collectProcedureIds(procedure),
          lessonIds: lessons.map((l) => l.failure.id),
          guidanceIds: [...alwaysGuidance, ...onDemandGuidance]
            .map((g) => (typeof g.id === 'string' ? g.id : undefined))
            .filter((id): id is string => typeof id === 'string' && id.length > 0),
          memoryIds: memories.map((m) => m.id),
        },
        guidanceCandidates,
        markdown: '',
      };
      result.markdown = renderDocumentReviewMarkdown(result);

      // Keep a minimal execution marker for traceability in findings metadata.
      if (findings.length > 0) {
        const knowledgeRefs = [
          ...result.appliedContext.procedureIds,
          ...result.appliedContext.lessonIds,
          ...result.appliedContext.guidanceIds,
          ...result.appliedContext.memoryIds,
        ];
        for (const finding of result.findings) {
          if (!finding.knowledgeRefs || finding.knowledgeRefs.length === 0) {
            finding.knowledgeRefs = knowledgeRefs.slice(0, 5);
          }
        }
      }

      void startAt; // currently reserved for future telemetry.
      return result;
    })(),
    timeoutMs,
  );
}

function collectProcedureIds(procedure: ProcedureResult | null): string[] {
  if (!procedure) return [];
  const ids = new Set<string>([procedure.goal.id]);
  for (const task of procedure.tasks) ids.add(task.id);
  for (const constraint of procedure.constraints) ids.add(constraint.id);
  return [...ids];
}

function buildDocumentReviewPrompt(input: {
  documentType: ReviewDocumentType;
  goal?: string;
  context?: string;
  documentPath?: string;
  chunks: string[];
  procedure: ProcedureResult | null;
  lessons: Awaited<ReturnType<typeof recallExperienceLessons>>;
  memories: Awaited<ReturnType<typeof searchMemory>>;
  alwaysGuidance: Awaited<ReturnType<typeof getAlwaysOnGuidance>>;
  onDemandGuidance: Awaited<ReturnType<typeof getOnDemandGuidance>>;
}): string {
  const criteria =
    input.documentType === 'spec'
      ? ['要件の明確性と実装可能性', '受け入れ条件の検証可能性', 'セキュリティ/運用/移行の抜け漏れ']
      : [
          'タスク分解の粒度と依存関係の妥当性',
          'テスト計画とロールバック計画の有無',
          '高リスク項目の先行検証',
        ];

  const guidanceContext = [...input.alwaysGuidance, ...input.onDemandGuidance]
    .map((g) => g.content)
    .slice(0, 10)
    .join('\n---\n');

  return `
You are a strict ${input.documentType.toUpperCase()} document reviewer.

Goal: ${input.goal ?? `${input.documentType} review`}
Context: ${input.context ?? '(none)'}
Document path: ${input.documentPath ?? '(inline content)'}

Review criteria:
${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Related procedure:
${input.procedure ? JSON.stringify(input.procedure, null, 2) : 'none'}

Related lessons:
${JSON.stringify(input.lessons, null, 2)}

Related memories:
${JSON.stringify(input.memories, null, 2)}

Guidance context:
${guidanceContext || 'none'}

Document chunks:
${input.chunks
  .map((chunk, i) => `--- chunk ${i + 1}/${input.chunks.length} ---\n${chunk}`)
  .join('\n')}

Return JSON ONLY in this format:
{
  "summary": "string",
  "nextActions": ["string"],
  "findings": [
    {
      "title": "string",
      "severity": "error|warning|info",
      "confidence": "high|medium|low",
      "category": "ambiguity|missing_requirement|inconsistency|risk|testability|operability|security|maintainability",
      "location": { "section": "string", "line": 1 },
      "rationale": "string",
      "suggestedFix": "string",
      "evidence": "string",
      "knowledgeRefs": ["id-1","id-2"]
    }
  ],
  "guidanceCandidates": [
    {
      "title": "string",
      "content": "string",
      "guidanceType": "rule|skill",
      "scope": "always|on_demand"
    }
  ]
}`;
}

function renderDocumentReviewMarkdown(result: ReviewDocumentOutput): string {
  const lines: string[] = [];
  lines.push(`# ${result.documentType.toUpperCase()} Review`);
  lines.push('');
  lines.push(`- Status: **${result.status}**`);
  lines.push(`- Findings: ${result.findings.length}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(result.summary || 'No summary');
  lines.push('');

  if (result.findings.length > 0) {
    lines.push('## Findings');
    lines.push('');
    for (const finding of result.findings) {
      lines.push(`### ${finding.title}`);
      lines.push(
        `- Severity: ${finding.severity} | Confidence: ${finding.confidence} | Category: ${finding.category}`,
      );
      if (finding.location?.section || finding.location?.line) {
        lines.push(
          `- Location: section=${finding.location.section ?? '-'}${
            'line' in (finding.location || {}) ? `, line=${finding.location.line ?? '-'}` : ''
          }`,
        );
      }
      lines.push(`- Rationale: ${finding.rationale}`);
      if (finding.suggestedFix) lines.push(`- Suggested Fix: ${finding.suggestedFix}`);
      if (finding.evidence) lines.push(`- Evidence: ${finding.evidence}`);
      lines.push('');
    }
  }

  if (result.nextActions.length > 0) {
    lines.push('## Next Actions');
    lines.push('');
    for (const action of result.nextActions) lines.push(`- ${action}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
