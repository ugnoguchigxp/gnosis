import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { dispatchHookEvent } from '../../hooks/service.js';
import { reviewDocument } from '../../services/reviewAgent/documentReviewer.js';
import type { ToolEntry } from '../registry.js';

const reviewDocumentSchema = z
  .object({
    repoPath: z
      .string()
      .optional()
      .describe('リポジトリのルートパス (デフォルト: カレントディレクトリ)'),
    documentPath: z.string().optional().describe('レビュー対象ドキュメントの相対パス'),
    content: z.string().optional().describe('インラインで渡すレビュー対象ドキュメント本文'),
    documentType: z.enum(['spec', 'plan']).describe('レビュー対象のドキュメント種別'),
    goal: z.string().optional().describe('レビューの目的や重点'),
    context: z.string().optional().describe('補足文脈'),
    sessionId: z.string().optional().describe('知識参照に使うセッションID'),
    traceId: z.string().optional().describe('Hook/Monitor 相関用 trace ID'),
    runId: z.string().optional().describe('Hook/Monitor 相関用 run ID'),
    taskId: z.string().optional().describe('関連タスク ID'),
    llmPreference: z
      .enum(['local', 'cloud'])
      .optional()
      .describe('使用する LLM の優先度 (省略時は環境設定に従う)'),
  })
  .refine((value) => Boolean(value.documentPath) !== Boolean(value.content), {
    message: 'Exactly one of documentPath or content must be provided.',
    path: ['documentPath'],
  });

export const reviewDocumentTools: ToolEntry[] = [
  {
    name: 'review_document',
    description:
      '仕様書または計画書をレビューし、指摘事項・根拠・次アクションを返します。ドキュメントを自動編集せず、レビュー結果のみ返却します。',
    inputSchema: zodToJsonSchema(reviewDocumentSchema) as Record<string, unknown>,
    handler: async (args) => {
      const parsed = reviewDocumentSchema.parse(args);
      const traceId = parsed.traceId ?? randomUUID();
      const runId = parsed.runId ?? traceId;
      const result = await reviewDocument({
        repoPath: parsed.repoPath ?? process.cwd(),
        documentPath: parsed.documentPath,
        content: parsed.content,
        documentType: parsed.documentType,
        goal: parsed.goal,
        context: parsed.context,
        sessionId: parsed.sessionId,
        llmPreference: parsed.llmPreference,
      });

      await dispatchHookEvent({
        event: 'review.completed',
        traceId,
        runId,
        taskId: parsed.taskId,
        context: {
          cwd: parsed.repoPath ?? process.cwd(),
          taskMode: 'review',
          reviewRequested: true,
        },
        payload: {
          reviewId: result.reviewId,
          reviewStatus: result.status,
          findingsCount: result.findings.length,
          documentType: result.documentType,
        },
      }).catch((error) => {
        console.warn(`review_document hook dispatch failed (traceId: ${traceId}):`, error);
      });

      return {
        content: [
          { type: 'text', text: JSON.stringify(result, null, 2) },
          { type: 'text', text: result.markdown },
        ],
      };
    },
  },
];
