import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { envBoolean } from '../../config.js';
import { GNOSIS_CONSTANTS } from '../../constants.js';
import {
  agenticSearch,
  buildDoctorRuntimeHealth,
  recordTaskNote,
  resolveStaleMetadataSignal,
  searchKnowledgeV2,
} from '../../services/agentFirst.js';
import { ReviewError } from '../../services/review/errors.js';
import { getReviewLLMService } from '../../services/review/llm/reviewer.js';
import type { ReviewLLMPreference, ReviewLLMService } from '../../services/review/llm/types.js';
import {
  runReviewStageB,
  runReviewStageD,
  runReviewStageE,
} from '../../services/review/orchestrator.js';
import {
  type GuidanceItem,
  KnowledgePolicySchema,
  type ReviewOutput,
  ReviewRequestSchema,
} from '../../services/review/types.js';
import {
  type ReviewDocumentFinding,
  type ReviewDocumentOutput,
  reviewDocument,
} from '../../services/reviewAgent/documentReviewer.js';
import { generateImplementationPlan } from '../../services/specAgent/implementationPlanner.js';
import { analyzePlanAlignment } from '../../services/specAgent/planAlignment.js';
import { analyzeSpecAlignment } from '../../services/specAgent/specAlignment.js';
import type { ToolEntry } from '../registry.js';

const KNOWLEDGE_KINDS = [
  'project_doc',
  'rule',
  'procedure',
  'skill',
  'decision',
  'lesson',
  'observation',
  'risk',
  'command_recipe',
  'reference',
] as const;

const KNOWLEDGE_CATEGORIES = [
  'project_overview',
  'architecture',
  'mcp',
  'memory',
  'workflow',
  'testing',
  'operation',
  'debugging',
  'coding_convention',
  'security',
  'performance',
  'reference',
] as const;

const TASK_CHANGE_TYPES = [
  'frontend',
  'backend',
  'api',
  'auth',
  'db',
  'docs',
  'test',
  'mcp',
  'refactor',
  'config',
  'build',
  'review',
] as const;

const MCP_REVIEW_LLM_TIMEOUT_MS = 90_000;
const MCP_REVIEW_LLM_TIMEOUT_MAX_MS = 105_000;

const initialInstructionsSchema = z.object({});

const searchKnowledgeV2Schema = z.object({
  query: z.string().optional(),
  taskGoal: z
    .string()
    .optional()
    .describe('これから実施する具体的なタスク目的。task_context検索時に推奨。'),
  preset: z
    .enum(['task_context', 'project_characteristics', 'review_context', 'procedures', 'risks'])
    .optional(),
  kinds: z.array(z.enum(KNOWLEDGE_KINDS)).optional(),
  categories: z.array(z.enum(KNOWLEDGE_CATEGORIES)).optional(),
  changeTypes: z.array(z.enum(TASK_CHANGE_TYPES)).optional(),
  technologies: z.array(z.string()).optional(),
  filterMode: z.enum(['and', 'or']).optional(),
  filters: z
    .object({
      kinds: z
        .object({
          mode: z.enum(['and', 'or']).optional(),
          values: z.array(z.enum(KNOWLEDGE_KINDS)),
        })
        .optional(),
      categories: z
        .object({
          mode: z.enum(['and', 'or']).optional(),
          values: z.array(z.enum(KNOWLEDGE_CATEGORIES)),
        })
        .optional(),
      tags: z
        .object({ mode: z.enum(['and', 'or']).optional(), values: z.array(z.string()) })
        .optional(),
      files: z
        .object({ mode: z.enum(['and', 'or']).optional(), values: z.array(z.string()) })
        .optional(),
      relationTypes: z
        .object({ mode: z.enum(['and', 'or']).optional(), values: z.array(z.string()) })
        .optional(),
    })
    .optional(),
  files: z.array(z.string()).optional(),
  intent: z.enum(['plan', 'edit', 'debug', 'review', 'finish']).optional(),
  limitPerCategory: z.number().int().positive().optional(),
  maxCategories: z.number().int().positive().optional(),
  includeContent: z.enum(['summary', 'snippet', 'full']).optional(),
  grouping: z.enum(['by_category', 'flat']).optional(),
  traversal: z
    .object({
      enabled: z.boolean().optional(),
      maxDepth: z.number().int().positive().optional(),
      relationTypes: z.array(z.string()).optional(),
    })
    .optional(),
});

const agenticSearchSchema = z.object({
  userRequest: z.string().min(1).describe('ユーザー依頼または今回のタスク説明'),
  repoPath: z.string().optional(),
  files: z.array(z.string()).optional(),
  changeTypes: z.array(z.enum(TASK_CHANGE_TYPES)).optional(),
  technologies: z.array(z.string()).optional(),
  intent: z.enum(['plan', 'edit', 'debug', 'review', 'finish']).optional(),
  includeRawMemory: z.boolean().optional(),
  maxCandidates: z.number().int().positive().optional(),
  maxReturned: z.number().int().positive().optional(),
  localLlm: z
    .object({
      enabled: z.boolean().optional(),
      required: z.boolean().optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .optional(),
});

const doctorSchema = z.object({
  clientSnapshot: z
    .array(
      z.object({
        name: z.string(),
        schemaHash: z.string().optional(),
        descriptionHash: z.string().optional(),
        schemaVersion: z.string().optional(),
        descriptionVersion: z.string().optional(),
      }),
    )
    .optional()
    .describe('クライアントが保持する tools metadata snapshot'),
});

const recordTaskNoteSchema = z.object({
  taskId: z.string().optional(),
  content: z.string().describe('保存する知見本文'),
  kind: z.enum(KNOWLEDGE_KINDS).optional(),
  category: z.enum(KNOWLEDGE_CATEGORIES).optional(),
  title: z.string().optional(),
  purpose: z.string().optional(),
  tags: z.array(z.string()).optional(),
  evidence: z
    .array(
      z.object({
        type: z.string().optional(),
        value: z.string().optional(),
        uri: z.string().optional(),
      }),
    )
    .optional(),
  files: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  source: z.enum(['manual', 'task', 'review', 'onboarding', 'import']).optional(),
});

const reviewTaskSchema = z.object({
  targetType: z.enum(['code_diff', 'document', 'implementation_plan', 'spec', 'design']),
  target: z.object({
    diff: z.string().optional(),
    filePaths: z.array(z.string()).optional(),
    content: z.string().optional(),
    documentPath: z.string().optional(),
  }),
  provider: z.enum(['local', 'openai', 'bedrock', 'azure-openai']).optional(),
  reviewMode: z.enum(['fast', 'standard', 'deep']).optional(),
  focus: z
    .array(
      z.enum([
        'correctness',
        'security',
        'maintainability',
        'architecture',
        'testability',
        'alignment',
      ]),
    )
    .optional(),
  useKnowledge: z.boolean().optional(),
  maxKnowledgeItems: z.number().int().positive().optional(),
  goal: z.string().optional(),
  repoPath: z.string().optional(),
  knowledgePolicy: KnowledgePolicySchema.optional(),
});

function mapSeverityToReviewTask(severity: string): 'critical' | 'major' | 'minor' | 'info' {
  if (severity === 'error' || severity === 'critical') return 'critical';
  if (severity === 'warning' || severity === 'major') return 'major';
  if (severity === 'minor') return 'minor';
  return 'info';
}

function mapReviewOutputFindings(review: ReviewOutput) {
  return review.findings.map((finding) => ({
    severity: mapSeverityToReviewTask(finding.severity),
    title: finding.title,
    body: finding.rationale,
    file: finding.file_path,
    line: finding.line_new,
    evidence: finding.evidence ? [finding.evidence] : [],
    relatedKnowledge: finding.knowledge_refs ?? [],
  }));
}

type AgenticReviewKnowledge = {
  id: string;
  kind?: string;
  category?: string;
  title: string;
  summary?: string;
  reason?: string;
};

type AgenticFailureFirewallHint = {
  shouldUse: boolean;
  reason: string;
  suggestedUse: string;
  riskSignals: string[];
  goldenPathCandidates: Array<{ id: string; title: string; score: number }>;
  failurePatternCandidates: Array<{
    id: string;
    title: string;
    severity: string;
    score: number;
  }>;
};

function guidanceBucketForAgenticHit(
  hit: AgenticReviewKnowledge,
): 'principle' | 'heuristic' | 'pattern' | 'skill' {
  if (hit.kind === 'rule') return 'principle';
  if (hit.kind === 'procedure' || hit.kind === 'command_recipe' || hit.kind === 'skill') {
    return 'skill';
  }
  if (hit.kind === 'risk' || hit.kind === 'lesson') return 'heuristic';
  return 'pattern';
}

function toGuidanceItemFromAgenticHit(hit: AgenticReviewKnowledge): GuidanceItem {
  const bucket = guidanceBucketForAgenticHit(hit);
  const content = [hit.summary, hit.reason ? `Reason: ${hit.reason}` : undefined]
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .join('\n');
  return {
    id: hit.id,
    title: hit.title,
    content: content || hit.title,
    guidanceType: bucket === 'skill' ? 'skill' : 'rule',
    scope: 'on_demand',
    priority: 0,
    tags: [bucket, hit.kind, hit.category].filter(
      (item): item is string => typeof item === 'string' && item.trim().length > 0,
    ),
  };
}

function buildGuidanceFromAgenticKnowledge(hits: AgenticReviewKnowledge[]) {
  const result = {
    principles: [] as GuidanceItem[],
    heuristics: [] as GuidanceItem[],
    patterns: [] as GuidanceItem[],
    skills: [] as GuidanceItem[],
    benchmarks: [] as string[],
  };

  for (const hit of hits) {
    const item = toGuidanceItemFromAgenticHit(hit);
    const bucket = guidanceBucketForAgenticHit(hit);
    if (bucket === 'principle') result.principles.push(item);
    if (bucket === 'heuristic') result.heuristics.push(item);
    if (bucket === 'pattern') result.patterns.push(item);
    if (bucket === 'skill') result.skills.push(item);
  }

  return result;
}

function formatAgenticKnowledgeContext(hits: AgenticReviewKnowledge[]): string | undefined {
  if (hits.length === 0) return undefined;
  const lines = hits.map((hit) => {
    const label = [hit.kind, hit.category].filter(Boolean).join('/');
    const body = hit.summary ?? hit.reason ?? hit.title;
    return `- ${hit.id}${label ? ` (${label})` : ''}: ${hit.title}\n  ${body}`;
  });
  return `Agentic search selected knowledge:\n${lines.join('\n')}`;
}

function formatFailureFirewallContext(hint?: AgenticFailureFirewallHint): string | undefined {
  if (!hint || !hint.shouldUse) return undefined;
  const goldenPaths = hint.goldenPathCandidates
    .slice(0, 3)
    .map((candidate) => `- ${candidate.id}: ${candidate.title} (${candidate.score})`);
  const failurePatterns = hint.failurePatternCandidates
    .slice(0, 3)
    .map(
      (candidate) =>
        `- ${candidate.id}: ${candidate.title} [${candidate.severity}] (${candidate.score})`,
    );
  return [
    'Optional Failure Firewall / Golden Path context:',
    `Reason: ${hint.reason}`,
    `Suggested use: ${hint.suggestedUse}`,
    `Risk signals: ${hint.riskSignals.join(', ') || '(none)'}`,
    goldenPaths.length > 0 ? `Golden Path candidates:\n${goldenPaths.join('\n')}` : undefined,
    failurePatterns.length > 0
      ? `Failure pattern candidates:\n${failurePatterns.join('\n')}`
      : undefined,
    'Use this only when it is directly relevant to a grounded review finding.',
  ]
    .filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
    .join('\n');
}

function isWithin(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function loadReviewTargetText(
  repoPath: string,
  documentPath?: string,
  content?: string,
): Promise<string> {
  if (typeof content === 'string') return content;
  if (!documentPath) return '';
  const resolved = path.resolve(repoPath, documentPath);
  if (!isWithin(repoPath, resolved)) return '';
  return fs.readFile(resolved, 'utf8').catch(() => '');
}

function mapDocumentFinding(finding: ReviewDocumentFinding, fallbackFile: string) {
  return {
    severity: mapSeverityToReviewTask(finding.severity),
    title: finding.title,
    body: finding.rationale,
    file: fallbackFile,
    line: finding.location?.line,
    evidence: finding.evidence ? [finding.evidence] : [],
    relatedKnowledge: finding.knowledgeRefs ?? [],
  };
}

function getMcpReviewLlmTimeoutMs(): number {
  const raw = process.env.GNOSIS_MCP_REVIEW_LLM_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return MCP_REVIEW_LLM_TIMEOUT_MS;
  return Math.min(parsed, MCP_REVIEW_LLM_TIMEOUT_MAX_MS);
}

async function getMcpReviewLLMService(provider?: ReviewLLMPreference): Promise<ReviewLLMService> {
  return getReviewLLMService(provider, {
    invoker: 'mcp',
    requestId: randomUUID(),
    timeoutMs: getMcpReviewLlmTimeoutMs(),
    disableFallback: true,
  });
}

function getMcpReviewProviderLabel(explicitProvider?: ReviewLLMPreference): ReviewLLMPreference {
  if (explicitProvider === 'openai') return 'azure-openai';
  if (explicitProvider) return explicitProvider;
  const reviewer = process.env.GNOSIS_REVIEWER?.trim().toLowerCase();
  if (reviewer === 'openai') return 'azure-openai';
  if (reviewer === 'bedrock' || reviewer === 'azure-openai') return reviewer;
  if (reviewer === 'gemma4' || reviewer === 'qwen' || reviewer === 'bonsai') return 'local';
  return 'azure-openai';
}

function isMcpReviewUnavailable(error: unknown): boolean {
  if (error instanceof ReviewError) {
    return (
      error.code === 'E006' ||
      error.code === 'E007' ||
      error.code === 'E016' ||
      error.code === 'E017'
    );
  }
  return false;
}

function getReviewErrorCode(error: unknown): string | undefined {
  return error instanceof ReviewError ? error.code : undefined;
}

function buildMcpReviewDegradedDiagnostics(
  providerUsed: ReviewLLMPreference,
  error: unknown,
): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    provider: providerUsed,
    timeoutMs: getMcpReviewLlmTimeoutMs(),
    errorCode: getReviewErrorCode(error),
    degradedReasons: [message],
  };
}

async function reviewDocumentForMcp(
  input: Parameters<typeof reviewDocument>[0],
  llmService: ReviewLLMService,
): Promise<ReviewDocumentOutput> {
  return reviewDocument(input, {
    llmService,
    queryProcedureFn: async () => null,
    recallLessonsFn: async () => [],
    searchMemoryFn: async () => [],
    getAlwaysGuidanceFn: async () => [],
    getOnDemandGuidanceFn: async () => [],
  });
}

export const agentFirstTools: ToolEntry[] = [
  {
    name: 'initial_instructions',
    description: `WHEN TO USE:
- Gnosis の現在の知識取得・レビュー・保存ツール方針を確認したいとき。
DO NOT USE WHEN:
- すでに agentic_search / review_task の使い分けが明確なとき。
WHAT IT RETURNS:
- agentic_search / search_knowledge / review_task / record_task_note / doctor の使い分けガイド。
TYPICAL NEXT TOOL:
- agentic_search`,
    inputSchema: zodToJsonSchema(initialInstructionsSchema) as Record<string, unknown>,
    handler: async () => {
      const payload = {
        defaultKnowledgeTool: 'agentic_search',
        rawSearchTool: 'search_knowledge',
        reviewTool: 'review_task',
        saveKnowledgeTool: 'record_task_note',
        diagnosticTool: 'doctor',
        rules: [
          'Use agentic_search before non-trivial implementation or review when project memory can affect the result.',
          'Use search_knowledge only when inspecting raw lexical/vector candidates.',
          'Use Failure Firewall or Golden Path context only when agentic_search or review judgment indicates it is relevant.',
          'Use record_task_note only for reusable rules, lessons, decisions, risks, procedures, or command recipes.',
          'Before registering implementation learnings with record_task_note, make sure the relevant verify gate has passed.',
          'Before final completion reporting, self-review changed code/docs, fix remaining improvements, then run the relevant verify gate.',
          'Use doctor for runtime and tool visibility diagnostics.',
          'No git/auth/destructive DB actions without explicit user instruction.',
        ],
      };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    },
  },
  {
    name: 'agentic_search',
    description: `WHEN TO USE:
- 非自明な実装・レビュー・調査の前に、今回の依頼に本当に必要なナレッジだけを取得したいとき。
DO NOT USE WHEN:
- raw候補やスコアを確認したいだけのとき（search_knowledgeを使用）。
WHAT IT RETURNS:
- taskSummary、採用済みknowledge、skip/maybe件数、LLM filter診断、nextAction。
TYPICAL NEXT TOOL:
- review_task または通常の実装作業`,
    inputSchema: zodToJsonSchema(agenticSearchSchema) as Record<string, unknown>,
    handler: async (args) => {
      const input = agenticSearchSchema.parse(args);
      const result = await agenticSearch(input);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  },
  {
    name: 'search_knowledge',
    description: `WHEN TO USE:
- 語句・ベクトル・metadataで近い raw 候補やスコアを確認したいとき。
DO NOT USE WHEN:
- 今回の依頼に本当に必要な知識だけを取得したいとき（agentic_searchを使用）。
WHAT IT RETURNS:
- category 別 grouped hits、flatTopHits、reason/snippet/matchSources を含む explainable 結果。
TYPICAL NEXT TOOL:
- agentic_search または review_task`,
    inputSchema: zodToJsonSchema(searchKnowledgeV2Schema) as Record<string, unknown>,
    handler: async (args) => {
      const input = searchKnowledgeV2Schema.parse(args);
      const result = await searchKnowledgeV2(input);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  },
  {
    name: 'record_task_note',
    description: `WHEN TO USE:
- 作業中に再利用可能な知見を保存したいとき。
DO NOT USE WHEN:
- 完了ログや一時的な進捗だけを保存したいとき。
WHAT IT RETURNS:
- 保存結果（entityId/slug/kind/category/enrichmentState）。
TYPICAL NEXT TOOL:
- agentic_search`,
    inputSchema: zodToJsonSchema(recordTaskNoteSchema) as Record<string, unknown>,
    handler: async (args) => {
      const input = recordTaskNoteSchema.parse(args);
      const result = await recordTaskNote(input);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  },
  {
    name: 'review_task',
    description: `WHEN TO USE:
- code/document/spec/plan/design のレビューを knowledge 注入付きで実行したいとき。
DO NOT USE WHEN:
- 単純な構文チェックのみで、LLM レビュー自体が不要なとき。
WHAT IT RETURNS:
- providerUsed、knowledgeUsed、findings、summary、suggestedNotes。
TYPICAL NEXT TOOL:
- record_task_note`,
    inputSchema: zodToJsonSchema(reviewTaskSchema) as Record<string, unknown>,
    handler: async (args) => {
      const input = reviewTaskSchema.parse(args);
      if (
        input.targetType === 'code_diff' &&
        !input.target.diff &&
        !(input.target.filePaths && input.target.filePaths.length > 0)
      ) {
        return {
          content: [
            {
              type: 'text',
              text: 'review_task(code_diff) requires target.diff or target.filePaths.',
            },
          ],
          isError: true,
        };
      }
      if (input.targetType !== 'code_diff' && !input.target.content && !input.target.documentPath) {
        return {
          content: [
            {
              type: 'text',
              text: 'review_task(document/spec/design/implementation_plan) requires target.content or target.documentPath.',
            },
          ],
          isError: true,
        };
      }
      const useKnowledge = input.knowledgePolicy === 'off' ? false : input.useKnowledge ?? true;
      const seed = [
        input.target.diff,
        input.target.content,
        ...(input.target.filePaths ?? []),
        ...(input.focus ?? []),
      ]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join('\n');
      const retrieval = useKnowledge
        ? await agenticSearch({
            userRequest: (input.goal ?? seed) || 'Review current changes',
            repoPath: input.repoPath,
            files: input.target.filePaths,
            changeTypes: ['review'],
            intent: 'review',
            includeRawMemory: false,
            maxCandidates: Math.max(8, input.maxKnowledgeItems ?? 6),
            maxReturned: input.maxKnowledgeItems ?? 6,
          })
        : { usedKnowledge: [] };
      if (
        useKnowledge &&
        input.knowledgePolicy === 'required' &&
        'decision' in retrieval &&
        retrieval.decision === 'degraded'
      ) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  providerUsed: getMcpReviewProviderLabel(input.provider),
                  knowledgeUsed: [],
                  findings: [],
                  summary: 'Knowledge retrieval degraded before review.',
                  diagnostics: retrieval.diagnostics,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
      const selectedKnowledge = (retrieval.usedKnowledge ?? []) as AgenticReviewKnowledge[];
      const failureFirewallHint =
        'failureFirewall' in retrieval
          ? (retrieval as { failureFirewall?: AgenticFailureFirewallHint }).failureFirewall ??
            undefined
          : undefined;
      const agenticGuidance = buildGuidanceFromAgenticKnowledge(selectedKnowledge);
      const agenticKnowledgeContext = formatAgenticKnowledgeContext(selectedKnowledge);
      const failureFirewallContext = formatFailureFirewallContext(failureFirewallHint);
      const knowledgeUsed = selectedKnowledge.map((hit) => ({
        slug: hit.id,
        kind: hit.kind,
        category: hit.category,
        title: hit.title,
        reason: hit.reason,
      }));
      const reviewGoal = [input.goal, agenticKnowledgeContext, failureFirewallContext]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join('\n\n');

      const providerUsed = getMcpReviewProviderLabel(input.provider);
      const llmPreference =
        input.provider === 'openai'
          ? 'azure-openai'
          : input.provider === 'local'
            ? 'local'
            : input.provider;
      let findings: Array<{
        severity: 'critical' | 'major' | 'minor' | 'info';
        title: string;
        body: string;
        file?: string;
        line?: number;
        evidence?: string[];
        relatedKnowledge?: string[];
      }> = [];
      let summary = '';
      let diagnostics: Record<string, unknown> | undefined;

      try {
        if (input.targetType === 'code_diff') {
          const request = ReviewRequestSchema.parse({
            taskId: `review-task-${Date.now()}`,
            repoPath: input.repoPath ?? process.cwd(),
            baseRef: 'main',
            headRef: 'HEAD',
            trigger: 'manual',
            sessionId: `review-task-${Date.now()}`,
            mode: 'worktree',
            taskGoal: reviewGoal || input.target.content || 'Review current code changes',
            changedFiles: input.target.filePaths,
            knowledgePolicy: useKnowledge ? input.knowledgePolicy ?? 'required' : 'off',
          });
          const llmService = await getMcpReviewLLMService(llmPreference);
          const reviewDeps = {
            llmService,
            retrieveGuidanceFn: async () => agenticGuidance,
            searchSimilarFindingsFn: async () => [],
          };
          const stage = input.reviewMode ?? 'standard';
          const reviewResult =
            stage === 'fast'
              ? await runReviewStageB(request, reviewDeps)
              : stage === 'deep'
                ? await runReviewStageE(request, reviewDeps)
                : await runReviewStageD(request, reviewDeps);
          findings = mapReviewOutputFindings(reviewResult);
          summary = reviewResult.summary;
        } else if (input.targetType === 'implementation_plan') {
          const repoPath = input.repoPath ?? process.cwd();
          const llmService = await getMcpReviewLLMService(llmPreference);
          const referencePlan = useKnowledge
            ? await generateImplementationPlan({
                goal: input.goal ?? 'Review implementation plan',
                includeLessons: true,
              })
            : null;
          const mergedContext = [
            input.goal,
            agenticKnowledgeContext,
            input.target.content,
            referencePlan?.markdown
              ? `Reference plan generated from procedural memory:\n${referencePlan.markdown}`
              : undefined,
            'Review policy: focus on missing Golden Path steps and missing mitigation for caution tasks.',
          ]
            .filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
            .join('\n\n');
          const review = await reviewDocumentForMcp(
            {
              repoPath,
              documentPath: input.target.documentPath,
              content: input.target.content,
              documentType: 'plan',
              goal: input.goal ?? 'Review implementation plan',
              context: mergedContext,
              llmPreference,
            },
            llmService,
          );
          const planText = await loadReviewTargetText(
            repoPath,
            input.target.documentPath,
            input.target.content,
          );
          const alignment = referencePlan ? analyzePlanAlignment(planText, referencePlan) : null;
          const mergedFindings = [...(alignment?.findings ?? []), ...review.findings].filter(
            (finding, index, all) => {
              const key = `${finding.title}:${finding.rationale}`;
              return all.findIndex((item) => `${item.title}:${item.rationale}` === key) === index;
            },
          );
          findings = mergedFindings.map((finding) =>
            mapDocumentFinding(finding, input.target.documentPath ?? 'inline:implementation_plan'),
          );
          summary = review.summary;
        } else if (input.targetType === 'spec') {
          const repoPath = input.repoPath ?? process.cwd();
          const llmService = await getMcpReviewLLMService(llmPreference);
          const referencePlan = useKnowledge
            ? await generateImplementationPlan({
                goal: input.goal ?? 'Review specification',
                includeLessons: false,
              })
            : null;
          const mergedContext = [
            input.goal,
            agenticKnowledgeContext,
            input.target.content,
            referencePlan?.markdown
              ? `Reference plan generated from procedural memory:\n${referencePlan.markdown}`
              : undefined,
            'Review policy: verify requirement clarity, acceptance criteria, and Golden Path coverage.',
          ]
            .filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
            .join('\n\n');
          const review = await reviewDocumentForMcp(
            {
              repoPath,
              documentPath: input.target.documentPath,
              content: input.target.content,
              documentType: 'spec',
              goal: input.goal ?? 'Review specification',
              context: mergedContext,
              llmPreference,
            },
            llmService,
          );
          const specText = await loadReviewTargetText(
            repoPath,
            input.target.documentPath,
            input.target.content,
          );
          const alignment = analyzeSpecAlignment(specText, referencePlan);
          const mergedFindings = [...alignment.findings, ...review.findings].filter(
            (finding, index, all) => {
              const key = `${finding.title}:${finding.rationale}`;
              return all.findIndex((item) => `${item.title}:${item.rationale}` === key) === index;
            },
          );
          findings = mergedFindings.map((finding) =>
            mapDocumentFinding(finding, input.target.documentPath ?? 'inline:spec_document'),
          );
          summary = review.summary;
        } else {
          const repoPath = input.repoPath ?? process.cwd();
          const llmService = await getMcpReviewLLMService(llmPreference);
          const documentType = input.targetType === 'design' ? 'plan' : 'spec';
          const review = await reviewDocumentForMcp(
            {
              repoPath,
              documentPath: input.target.documentPath,
              content: input.target.content,
              documentType,
              goal: input.goal,
              context: agenticKnowledgeContext,
              llmPreference,
            },
            llmService,
          );
          findings = review.findings.map((finding) =>
            mapDocumentFinding(
              finding,
              input.target.documentPath ??
                `inline:${input.targetType === 'design' ? 'plan' : 'spec'}`,
            ),
          );
          summary = review.summary;
        }
      } catch (error) {
        if (!isMcpReviewUnavailable(error)) throw error;
        diagnostics = buildMcpReviewDegradedDiagnostics(providerUsed, error);
        summary = `LLM review degraded: ${error instanceof Error ? error.message : String(error)}`;
        findings = [];
      }

      const suggestedNotes = findings.slice(0, 3).map((finding, index) => ({
        kind: 'lesson',
        category: 'workflow',
        title: `review-finding-${index + 1}: ${finding.title}`,
        purpose: 'Capture reusable review feedback for future tasks.',
        content: `${finding.title}\n${finding.body}`,
      }));

      const result = {
        providerUsed,
        knowledgeUsed,
        ...(failureFirewallHint ? { failureFirewall: failureFirewallHint } : {}),
        findings,
        summary,
        suggestedNotes,
        ...(diagnostics ? { diagnostics } : {}),
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  },
  {
    name: 'doctor',
    description: `WHEN TO USE:
- MCP runtime 健全性、tool visibility、stale metadata 疑いを診断したいとき。
DO NOT USE WHEN:
- 取得済みの診断結果が直近で、再診断が不要なとき。
WHAT IT RETURNS:
- runtime/toolVisibility/db/knowledgeIndex/staleMetadata の診断結果と evidence。
TYPICAL NEXT TOOL:
- agentic_search`,
    inputSchema: zodToJsonSchema(doctorSchema) as Record<string, unknown>,
    handler: async (args) => {
      const { clientSnapshot } = doctorSchema.parse(args);
      const staleMetadata = await resolveStaleMetadataSignal(clientSnapshot);
      const exposedToolNames = (
        ((globalThis as Record<string, unknown>).__GNOSIS_EXPOSED_TOOL_NAMES as
          | string[]
          | undefined) ?? []
      ).filter((name) => typeof name === 'string');
      const runtimeHealth = await buildDoctorRuntimeHealth(exposedToolNames);
      const result = {
        runtime: {
          automation: envBoolean(
            process.env.GNOSIS_ENABLE_AUTOMATION,
            GNOSIS_CONSTANTS.AUTOMATION_ENABLED_DEFAULT,
          )
            ? ('enabled' as const)
            : ('disabled' as const),
          cwd: process.cwd(),
        },
        toolVisibility: runtimeHealth.toolVisibility,
        db: runtimeHealth.db,
        knowledgeIndex: runtimeHealth.knowledgeIndex,
        staleMetadata,
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  },
];
