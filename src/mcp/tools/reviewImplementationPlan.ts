import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { dispatchHookEvent } from '../../hooks/service.js';
import { persistReviewCase } from '../../services/review/knowledge/index.js';
import type { ReviewRequest } from '../../services/review/types.js';
import { reviewDocument } from '../../services/reviewAgent/documentReviewer.js';
import { generateImplementationPlan } from '../../services/specAgent/implementationPlanner.js';
import { analyzePlanAlignment } from '../../services/specAgent/planAlignment.js';
import type { ToolEntry } from '../registry.js';
import {
  toReviewFindingFromDocument,
  toReviewOutputFromDocument,
} from './reviewDocumentPersistence.js';

function isWithin(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function loadPlanText(
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

const reviewImplementationPlanSchema = z
  .object({
    repoPath: z.string().min(1).describe('対象リポジトリの絶対パス'),
    goal: z.string().min(1).describe('計画対象の目標'),
    documentPath: z.string().optional().describe('レビュー対象の計画書パス（repoPath配下）'),
    content: z.string().optional().describe('レビュー対象の計画書本文（documentPathと排他）'),
    context: z.string().optional().describe('追加コンテキスト'),
    project: z.string().optional(),
    domains: z.array(z.string()).optional(),
    languages: z.array(z.string()).optional(),
    frameworks: z.array(z.string()).optional(),
    environment: z.string().optional(),
    repo: z.string().optional(),
    sessionId: z.string().optional(),
    llmPreference: z.enum(['local', 'cloud']).optional(),
    taskId: z.string().optional().describe('関連タスク ID'),
    traceId: z.string().optional().describe('Hook/Monitor 相関用 trace ID'),
    runId: z.string().optional().describe('Hook/Monitor 相関用 run ID'),
  })
  .refine((value) => !(value.documentPath && value.content), {
    message: 'documentPath and content are mutually exclusive',
    path: ['content'],
  })
  .refine((value) => !!value.documentPath || !!value.content, {
    message: 'either documentPath or content is required',
    path: ['documentPath'],
  });

export const reviewImplementationPlanTools: ToolEntry[] = [
  {
    name: 'review_implementation_plan',
    description:
      '実装計画書を、手続き記憶から生成した参照計画（Golden Path + caution）と照合してレビューします。',
    inputSchema: zodToJsonSchema(reviewImplementationPlanSchema) as Record<string, unknown>,
    handler: async (args) => {
      const parsed = reviewImplementationPlanSchema.parse(args);
      const traceId = parsed.traceId ?? randomUUID();
      const runId = parsed.runId ?? traceId;
      const referencePlan = await generateImplementationPlan({
        goal: parsed.goal,
        context: parsed.context,
        project: parsed.project,
        domains: parsed.domains,
        languages: parsed.languages,
        frameworks: parsed.frameworks,
        environment: parsed.environment,
        repo: parsed.repo,
        sessionId: parsed.sessionId,
        includeLessons: true,
      });

      const referenceMarkdown =
        referencePlan?.markdown ??
        '(reference plan unavailable: no matching procedure was found for this goal)';
      const mergedContext = [
        parsed.context?.trim() ?? '',
        'Reference plan generated from procedural memory:',
        referenceMarkdown,
        'Review policy: focus on missing Golden Path steps and missing mitigation for caution tasks.',
      ]
        .filter((line) => line.length > 0)
        .join('\n\n');

      const review = await reviewDocument({
        repoPath: parsed.repoPath,
        documentPath: parsed.documentPath,
        content: parsed.content,
        documentType: 'plan',
        goal: parsed.goal,
        context: mergedContext,
        sessionId: parsed.sessionId,
        llmPreference: parsed.llmPreference,
      });

      const planText = await loadPlanText(parsed.repoPath, parsed.documentPath, parsed.content);
      const alignment = referencePlan ? analyzePlanAlignment(planText, referencePlan) : null;

      const mergedFindings = [...(alignment?.findings ?? []), ...review.findings].filter(
        (finding, index, all) => {
          const key = `${finding.title}:${finding.rationale}`;
          return all.findIndex((item) => `${item.title}:${item.rationale}` === key) === index;
        },
      );

      const mergedStatus = mergedFindings.some((finding) => finding.severity === 'error')
        ? 'changes_requested'
        : mergedFindings.some((finding) => finding.severity === 'warning')
          ? 'needs_confirmation'
          : 'no_major_findings';
      const reviewFindings = mergedFindings.map((finding) =>
        toReviewFindingFromDocument(
          review.reviewId,
          finding,
          parsed.documentPath,
          'implementation_plan',
        ),
      );
      const reviewOutput = toReviewOutputFromDocument(
        review.reviewId,
        review.summary,
        mergedStatus,
        reviewFindings,
        review.nextActions,
      );
      const request: ReviewRequest = {
        taskId: parsed.taskId ?? `review-implementation-plan-${Date.now()}`,
        repoPath: parsed.repoPath,
        baseRef: 'N/A',
        headRef: 'N/A',
        taskGoal: parsed.goal,
        trigger: 'manual',
        sessionId: parsed.sessionId?.trim() || `plan-review-${Date.now()}`,
        mode: 'worktree',
        enableStaticAnalysis: false,
        enableKnowledgeRetrieval: true,
      };

      await persistReviewCase(request, reviewOutput).catch((error) => {
        console.warn(`review_implementation_plan persistence failed (traceId: ${traceId}):`, error);
      });
      await dispatchHookEvent({
        event: 'review.completed',
        traceId,
        runId,
        taskId: request.taskId,
        context: {
          cwd: parsed.repoPath,
          taskMode: 'review',
          reviewRequested: true,
        },
        payload: {
          reviewId: review.reviewId,
          reviewStatus: mergedStatus,
          findingsCount: mergedFindings.length,
          documentType: 'plan',
        },
      }).catch((error) => {
        console.warn(
          `review_implementation_plan hook dispatch failed (traceId: ${traceId}):`,
          error,
        );
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                reviewId: review.reviewId,
                status: mergedStatus,
                findings: reviewFindings,
                summary: review.summary,
                nextActions: review.nextActions,
                appliedContext: review.appliedContext,
                referencePlan: referencePlan
                  ? {
                      goal: referencePlan.goal,
                      tasks: referencePlan.tasks,
                      constraints: referencePlan.constraints,
                      reviewChecklist: referencePlan.reviewChecklist,
                      markdown: referencePlan.markdown,
                    }
                  : null,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  },
];
