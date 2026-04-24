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
import { analyzeSpecAlignment } from '../../services/specAgent/specAlignment.js';
import type { ToolEntry } from '../registry.js';
import {
  toReviewFindingFromDocument,
  toReviewOutputFromDocument,
} from './reviewDocumentPersistence.js';

function isWithin(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function loadSpecText(
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

const reviewSpecDocumentSchema = z
  .object({
    repoPath: z.string().min(1).describe('対象リポジトリの絶対パス'),
    goal: z.string().min(1).describe('仕様対象の目標'),
    documentPath: z.string().optional().describe('レビュー対象の仕様書パス（repoPath配下）'),
    content: z.string().optional().describe('レビュー対象の仕様書本文（documentPathと排他）'),
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

export const reviewSpecDocumentTools: ToolEntry[] = [
  {
    name: 'review_spec_document',
    description:
      '仕様書をレビューし、手続き記憶の参照計画との整合（要件・受入条件・Golden Path）を確認します。',
    inputSchema: zodToJsonSchema(reviewSpecDocumentSchema) as Record<string, unknown>,
    handler: async (args) => {
      const parsed = reviewSpecDocumentSchema.parse(args);
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
        includeLessons: false,
      });

      const referenceMarkdown =
        referencePlan?.markdown ??
        '(reference plan unavailable: no matching procedure was found for this goal)';
      const mergedContext = [
        parsed.context?.trim() ?? '',
        'Reference plan generated from procedural memory:',
        referenceMarkdown,
        'Review policy: verify requirement clarity, acceptance criteria, and Golden Path coverage.',
      ]
        .filter((line) => line.length > 0)
        .join('\n\n');

      const review = await reviewDocument({
        repoPath: parsed.repoPath,
        documentPath: parsed.documentPath,
        content: parsed.content,
        documentType: 'spec',
        goal: parsed.goal,
        context: mergedContext,
        sessionId: parsed.sessionId,
        llmPreference: parsed.llmPreference,
      });

      const specText = await loadSpecText(parsed.repoPath, parsed.documentPath, parsed.content);
      const alignment = analyzeSpecAlignment(specText, referencePlan);
      const mergedFindings = [...alignment.findings, ...review.findings].filter(
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
        toReviewFindingFromDocument(review.reviewId, finding, parsed.documentPath, 'spec_document'),
      );
      const reviewOutput = toReviewOutputFromDocument(
        review.reviewId,
        review.summary,
        mergedStatus,
        reviewFindings,
        review.nextActions,
      );

      const request: ReviewRequest = {
        taskId: parsed.taskId ?? `review-spec-document-${Date.now()}`,
        repoPath: parsed.repoPath,
        baseRef: 'N/A',
        headRef: 'N/A',
        taskGoal: parsed.goal,
        trigger: 'manual',
        sessionId: parsed.sessionId?.trim() || `spec-review-${Date.now()}`,
        mode: 'worktree',
        enableStaticAnalysis: false,
        enableKnowledgeRetrieval: true,
      };

      await persistReviewCase(request, reviewOutput).catch((error) => {
        console.warn(`review_spec_document persistence failed (traceId: ${traceId}):`, error);
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
          documentType: 'spec',
        },
      }).catch((error) => {
        console.warn(`review_spec_document hook dispatch failed (traceId: ${traceId}):`, error);
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
