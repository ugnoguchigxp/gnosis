import { resolve } from 'node:path';
import { runLlmTask } from '../../adapters/llm.js';
import { createLocalLlmRetriever } from '../../adapters/retriever/mcpRetriever.js';
import type { TaskMode, TaskSource } from './domain/task';
import { PgKnowledgeRepository } from './knowledge/repository';
import { PgJsonbQueueRepository } from './queue/pgJsonbRepository';
import { LlmTaskNameSchema } from './schemas/llm';
import { parseArgMap, readBooleanFlag, readNumberFlag, readStringFlag } from './utils/args';
import {
  type EvidenceProvider,
  createKnowFlowTaskHandler,
  createMcpEvidenceProvider,
} from './worker/knowFlowHandler';
import { type TaskHandler, defaultTaskHandler, runWorkerLoop, runWorkerOnce } from './worker/loop';

const usage = `Usage:
  bun src/services/knowflow/cli.ts enqueue --topic <text> [--mode directed|expand|explore] [--source user|cron] [--priority <n>]
  bun src/services/knowflow/cli.ts run-once [--worker-id <id>] [--max-attempts <n>] [--handler default|knowflow] [--fail] [--local-llm-path <path>]
  bun src/services/knowflow/cli.ts run-worker [--worker-id <id>] [--interval-ms <n>] [--max-iterations <n>] [--max-attempts <n>] [--handler default|knowflow] [--fail] [--local-llm-path <path>]
  bun src/services/knowflow/cli.ts llm-task --task hypothesis|query_generation|gap_detection|gap_planner|summarize --context-json <json>
`;

const parseContextJson = (raw: string | undefined): Record<string, unknown> => {
  if (!raw) {
    return {};
  }
  const parsed = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('--context-json must be a JSON object');
  }
  return parsed as Record<string, unknown>;
};

const createHandler = (options: {
  simulateFailure: boolean;
  handlerName?: string;
  localLlmPath?: string;
}): TaskHandler => {
  if (options.handlerName === 'knowflow') {
    const repository = new PgKnowledgeRepository();
    let evidenceProvider: EvidenceProvider | undefined;
    if (options.localLlmPath) {
      const retriever = createLocalLlmRetriever(resolve(options.localLlmPath));
      evidenceProvider = createMcpEvidenceProvider(retriever);
    }

    return createKnowFlowTaskHandler({
      repository,
      evidenceProvider,
    });
  }

  const simulateFailure = options.simulateFailure;
  if (!simulateFailure) {
    return defaultTaskHandler;
  }

  return async (task) => ({
    ok: false,
    error: `Simulated failure for topic=${task.topic}`,
  });
};

const parseMode = (raw?: string): TaskMode => {
  if (raw === 'directed' || raw === 'expand' || raw === 'explore') {
    return raw;
  }
  return 'directed';
};

const parseSource = (raw?: string): TaskSource => {
  if (raw === 'user' || raw === 'cron') {
    return raw;
  }
  return 'user';
};

const parseHandlerName = (raw?: string): 'default' | 'knowflow' | undefined => {
  if (!raw) {
    return undefined;
  }
  if (raw === 'default' || raw === 'knowflow') {
    return raw;
  }
  throw new Error('--handler must be one of default|knowflow');
};

const run = async () => {
  const [, , command, ...rest] = process.argv;
  if (!command) {
    process.stderr.write(usage);
    process.exitCode = 1;
    return;
  }

  const args = parseArgMap(rest);
  const localLlmPath = readStringFlag(args, 'local-llm-path');
  const handlerName = parseHandlerName(readStringFlag(args, 'handler'));

  // 統合後は常に PostgreSQL (Drizzle) バックエンド固定
  const buildQueueRepository = () => new PgJsonbQueueRepository();

  if (command === 'enqueue') {
    const repository = buildQueueRepository();
    const topic = readStringFlag(args, 'topic');
    if (!topic) {
      throw new Error('--topic is required for enqueue');
    }

    const mode = parseMode(readStringFlag(args, 'mode'));
    const source = parseSource(readStringFlag(args, 'source'));
    const priority = readNumberFlag(args, 'priority');
    const requestedBy = readStringFlag(args, 'requested-by');

    const result = await repository.enqueue({
      topic,
      mode,
      source,
      priority,
      requestedBy,
    });

    process.stdout.write(
      `${JSON.stringify({ command, deduped: result.deduped, task: result.task }, null, 2)}\n`,
    );
    return;
  }

  if (command === 'run-once') {
    const repository = buildQueueRepository();
    const workerId = readStringFlag(args, 'worker-id') ?? `worker-${process.pid}`;
    const maxAttempts = readNumberFlag(args, 'max-attempts');
    const handler = createHandler({
      simulateFailure: readBooleanFlag(args, 'fail'),
      handlerName,
      localLlmPath,
    });

    const result = await runWorkerOnce(repository, handler, {
      workerId,
      maxAttempts,
    });

    process.stdout.write(`${JSON.stringify({ command, ...result }, null, 2)}\n`);
    return;
  }

  if (command === 'run-worker') {
    const repository = buildQueueRepository();
    const workerId = readStringFlag(args, 'worker-id') ?? `worker-${process.pid}`;
    const maxAttempts = readNumberFlag(args, 'max-attempts');
    const intervalMs = readNumberFlag(args, 'interval-ms') ?? 1_000;
    const maxIterations = readNumberFlag(args, 'max-iterations');
    const handler = createHandler({
      simulateFailure: readBooleanFlag(args, 'fail'),
      handlerName,
      localLlmPath,
    });

    await runWorkerLoop(repository, handler, {
      workerId,
      maxAttempts,
      intervalMs,
      maxIterations,
    });

    process.stdout.write(`${JSON.stringify({ command, status: 'stopped', workerId }, null, 2)}\n`);
    return;
  }

  if (command === 'llm-task') {
    const taskRaw = readStringFlag(args, 'task');
    if (!taskRaw) {
      throw new Error('--task is required for llm-task');
    }

    const task = LlmTaskNameSchema.parse(taskRaw);
    const context = parseContextJson(readStringFlag(args, 'context-json'));
    const requestId = readStringFlag(args, 'request-id');

    const result = await runLlmTask({
      task,
      context,
      requestId,
    });

    process.stdout.write(`${JSON.stringify({ command, ...result }, null, 2)}\n`);
    return;
  }

  if (command === 'search-knowledge') {
    const query = readStringFlag(args, 'query');
    if (!query) {
      throw new Error('--query is required for search-knowledge');
    }
    const repository = new PgKnowledgeRepository();
    const results = await repository.searchTopics(query);
    process.stdout.write(`${JSON.stringify({ command, results }, null, 2)}\n`);
    return;
  }

  if (command === 'get-knowledge') {
    const topic = readStringFlag(args, 'topic');
    if (!topic) {
      throw new Error('--topic is required for get-knowledge');
    }
    const repository = new PgKnowledgeRepository();
    const result = await repository.getByTopic(topic);
    process.stdout.write(`${JSON.stringify({ command, result }, null, 2)}\n`);
    return;
  }

  if (command === 'merge-knowledge') {
    const inputRaw = readStringFlag(args, 'input');
    if (!inputRaw) {
      throw new Error('--input is required for merge-knowledge');
    }
    const input = JSON.parse(inputRaw);
    const repository = new PgKnowledgeRepository();
    const result = await repository.merge(input);
    process.stdout.write(`${JSON.stringify({ command, ...result }, null, 2)}\n`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
};

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n\n${usage}`);
  process.exitCode = 1;
});
