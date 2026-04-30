import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { envBoolean } from '../../config.js';
import { GNOSIS_CONSTANTS } from '../../constants.js';
import { dispatchHookEvent } from '../../hooks/service.js';
import {
  buildActivateProjectResult,
  buildDoctorRuntimeHealth,
  finishTaskTrace,
  recordTaskNote,
  resolveStaleMetadataSignal,
  searchKnowledgeV2,
  startTaskTrace,
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
  'hook',
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

const MCP_REVIEW_LLM_TIMEOUT_MS = 180_000;

const initialInstructionsSchema = z.object({});

const activateProjectSchema = z.object({
  projectRoot: z
    .string()
    .optional()
    .describe('プロジェクトルート。未指定時は現在の作業ディレクトリを使用。'),
  mode: z
    .enum(['planning', 'editing', 'review', 'onboarding', 'no_memory'])
    .optional()
    .describe('現在の作業モード'),
});

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

const startTaskSchema = z.object({
  title: z.string().describe('開始するタスクのタイトル'),
  intent: z.enum(['plan', 'edit', 'debug', 'review', 'finish']).optional(),
  files: z.array(z.string()).optional(),
  projectRoot: z.string().optional(),
  taskId: z.string().optional(),
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
  confidence: z.number().min(0).max(1).optional(),
  source: z.enum(['manual', 'task', 'hook', 'review', 'onboarding', 'import']).optional(),
});

const finishTaskSchema = z.object({
  taskId: z.string(),
  outcome: z.string(),
  checks: z.array(z.string()).optional(),
  followUps: z.array(z.string()).optional(),
  learnedItems: z.array(recordTaskNoteSchema.omit({ taskId: true })).optional(),
});

const reviewTaskSchema = z.object({
  targetType: z.enum(['code_diff', 'document', 'implementation_plan', 'spec', 'design']),
  target: z.object({
    diff: z.string().optional(),
    filePaths: z.array(z.string()).optional(),
    content: z.string().optional(),
    documentPath: z.string().optional(),
  }),
  provider: z.enum(['local', 'openai', 'bedrock']).optional(),
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
  return Math.min(parsed, MCP_REVIEW_LLM_TIMEOUT_MS);
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
  if (explicitProvider) return explicitProvider;
  const reviewer = process.env.GNOSIS_REVIEWER?.trim().toLowerCase();
  if (reviewer === 'bedrock' || reviewer === 'openai') return reviewer;
  if (reviewer === 'gemma4' || reviewer === 'qwen' || reviewer === 'bonsai') return 'local';
  return 'openai';
}

function isDocumentReviewUnavailable(error: unknown): boolean {
  if (error instanceof ReviewError) {
    return error.code === 'E006' || error.code === 'E016' || error.code === 'E017';
  }
  return false;
}

function buildDegradedDocumentReview(
  input: {
    documentType: 'spec' | 'plan';
    documentPath?: string;
  },
  error: unknown,
): ReviewDocumentOutput {
  const message = error instanceof Error ? error.message : String(error);
  return {
    reviewId: randomUUID(),
    documentType: input.documentType,
    status: 'no_major_findings',
    findings: [],
    summary: `LLM document review degraded: ${message}`,
    nextActions: ['Review deterministic alignment findings and retry LLM review if needed.'],
    appliedContext: {
      procedureIds: [],
      lessonIds: [],
      guidanceIds: [],
      memoryIds: [],
    },
    markdown: '',
  };
}

async function reviewDocumentForMcp(
  input: Parameters<typeof reviewDocument>[0],
  llmService: ReviewLLMService,
): Promise<ReviewDocumentOutput> {
  try {
    return await reviewDocument(input, {
      llmService,
      queryProcedureFn: async () => null,
      recallLessonsFn: async () => [],
      searchMemoryFn: async () => [],
      getAlwaysGuidanceFn: async () => [],
      getOnDemandGuidanceFn: async () => [],
    });
  } catch (error) {
    if (!isDocumentReviewUnavailable(error)) throw error;
    return buildDegradedDocumentReview(
      {
        documentType: input.documentType,
        documentPath: input.documentPath,
      },
      error,
    );
  }
}

export const agentFirstTools: ToolEntry[] = [
  {
    name: 'initial_instructions',
    description: `WHEN TO USE:
- セッション開始時に最初の実行手順を確認したいとき。
DO NOT USE WHEN:
- すでに activate_project 済みで task 実行中のとき。
WHAT IT RETURNS:
- firstCall と推奨ワークフローを含むガイド JSON。
TYPICAL NEXT TOOL:
- activate_project`,
    inputSchema: zodToJsonSchema(initialInstructionsSchema) as Record<string, unknown>,
    handler: async () => {
      const payload = {
        firstCall: 'activate_project',
        alwaysRules: [
          'initial_instructions: once per session; again only before review flow.',
          'review_task requires prior initial_instructions.',
          'No git/auth/destructive DB actions without explicit user instruction.',
        ],
        knowledgeLookupDecision: {
          defaultAction: 'skip_search_knowledge',
          useWhen: 'non-trivial edit/review with project-specific uncertainty or repeated failure',
          requiredContext: ['taskGoal', 'files/changeTypes'],
        },
        preImplementationRuleLookup: {
          required: 'conditional',
          tool: 'search_knowledge',
          preset: 'task_context',
        },
        recommendedWorkflow: [
          'activate_project',
          'start_task when editing',
          'finish_task when done',
        ],
        reviewWorkflow: [
          'activate_project(mode=review)',
          'search_knowledge(preset=review_context)',
          'review_task',
        ],
      };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    },
  },
  {
    name: 'activate_project',
    description: `WHEN TO USE:
- 新規セッションの最初の 3 call 以内。必ず最初に近い段階で呼ぶ。
DO NOT USE WHEN:
- project 状態を直前に取得済みで、同一ターンに再取得不要なとき。
WHAT IT RETURNS:
- project/health/onboarding/knowledgeIndex/recommendedNextCalls/instructions。
TYPICAL NEXT TOOL:
- search_knowledge`,
    inputSchema: zodToJsonSchema(activateProjectSchema) as Record<string, unknown>,
    handler: async (args) => {
      const { projectRoot, mode } = activateProjectSchema.parse(args);
      const root = projectRoot ? path.resolve(projectRoot) : process.cwd();
      const payload = await buildActivateProjectResult(root, mode);
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    },
  },
  {
    name: 'search_knowledge',
    description: `WHEN TO USE:
- 非自明な実装・レビュー前に、再利用知識（rule/lesson/procedure/risk 等）が結果を変え得るとき。
DO NOT USE WHEN:
- 単純なTODO作成、状態確認、コマンド出力確認、ローカルファイル確認だけで足りる自己完結タスク。
WHAT IT RETURNS:
- category 別 grouped hits、flatTopHits、reason/snippet/matchSources を含む explainable 結果。
TYPICAL NEXT TOOL:
- start_task または review_task`,
    inputSchema: zodToJsonSchema(searchKnowledgeV2Schema) as Record<string, unknown>,
    handler: async (args) => {
      const input = searchKnowledgeV2Schema.parse(args);
      const result = await searchKnowledgeV2(input);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  },
  {
    name: 'start_task',
    description: `WHEN TO USE:
- 編集・修正・レビュー作業を開始するときに task trace を作成したいとき。
DO NOT USE WHEN:
- 既存 taskId を継続中で、新規 trace を増やしたくないとき。
WHAT IT RETURNS:
- taskId、status、activationWarning、recommendedNextCalls。
TYPICAL NEXT TOOL:
- search_knowledge または record_task_note`,
    inputSchema: zodToJsonSchema(startTaskSchema) as Record<string, unknown>,
    handler: async (args) => {
      const input = startTaskSchema.parse(args);
      const result = await startTaskTrace(input);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  },
  {
    name: 'record_task_note',
    description: `WHEN TO USE:
- 作業中に再利用可能な知見を保存したいとき。
DO NOT USE WHEN:
- タスク完了の最終記録だけを残したいとき（finish_task を使用）。
WHAT IT RETURNS:
- 保存結果（entityId/slug/kind/category/enrichmentState）。
TYPICAL NEXT TOOL:
- finish_task`,
    inputSchema: zodToJsonSchema(recordTaskNoteSchema) as Record<string, unknown>,
    handler: async (args) => {
      const input = recordTaskNoteSchema.parse(args);
      const result = await recordTaskNote(input);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  },
  {
    name: 'finish_task',
    description: `WHEN TO USE:
- task trace を完了し、成果と学習項目を確定したいとき。
DO NOT USE WHEN:
- 途中経過を保存したいだけのとき（record_task_note を使用）。
WHAT IT RETURNS:
- 完了状態、学習項目登録件数、learnedEntities、次アクション。
TYPICAL NEXT TOOL:
- search_knowledge`,
    inputSchema: zodToJsonSchema(finishTaskSchema) as Record<string, unknown>,
    handler: async (args) => {
      const input = finishTaskSchema.parse(args);
      const result = await finishTaskTrace(input);
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
      const preReviewHookResult = await dispatchHookEvent({
        event: 'task.ready_for_review',
        traceId: randomUUID(),
        payload: {
          targetType: input.targetType,
          goal: input.goal,
        },
        context: {
          cwd: input.repoPath ?? process.cwd(),
          changedFiles: input.target.filePaths,
          reviewRequested: true,
        },
      }).catch(() => null);
      if (preReviewHookResult?.blocked) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  blocked: true,
                  event: 'task.ready_for_review',
                  guidance: preReviewHookResult.guidance,
                  warnings: preReviewHookResult.warnings,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
      const useKnowledge = input.useKnowledge ?? true;
      const seed = [
        input.target.diff,
        input.target.content,
        ...(input.target.filePaths ?? []),
        ...(input.focus ?? []),
      ]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join('\n');
      const retrieval = useKnowledge
        ? await searchKnowledgeV2({
            query: seed,
            preset:
              input.targetType === 'implementation_plan' || input.targetType === 'document'
                ? 'review_context'
                : undefined,
            maxCategories: 3,
            limitPerCategory: 2,
            grouping: 'by_category',
          })
        : { groups: [], flatTopHits: [] };
      const knowledgeUsed = (retrieval.groups ?? [])
        .flatMap((group) => group.hits)
        .slice(0, input.maxKnowledgeItems ?? 6)
        .map((hit) => ({
          slug: hit.slug,
          kind: hit.kind,
          category: hit.category,
          title: hit.title,
          reason: hit.reason,
        }));

      const providerUsed = getMcpReviewProviderLabel(input.provider);
      const llmPreference = input.provider === 'local' ? 'local' : input.provider;
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

      if (input.targetType === 'code_diff') {
        const request = ReviewRequestSchema.parse({
          taskId: `review-task-${Date.now()}`,
          repoPath: input.repoPath ?? process.cwd(),
          baseRef: 'main',
          headRef: 'HEAD',
          trigger: 'manual',
          sessionId: `review-task-${Date.now()}`,
          mode: 'worktree',
          taskGoal: input.goal ?? input.target.content ?? 'Review current code changes',
          changedFiles: input.target.filePaths,
          knowledgePolicy: input.knowledgePolicy ?? 'required',
        });
        const llmService = await getMcpReviewLLMService(llmPreference);
        const stage = input.reviewMode ?? 'standard';
        const reviewResult =
          stage === 'fast'
            ? await runReviewStageB(request, { llmService })
            : stage === 'deep'
              ? await runReviewStageE(request, { llmService })
              : await runReviewStageD(request, { llmService });
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
        findings,
        summary,
        suggestedNotes,
      };
      await dispatchHookEvent({
        event: 'review.completed',
        traceId: randomUUID(),
        payload: {
          targetType: input.targetType,
          providerUsed,
          findingCount: findings.length,
          summary,
        },
        context: {
          cwd: input.repoPath ?? process.cwd(),
          changedFiles: input.target.filePaths,
          reviewRequested: true,
        },
      }).catch(() => undefined);
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
- activate_project`,
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
