import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  buildActivateProjectResult,
  buildDoctorRuntimeHealth,
  finishTaskTrace,
  recordTaskNote,
  resolveStaleMetadataSignal,
  searchKnowledgeV2,
  startTaskTrace,
} from '../../services/agentFirst.js';
import { getReviewLLMService } from '../../services/review/llm/reviewer.js';
import {
  runReviewStageB,
  runReviewStageD,
  runReviewStageE,
} from '../../services/review/orchestrator.js';
import { type ReviewOutput, ReviewRequestSchema } from '../../services/review/types.js';
import type { ToolEntry } from '../registry.js';
import { reviewDocumentTools } from './reviewDocument.js';
import { reviewImplementationPlanTools } from './reviewImplementationPlan.js';
import { reviewSpecDocumentTools } from './reviewSpecDocument.js';

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
  preset: z
    .enum(['task_context', 'project_characteristics', 'review_context', 'procedures', 'risks'])
    .optional(),
  kinds: z.array(z.enum(KNOWLEDGE_KINDS)).optional(),
  categories: z.array(z.enum(KNOWLEDGE_CATEGORIES)).optional(),
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
});

function extractJsonText(content: Array<{ type: string; text: string }>): unknown {
  for (const chunk of content) {
    if (chunk.type !== 'text') continue;
    const text = chunk.text.trim();
    if (!(text.startsWith('{') || text.startsWith('['))) continue;
    try {
      return JSON.parse(text);
    } catch {
      // continue
    }
  }
  return null;
}

function mapSeverityToReviewTask(severity: string): 'critical' | 'major' | 'minor' | 'info' {
  if (severity === 'error' || severity === 'critical') return 'critical';
  if (severity === 'warning' || severity === 'major') return 'major';
  if (severity === 'minor') return 'minor';
  return 'info';
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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

function mapGenericFinding(finding: Record<string, unknown>, fallbackTitle: string) {
  const line =
    toOptionalNumber(finding.lineNumber) ??
    toOptionalNumber(finding.line_new) ??
    toOptionalNumber(finding.line);
  const file =
    toOptionalString(finding.filePath) ??
    toOptionalString(finding.file_path) ??
    toOptionalString(finding.file);
  return {
    severity: mapSeverityToReviewTask(String(finding.severity ?? 'info')),
    title: String(finding.title ?? fallbackTitle),
    body: String(finding.rationale ?? finding.body ?? ''),
    file,
    line,
  };
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
        why: 'Project health, knowledge index summary, and recommended next calls are required before editing.',
        recommendedWorkflow: [
          'activate_project',
          'search_knowledge',
          'start_task',
          'record_task_note / finish_task',
        ],
        caution:
          'Existing low-level tools remain available for compatibility, but primary workflow should prefer agent-first tools.',
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
- 実装前・レビュー前に再利用知識（rule/lesson/procedure/risk 等）を取得するとき。
DO NOT USE WHEN:
- 旧契約の KnowFlow FTS 応答が必要なとき（その場合は search_knowledge_legacy）。
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

      const providerUsed = input.provider ?? 'local';
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
        });
        const llmService = await getReviewLLMService(providerUsed, {
          invoker: 'mcp',
          requestId: randomUUID(),
        });
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
        const llmPreference = providerUsed === 'local' ? 'local' : 'cloud';
        const handler = reviewImplementationPlanTools[0]?.handler;
        const raw = handler
          ? await handler({
              repoPath: input.repoPath ?? process.cwd(),
              goal: input.goal ?? 'Review implementation plan',
              documentPath: input.target.documentPath,
              content: input.target.content,
              llmPreference,
            })
          : { content: [{ type: 'text', text: '{}' }] };
        const payload = extractJsonText(raw.content) as {
          summary?: string;
          findings?: Array<Record<string, unknown>>;
        } | null;
        const mappedFindings = Array.isArray(payload?.findings) ? payload.findings : [];
        findings = mappedFindings.map((finding) =>
          mapGenericFinding(finding, 'Implementation plan finding'),
        );
        summary = payload?.summary ?? 'Implementation plan review completed.';
      } else if (input.targetType === 'spec') {
        const llmPreference = providerUsed === 'local' ? 'local' : 'cloud';
        const handler = reviewSpecDocumentTools[0]?.handler;
        const raw = handler
          ? await handler({
              repoPath: input.repoPath ?? process.cwd(),
              goal: input.goal ?? 'Review specification',
              documentPath: input.target.documentPath,
              content: input.target.content,
              llmPreference,
            })
          : { content: [{ type: 'text', text: '{}' }] };
        const payload = extractJsonText(raw.content) as {
          summary?: string;
          findings?: Array<Record<string, unknown>>;
        } | null;
        const mappedFindings = Array.isArray(payload?.findings) ? payload.findings : [];
        findings = mappedFindings.map((finding) =>
          mapGenericFinding(finding, 'Specification finding'),
        );
        summary = payload?.summary ?? 'Specification review completed.';
      } else {
        const llmPreference = providerUsed === 'local' ? 'local' : 'cloud';
        const handler = reviewDocumentTools[0]?.handler;
        const documentType = input.targetType === 'design' ? 'plan' : 'spec';
        const raw = handler
          ? await handler({
              repoPath: input.repoPath ?? process.cwd(),
              documentPath: input.target.documentPath,
              content: input.target.content,
              documentType,
              goal: input.goal,
              llmPreference,
            })
          : { content: [{ type: 'text', text: '{}' }] };
        const payload = extractJsonText(raw.content) as {
          summary?: string;
          findings?: Array<Record<string, unknown>>;
        } | null;
        const mappedFindings = Array.isArray(payload?.findings) ? payload.findings : [];
        findings = mappedFindings.map((finding) => mapGenericFinding(finding, 'Document finding'));
        summary = payload?.summary ?? 'Document review completed.';
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
          automation:
            process.env.GNOSIS_ENABLE_AUTOMATION === 'true'
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
