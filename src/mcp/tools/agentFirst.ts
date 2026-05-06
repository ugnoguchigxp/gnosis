import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { GNOSIS_CONSTANTS } from '../../constants.js';
import {
  buildDoctorRuntimeHealth,
  recordTaskNote,
  resolveStaleMetadataSignal,
  searchKnowledgeV2,
} from '../../services/agentFirst.js';
import { AgenticSearchRunner } from '../../services/agenticSearch/runner.js';
import { ReviewError } from '../../services/review/errors.js';
import { getReviewLLMService } from '../../services/review/llm/reviewer.js';
import type { ReviewLLMPreference, ReviewLLMService } from '../../services/review/llm/types.js';
import { runReviewAgentic } from '../../services/review/orchestrator.js';
import type { KnowledgePolicy, ReviewMode, ReviewOutput } from '../../services/review/types.js';
import { reviewDocument } from '../../services/reviewAgent/documentReviewer.js';
import { fetchVibeMemory, searchVibeMemories } from '../../services/vibeMemoryLookup.js';
import type { ToolEntry } from '../registry.js';

const taskChangeTypes = [
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

const initialInstructionsSchema = z.object({});
const agenticSearchSchema = z.object({
  userRequest: z.string().min(1),
  repoPath: z.string().optional(),
  files: z.array(z.string()).optional(),
  changeTypes: z.array(z.enum(taskChangeTypes)).optional(),
  technologies: z.array(z.string()).optional(),
  intent: z.enum(['plan', 'edit', 'debug', 'review', 'finish']).optional(),
});
const searchKnowledgeSchema = z.object({
  query: z.string().optional(),
  taskGoal: z.string().optional(),
  files: z.array(z.string()).optional(),
  changeTypes: z.array(z.enum(taskChangeTypes)).optional(),
  technologies: z.array(z.string()).optional(),
  intent: z.enum(['plan', 'edit', 'debug', 'review', 'finish']).optional(),
});
const memorySearchSchema = z.object({
  query: z.string().trim().min(1),
  mode: z.enum(['hybrid', 'vector', 'like']).optional(),
  limit: z.number().int().positive().max(20).optional(),
  sessionId: z.string().trim().min(1).optional(),
  memoryType: z.literal('raw').optional(),
  maxSnippetChars: z.number().int().positive().max(1000).optional(),
});
const memoryFetchSchema = z.object({
  id: z.string().trim().min(1),
  query: z.string().trim().optional(),
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().nonnegative().optional(),
  maxChars: z.number().int().positive().max(5000).optional(),
});
const recordTaskNoteSchema = z.object({
  content: z.string().min(1),
  taskId: z.string().optional(),
  kind: z
    .enum([
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
    ])
    .optional(),
  category: z
    .enum([
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
    ])
    .optional(),
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
  triggerPhrases: z.array(z.string()).optional(),
  appliesWhen: z.array(z.string()).optional(),
  intent: z.enum(['plan', 'edit', 'debug', 'review', 'finish']).optional(),
  changeTypes: z.array(z.enum(taskChangeTypes)).optional(),
  technologies: z.array(z.string()).optional(),
  confidence: z.number().optional(),
  source: z.enum(['manual', 'task', 'review', 'onboarding', 'import']).optional(),
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
    .optional(),
});
const reviewTaskSchema = z.object({
  targetType: z.enum(['code_diff', 'document', 'implementation_plan', 'spec', 'design']),
  target: z.object({
    diff: z.string().optional(),
    filePaths: z.array(z.string()).optional(),
    content: z.string().optional(),
    documentPath: z.string().optional(),
  }),
  repoPath: z.string().optional(),
  provider: z.enum(['local', 'openai', 'bedrock', 'azure-openai']).optional(),
  reviewMode: z.enum(['fast', 'standard', 'deep']).optional(),
  goal: z.string().optional(),
  knowledgePolicy: z.enum(['off', 'best_effort', 'required']).optional(),
  diffMode: z.enum(['git_diff', 'worktree']).optional(),
  baseRef: z.string().optional(),
  headRef: z.string().optional(),
  sessionId: z.string().optional(),
  enableStaticAnalysis: z.boolean().optional(),
});

type AgenticSearchRunnerLike = Pick<AgenticSearchRunner, 'run'>;
type MemorySearchRunnerLike = typeof searchVibeMemories;
type MemoryFetchRunnerLike = typeof fetchVibeMemory;
type ReviewTaskInput = z.infer<typeof reviewTaskSchema>;
type ReviewTaskMcpDeps = {
  createLlmService?: (provider?: ReviewTaskInput['provider']) => Promise<ReviewLLMService>;
  reviewDocumentFn?: typeof reviewDocument;
  runReviewAgenticFn?: typeof runReviewAgentic;
  now?: () => number;
};

type ReviewTaskRunnerLike = (input: ReviewTaskInput) => Promise<unknown>;

let agenticSearchRunner: AgenticSearchRunnerLike = new AgenticSearchRunner();
let memorySearchRunner: MemorySearchRunnerLike = searchVibeMemories;
let memoryFetchRunner: MemoryFetchRunnerLike = fetchVibeMemory;
let reviewTaskRunner: ReviewTaskRunnerLike = runReviewTaskForMcp;

export function setAgenticSearchRunnerForTest(runner: AgenticSearchRunnerLike): void {
  agenticSearchRunner = runner;
}

export function resetAgenticSearchRunnerForTest(): void {
  agenticSearchRunner = new AgenticSearchRunner();
}

export function setMemorySearchRunnerForTest(runner: MemorySearchRunnerLike): void {
  memorySearchRunner = runner;
}

export function resetMemorySearchRunnerForTest(): void {
  memorySearchRunner = searchVibeMemories;
}

export function setMemoryFetchRunnerForTest(runner: MemoryFetchRunnerLike): void {
  memoryFetchRunner = runner;
}

export function resetMemoryFetchRunnerForTest(): void {
  memoryFetchRunner = fetchVibeMemory;
}

export function setReviewTaskRunnerForTest(runner: ReviewTaskRunnerLike): void {
  reviewTaskRunner = runner;
}

export function resetReviewTaskRunnerForTest(): void {
  reviewTaskRunner = runReviewTaskForMcp;
}

function providerToPreference(
  provider?: ReviewTaskInput['provider'],
): ReviewLLMPreference | undefined {
  if (!provider) return undefined;
  return provider;
}

export function resolveMcpReviewTimeoutMs(): number {
  const raw = process.env.GNOSIS_MCP_REVIEW_LLM_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : GNOSIS_CONSTANTS.MCP_REVIEW_LLM_TIMEOUT_MS_DEFAULT;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : GNOSIS_CONSTANTS.MCP_REVIEW_LLM_TIMEOUT_MS_DEFAULT;
}

async function createMcpReviewLlmService(
  provider?: ReviewTaskInput['provider'],
): Promise<ReviewLLMService> {
  return getReviewLLMService(providerToPreference(provider), {
    invoker: 'mcp',
    timeoutMs: resolveMcpReviewTimeoutMs(),
    disableFallback: true,
  });
}

function resolveReviewTaskRepoPath(input: ReviewTaskInput): string {
  return path.resolve(input.repoPath?.trim() || process.cwd());
}

function buildReviewTaskSessionId(input: ReviewTaskInput, repoPath: string): string {
  const raw = input.sessionId?.trim() || `review-mcp:${path.basename(repoPath) || 'repo'}`;
  const normalized = raw.replace(/[^a-zA-Z0-9_:-]/g, '-').slice(0, 256);
  return normalized || `review-mcp:${randomUUID()}`;
}

function extractDiffFilePaths(diff: string): string[] {
  const paths = new Set<string>();
  for (const match of diff.matchAll(/^diff --git a\/(.+?) b\/(.+?)$/gm)) {
    if (match[2]) paths.add(match[2]);
  }
  return [...paths];
}

function buildReviewTaskGoal(input: ReviewTaskInput): string {
  const mode = input.reviewMode ? ` (${input.reviewMode})` : '';
  return input.goal?.trim() || `${input.targetType} review${mode}`;
}

function normalizeKnowledgePolicy(input: ReviewTaskInput): KnowledgePolicy {
  return input.knowledgePolicy ?? 'best_effort';
}

function normalizeReviewMode(input: ReviewTaskInput): ReviewMode {
  return input.diffMode ?? 'worktree';
}

function normalizeReviewOutput(
  input: ReviewTaskInput,
  output: ReviewOutput,
  durationMs: number,
): Record<string, unknown> {
  return {
    status: output.metadata.degraded_mode ? 'degraded' : 'ok',
    targetType: input.targetType,
    reviewStatus: output.review_status,
    summary: output.summary,
    findings: output.findings.map((finding) => ({
      title: finding.title,
      severity: finding.severity,
      confidence: finding.confidence,
      filePath: finding.file_path,
      line: finding.line_new,
      endLine: finding.end_line,
      category: finding.category,
      rationale: finding.rationale,
      suggestedFix: finding.suggested_fix,
      evidence: finding.evidence,
      knowledgeRefs: finding.knowledge_refs ?? [],
      source: finding.source,
      needsHumanConfirmation: finding.needsHumanConfirmation,
    })),
    nextActions: output.next_actions,
    rerunReview: output.rerun_review,
    knowledgeUsed: output.metadata.knowledge_applied,
    diagnostics: {
      provider: input.provider ?? 'default',
      reviewMode: input.reviewMode ?? 'standard',
      knowledgePolicy: output.metadata.knowledge_policy ?? normalizeKnowledgePolicy(input),
      knowledgeRetrievalStatus: output.metadata.knowledge_retrieval_status,
      degraded: output.metadata.degraded_mode,
      degradedReasons: output.metadata.degraded_reasons,
      reviewedFiles: output.metadata.reviewed_files,
      riskLevel: output.metadata.risk_level,
      staticAnalysisUsed: output.metadata.static_analysis_used,
      localLlmUsed: output.metadata.local_llm_used,
      heavyLlmUsed: output.metadata.heavy_llm_used,
      durationMs: output.metadata.review_duration_ms || durationMs,
    },
  };
}

function normalizeDocumentReviewOutput(
  input: ReviewTaskInput,
  output: Awaited<ReturnType<typeof reviewDocument>>,
  durationMs: number,
): Record<string, unknown> {
  const knowledgeUsed = [
    ...output.appliedContext.procedureIds,
    ...output.appliedContext.lessonIds,
    ...output.appliedContext.guidanceIds,
    ...output.appliedContext.memoryIds,
  ];
  const uniqueKnowledgeUsed = [...new Set(knowledgeUsed)];
  const requiredKnowledgeMissing =
    normalizeKnowledgePolicy(input) === 'required' && uniqueKnowledgeUsed.length === 0;
  const degradedReasons = requiredKnowledgeMissing ? ['knowledge_required_unavailable'] : [];

  return {
    status: requiredKnowledgeMissing ? 'degraded' : 'ok',
    targetType: input.targetType,
    reviewStatus: requiredKnowledgeMissing ? 'needs_confirmation' : output.status,
    summary: requiredKnowledgeMissing
      ? [
          output.summary,
          '',
          'Required knowledge policy was requested, but no applicable review context was applied. Treat this result as needs_confirmation until knowledge retrieval is repaired or the policy is relaxed.',
        ].join('\n')
      : output.summary,
    findings: output.findings.map((finding) => ({
      title: finding.title,
      severity: finding.severity,
      confidence: finding.confidence,
      location: finding.location,
      category: finding.category,
      rationale: finding.rationale,
      suggestedFix: finding.suggestedFix,
      evidence: finding.evidence,
      knowledgeRefs: finding.knowledgeRefs ?? [],
    })),
    nextActions: requiredKnowledgeMissing
      ? [
          'Repair or populate applicable review knowledge, then rerun review_task with knowledgePolicy=required.',
          ...output.nextActions,
        ]
      : output.nextActions,
    knowledgeUsed: uniqueKnowledgeUsed,
    diagnostics: {
      provider: input.provider ?? 'default',
      reviewMode: input.reviewMode ?? 'standard',
      knowledgePolicy: normalizeKnowledgePolicy(input),
      documentType: output.documentType,
      appliedContext: output.appliedContext,
      degraded: requiredKnowledgeMissing,
      degradedReasons,
      durationMs,
    },
  };
}

function normalizeReviewTaskError(
  input: ReviewTaskInput,
  error: unknown,
  durationMs: number,
): Record<string, unknown> {
  const code = error instanceof ReviewError ? error.code : 'REVIEW_TASK_FAILED';
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: 'degraded',
    targetType: input.targetType,
    reviewStatus: 'needs_confirmation',
    summary: 'review_task could not complete synchronously.',
    findings: [],
    nextActions: ['Fix the diagnostics cause and rerun review_task.'],
    knowledgeUsed: [],
    diagnostics: {
      provider: input.provider ?? 'default',
      reviewMode: input.reviewMode ?? 'standard',
      knowledgePolicy: normalizeKnowledgePolicy(input),
      degraded: true,
      degradedReasons: [code],
      errorCode: code,
      errorMessage: message,
      durationMs,
    },
  };
}

function documentReviewDeps(
  llmService: ReviewLLMService,
  knowledgePolicy: KnowledgePolicy,
  timeoutMs: number,
) {
  if (knowledgePolicy !== 'off') {
    return { llmService, timeoutMs };
  }
  return {
    llmService,
    timeoutMs,
    queryProcedureFn: async () => null,
    recallLessonsFn: async () => [],
    searchMemoryFn: async () => [],
    getAlwaysGuidanceFn: async () => [],
    getOnDemandGuidanceFn: async () => [],
  };
}

export async function runReviewTaskForMcp(
  input: ReviewTaskInput,
  deps: ReviewTaskMcpDeps = {},
): Promise<Record<string, unknown>> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  try {
    const repoPath = resolveReviewTaskRepoPath(input);
    const knowledgePolicy = normalizeKnowledgePolicy(input);
    const createLlmService = deps.createLlmService ?? createMcpReviewLlmService;
    const llmService = await createLlmService(input.provider);
    const sessionId = buildReviewTaskSessionId(input, repoPath);
    const taskGoal = buildReviewTaskGoal(input);

    if (input.targetType === 'code_diff') {
      const rawDiff = input.target.diff?.trim();
      const changedFiles =
        input.target.filePaths && input.target.filePaths.length > 0
          ? input.target.filePaths
          : rawDiff
            ? extractDiffFilePaths(rawDiff)
            : undefined;
      const runReview = deps.runReviewAgenticFn ?? runReviewAgentic;
      const result = await runReview(
        {
          taskId: `mcp-review-${randomUUID()}`,
          repoPath,
          baseRef: input.baseRef ?? 'HEAD~1',
          headRef: input.headRef ?? 'HEAD',
          taskGoal,
          changedFiles,
          trigger: 'manual',
          sessionId,
          mode: normalizeReviewMode(input),
          enableStaticAnalysis: input.enableStaticAnalysis ?? true,
          enableKnowledgeRetrieval: knowledgePolicy !== 'off',
          knowledgePolicy,
        },
        {
          llmService,
          diffProvider: rawDiff ? async () => rawDiff : undefined,
        },
      );
      return normalizeReviewOutput(input, result, now() - startedAt);
    }

    const reviewDoc = deps.reviewDocumentFn ?? reviewDocument;
    const result = await reviewDoc(
      {
        repoPath,
        documentPath: input.target.documentPath,
        content: input.target.content,
        documentType: input.targetType === 'spec' ? 'spec' : 'plan',
        goal: taskGoal,
        context: input.target.filePaths?.join('\n'),
        sessionId,
        llmPreference: providerToPreference(input.provider),
      },
      documentReviewDeps(llmService, knowledgePolicy, resolveMcpReviewTimeoutMs()),
    );
    return normalizeDocumentReviewOutput(input, result, now() - startedAt);
  } catch (error) {
    return normalizeReviewTaskError(input, error, now() - startedAt);
  }
}

export const agentFirstTools: ToolEntry[] = [
  {
    name: 'initial_instructions',
    description: 'Agent-First の最小運用ルールを返す。',
    inputSchema: zodToJsonSchema(initialInstructionsSchema) as Record<string, unknown>,
    handler: async () => ({
      content: [
        {
          type: 'text',
          text: [
            '## 常用ルール',
            '',
            '常用ルールは MCP server が scope:always の登録内容から短く付与します。取得できない場合は MCP ツール種別だけを参照してください。',
            '',
            '## MCPツール種別',
            '',
            '- `initial_instructions`: Gnosis の現行ツール方針が不明な時だけ最初に使う。毎タスクの前置きにはしない。',
            '- `agentic_search`: 非自明な実装・レビュー・調査で、過去知識や成功/失敗例が判断を変え得る時に使う主導線。`userRequest` に goal、files、changeTypes、intent を含める。',
            '- `search_knowledge`: raw候補、スコア、近い語句を直接確認したい時だけ使う。通常回答や方針判断は `agentic_search` を優先する。',
            '- `review_task`: コード差分、ドキュメント、計画、仕様、設計をレビューする時に使う。根拠必須なら `knowledgePolicy: "required"` を検討する。',
            '- `record_task_note`: verify 後、次回も使える rule / lesson / procedure / decision が得られた時だけ保存する。作業ログ丸ごとは保存しない。',
            '- `doctor`: tool visibility、DB、MCP host、metadata、timeout/Transport closed など runtime が怪しい時、または復旧後の確認に使う。',
            '- `memory_search` / `memory_fetch`: context 圧縮後に raw memory の具体的根拠が必要な時だけ使う。まず search で候補を見て、必要分だけ fetch する。',
          ].join('\n'),
        },
      ],
    }),
  },
  {
    name: 'agentic_search',
    description: 'JSON入力を解析し、agentic_search runner を実行する。',
    inputSchema: zodToJsonSchema(agenticSearchSchema) as Record<string, unknown>,
    handler: async (args) => {
      const input = agenticSearchSchema.parse(args);
      const result = await agenticSearchRunner.run(input);

      return {
        content: [
          {
            type: 'text',
            text: result.answer,
          },
        ],
      };
    },
  },
  {
    name: 'search_knowledge',
    description: 'raw候補確認用。',
    inputSchema: zodToJsonSchema(searchKnowledgeSchema) as Record<string, unknown>,
    handler: async (args) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify(await searchKnowledgeV2(searchKnowledgeSchema.parse(args)), null, 2),
        },
      ],
    }),
  },
  {
    name: 'record_task_note',
    description: '知見保存。',
    inputSchema: zodToJsonSchema(recordTaskNoteSchema) as Record<string, unknown>,
    handler: async (args) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify(await recordTaskNote(recordTaskNoteSchema.parse(args)), null, 2),
        },
      ],
    }),
  },
  {
    name: 'review_task',
    description: 'コード差分・ドキュメント・計画をレビューし、失敗時もdegraded JSONを返す。',
    inputSchema: zodToJsonSchema(reviewTaskSchema) as Record<string, unknown>,
    handler: async (args) => {
      const input = reviewTaskSchema.parse(args);
      const result = await reviewTaskRunner(input);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  },
  {
    name: 'doctor',
    description: 'ランタイム/メタデータ状態を返す。',
    inputSchema: zodToJsonSchema(doctorSchema) as Record<string, unknown>,
    handler: async (args) => {
      const input = doctorSchema.parse(args);
      const staleMetadata = await resolveStaleMetadataSignal({
        clientSnapshot: input.clientSnapshot,
      });
      const runtime = await buildDoctorRuntimeHealth();
      return {
        content: [{ type: 'text', text: JSON.stringify({ ...runtime, staleMetadata }, null, 2) }],
      };
    },
  },
  {
    name: 'memory_search',
    description:
      'vibe_memories の raw memory を vector/LIKE/hybrid で薄いsnippet一覧として取得する。',
    inputSchema: zodToJsonSchema(memorySearchSchema) as Record<string, unknown>,
    handler: async (args) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify(await memorySearchRunner(memorySearchSchema.parse(args)), null, 2),
        },
      ],
    }),
  },
  {
    name: 'memory_fetch',
    description:
      'vibe_memories の指定memoryから必要範囲だけを取得する。start/end または query 周辺を使う。',
    inputSchema: zodToJsonSchema(memoryFetchSchema) as Record<string, unknown>,
    handler: async (args) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify(await memoryFetchRunner(memoryFetchSchema.parse(args)), null, 2),
        },
      ],
    }),
  },
];
