import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { createLocalLlmRetriever } from '../../adapters/retriever/mcpRetriever.js';
import { config } from '../../config.js';
import { PgKnowledgeRepository } from '../../services/knowflow/knowledge/repository.js';
import { PgJsonbQueueRepository } from '../../services/knowflow/queue/pgJsonbRepository.js';
import {
  createKnowFlowTaskHandler,
  createMcpEvidenceProvider,
} from '../../services/knowflow/worker/knowFlowHandler.js';
import { runWorkerOnce } from '../../services/knowflow/worker/loop.js';
import type { ToolEntry } from '../registry.js';

const defaultGuidancePriority = config.guidance?.priorityLow ?? 50;

const enqueueKnowledgeTaskSchema = z.object({
  topic: z.string().describe('調査を開始するトピック名'),
  mode: z
    .enum(['directed', 'expand', 'explore'])
    .optional()
    .default('directed')
    .describe('調査モード'),
  priority: z
    .number()
    .optional()
    .default(defaultGuidancePriority)
    .describe('優先度 (高いほど先に実行)'),
});

const runKnowledgeWorkerSchema = z.object({
  maxAttempts: z.number().optional().default(1).describe('最大試行回数'),
});

export const knowflowTools: ToolEntry[] = [
  {
    name: 'enqueue_knowledge_task',
    description: `特定のトピックについて knowFlow に調査・知識化タスクを依頼します（非同期処理）。
バックグラウンドまたは run_knowledge_worker によって処理されます。`,
    inputSchema: zodToJsonSchema(enqueueKnowledgeTaskSchema) as Record<string, unknown>,
    handler: async (args) => {
      const input = enqueueKnowledgeTaskSchema.parse(args);
      const repository = new PgJsonbQueueRepository();
      const result = await repository.enqueue({
        topic: input.topic,
        mode: input.mode,
        source: 'user',
        priority: input.priority,
      });
      return {
        content: [
          {
            type: 'text',
            text: `Task enqueued successfully. taskId: ${result.task.id}, deduped: ${result.deduped}`,
          },
        ],
      };
    },
  },
  {
    name: 'run_knowledge_worker',
    description: `キューに溜まっている KnowFlow タスクを1つ取り出して実行します。
ウェブ検索や LLM による解析を伴うため、完了まで時間がかかる場合があります。`,
    inputSchema: zodToJsonSchema(runKnowledgeWorkerSchema) as Record<string, unknown>,
    handler: async (args) => {
      const { maxAttempts } = runKnowledgeWorkerSchema.parse(args);
      const queueRepo = new PgJsonbQueueRepository();
      const knowledgeRepo = new PgKnowledgeRepository();
      const retriever = createLocalLlmRetriever(config.localLlmPath);
      const evidenceProvider = createMcpEvidenceProvider(retriever);
      const handler = createKnowFlowTaskHandler({
        repository: knowledgeRepo,
        evidenceProvider,
      });
      const result = await runWorkerOnce(queueRepo, handler, { maxAttempts });
      return {
        content: [
          {
            type: 'text',
            text: result.processed
              ? `Task processed: ${result.taskId}, status: ${result.status}`
              : 'No pending tasks in queue.',
          },
        ],
      };
    },
  },
];
