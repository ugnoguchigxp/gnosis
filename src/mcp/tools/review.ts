import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { config } from '../../config.js';
import { getReviewLLMService } from '../../services/review/llm/reviewer.js';
import {
  runReviewStageA,
  runReviewStageB,
  runReviewStageC,
  runReviewStageD,
  runReviewStageE,
} from '../../services/review/orchestrator.js';
import { ReviewModeSchema, ReviewRequestSchema } from '../../services/review/types.js';
import type { ToolEntry } from '../registry.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const reviewParamsSchema = z.object({
  repoPath: z
    .string()
    .optional()
    .describe('リポジトリのルートパス (デフォルト: カレントディレクトリ)'),
  taskId: z.string().optional().describe('タスクID (省略時は自動生成)'),
  baseRef: z.string().optional().describe('ベースリファレンス (例: main)'),
  headRef: z.string().optional().describe('ヘッドリファレンス (例: HEAD)'),
  mode: ReviewModeSchema.optional().default('git_diff').describe('レビューモード'),
  goal: z.string().optional().describe('レビューの目的や重点事項'),
  llmPreference: z.enum(['local', 'cloud']).optional().describe('使用する LLM の優先度'),
  stage: z.enum(['a', 'b', 'c', 'd', 'e']).optional().default('e').describe('実行するステージ'),
});

function isReviewDebugEnabled(): boolean {
  const raw = process.env.GNOSIS_REVIEW_DEBUG?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function emitReviewDebugLog(payload: Record<string, unknown>): void {
  if (!isReviewDebugEnabled()) return;
  console.error(`[review-debug] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

function getMcpReviewExecutionMode(): 'cli' | 'inproc' {
  const raw = process.env.GNOSIS_REVIEW_MCP_MODE?.trim().toLowerCase();
  if (raw === 'inproc') return 'inproc';
  return 'cli';
}

async function runReviewViaCli(
  parsed: z.infer<typeof reviewParamsSchema>,
  resolvedPath: string,
  requestId: string,
): Promise<{ markdown: string }> {
  const stage = parsed.stage ?? 'e';
  const envPreference = process.env.GNOSIS_REVIEW_LLM_PREFERENCE === 'local' ? 'local' : 'cloud';
  const llmPreference = parsed.llmPreference ?? envPreference;
  const cliPath = path.resolve(PROJECT_ROOT, 'src/scripts/review.ts');
  const args = [
    'run',
    cliPath,
    '--repo',
    resolvedPath,
    '--base',
    parsed.baseRef ?? 'main',
    '--head',
    parsed.headRef ?? 'HEAD',
    '--mode',
    parsed.mode ?? 'git_diff',
    '--stage',
    stage,
    '--llm',
    llmPreference,
    '--task-id',
    parsed.taskId ?? `mcp-review-${Date.now()}`,
    '--session-id',
    `mcp-session-${Date.now()}`,
    '--json',
  ];
  if (parsed.goal) {
    args.push('--goal', parsed.goal);
  }

  emitReviewDebugLog({
    event: 'mcp_review_cli_spawn',
    requestId,
    command: config.bunCommand,
    args,
  });

  return new Promise((resolve, reject) => {
    const child = spawn(config.bunCommand, args, {
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(stderr.trim() || `review CLI failed with exit code ${code}`));
      }

      try {
        const parsedOutput = JSON.parse(stdout.trim());
        const markdown = parsedOutput.markdown;
        if (typeof markdown !== 'string' || !markdown.trim()) {
          return reject(new Error('review CLI output did not include markdown'));
        }
        resolve({ markdown });
      } catch (e) {
        reject(new Error(`review CLI returned non-JSON output: ${stdout.slice(0, 200)}`));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

export const reviewTools: ToolEntry[] = [
  {
    name: 'review',
    description: `Gnosis の高度なコードレビューを実行します。
Stage E (agentic) を使用すると、AI が自律的に情報を収集して詳細なレビューを行います。`,
    inputSchema: zodToJsonSchema(reviewParamsSchema) as Record<string, unknown>,
    handler: async (args) => {
      const requestId = randomUUID();
      const runReview = async () => {
        try {
          const parsed = reviewParamsSchema.parse(args);
          const repoPath = parsed.repoPath ?? process.cwd();
          const resolvedPath = fs.realpathSync(repoPath);
          const stage = parsed.stage ?? 'e';
          const execMode = getMcpReviewExecutionMode();

          emitReviewDebugLog({
            event: 'mcp_review_start',
            requestId,
            repoPath: resolvedPath,
            stage,
            execMode,
            mode: parsed.mode ?? 'git_diff',
            llmPreference: parsed.llmPreference ?? null,
          });

          if (execMode === 'cli') {
            const result = await runReviewViaCli(parsed, resolvedPath, requestId);
            emitReviewDebugLog({
              event: 'mcp_review_success',
              requestId,
              stage,
              execMode,
              markdownLength: result.markdown.length,
            });
            return;
          }

          const request = ReviewRequestSchema.parse({
            taskId: parsed.taskId ?? `mcp-review-${Date.now()}`,
            repoPath: resolvedPath,
            baseRef: parsed.baseRef ?? 'main',
            headRef: parsed.headRef ?? 'HEAD',
            trigger: 'manual',
            sessionId: `mcp-session-${Date.now()}`,
            mode: parsed.mode,
            taskGoal: parsed.goal,
          });

          const envPreference =
            process.env.GNOSIS_REVIEW_LLM_PREFERENCE === 'local' ? 'local' : 'cloud';
          const llmService = await getReviewLLMService(parsed.llmPreference ?? envPreference, {
            invoker: 'mcp',
            requestId,
          });

          let result: { markdown: string };
          switch (stage) {
            case 'a':
              result = await runReviewStageA(request, { llmService });
              break;
            case 'b':
              result = await runReviewStageB(request, { llmService });
              break;
            case 'c':
              result = await runReviewStageC(request, { llmService });
              break;
            case 'd':
              result = await runReviewStageD(request, { llmService });
              break;
            case 'e':
              result = await runReviewStageE(request, { llmService });
              break;
            default:
              result = await runReviewStageE(request, { llmService });
          }

          emitReviewDebugLog({
            event: 'mcp_review_success',
            requestId,
            stage,
            execMode,
            markdownLength: result.markdown.length,
          });
        } catch (error) {
          emitReviewDebugLog({
            event: 'mcp_review_error',
            requestId,
            error: error instanceof Error ? error.message : String(error),
          });
          console.error(`Background review failed (requestId: ${requestId}):`, error);
        }
      };

      runReview(); // Background execution
      return {
        content: [
          {
            type: 'text',
            text: `Review request accepted (requestId: ${requestId}). It will be processed in the background.`,
          },
        ],
      };
    },
  },
];
