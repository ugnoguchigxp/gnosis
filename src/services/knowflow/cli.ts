import { resolve } from 'node:path';
import { runLlmTask } from '../../adapters/llm.js';
import type { LlmLogEvent } from '../../adapters/llm.js';
import { createLocalLlmRetriever } from '../../adapters/retriever/mcpRetriever.js';
import { type LlmClientConfig, config } from '../../config.js';
import { db as defaultDb } from '../../db/index.js';
import { searchKnowledgeClaims } from '../knowledge.js';
import { runKeywordSeederOnce } from './cron/keywordSeeder';
import { type TaskMode, type TaskSource, createTask } from './domain/task';
import { runEvalSuite } from './eval/runner';
import { PgKnowledgeRepository } from './knowledge/repository';
import { KnowledgeUpsertInputSchema } from './knowledge/types';
import type { StructuredLogger } from './ops/logger';
import { createRunLogger } from './ops/runLog';
import { PgJsonbQueueRepository } from './queue/pgJsonbRepository';
import { LlmTaskNameSchema } from './schemas/llm';
import { parseArgMap, readBooleanFlag, readNumberFlag, readStringFlag } from './utils/args';
import { renderOutput, resolveOutputFormat } from './utils/output';
import { loadKnowflowProfile, mergeLlmConfig } from './utils/profile';
import {
  type EvidenceProvider,
  createKnowFlowTaskHandler,
  createMcpEvidenceProvider,
} from './worker/knowFlowHandler';
import { type TaskHandler, runWorkerLoop, runWorkerOnce } from './worker/loop';

const usage = `Usage:
  bun src/services/knowflow/cli.ts enqueue --topic <text> [--mode directed|expand|explore] [--source user|cron] [--priority <n>] [--requested-by <id>] [--dry-run]
  bun src/services/knowflow/cli.ts run-once [--worker-id <id>] [--max-attempts <n>] [--fail] [--local-llm-path <path>] [--strict-complete]
  bun src/services/knowflow/cli.ts run-worker [--worker-id <id>] [--interval-ms <n>] [--max-iterations <n>] [--max-attempts <n>] [--fail] [--local-llm-path <path>]
  bun src/services/knowflow/cli.ts llm-task --task phrase_scout|research_note --context-json <json>
  bun src/services/knowflow/cli.ts search-knowledge --query <text> [--limit <n>]
  bun src/services/knowflow/cli.ts get-knowledge --topic <text>
  bun src/services/knowflow/cli.ts merge-knowledge --input <json> [--dry-run]
  bun src/services/knowflow/cli.ts seed-phrases [--limit <n>]
  bun src/services/knowflow/cli.ts eval-run [--suite local] [--mock]

Global options:
  --json | --table
  --verbose
  --run-id <id>
  --profile <name-or-path>
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
  localLlmPath?: string;
  llmConfig?: Partial<LlmClientConfig>;
  logger?: StructuredLogger;
  llmLogger?: (event: LlmLogEvent) => void;
}): TaskHandler => {
  if (options.simulateFailure) {
    return async (task) => ({
      ok: false,
      error: `Simulated failure for topic=${task.topic}`,
    });
  }

  const repository = new PgKnowledgeRepository({}, defaultDb);
  const queueRepository = new PgJsonbQueueRepository(defaultDb);
  let evidenceProvider: EvidenceProvider | undefined;
  let retriever: ReturnType<typeof createLocalLlmRetriever> | undefined;
  if (options.localLlmPath) {
    retriever = createLocalLlmRetriever(resolve(options.localLlmPath));
    evidenceProvider = createMcpEvidenceProvider(retriever, {
      logger: options.logger,
      llmConfig: options.llmConfig,
      llmLogger: options.llmLogger,
      getExistingKnowledge: (topic) => repository.getByTopic(topic),
    });
  }

  const handler = createKnowFlowTaskHandler({
    evidenceProvider,
    logger: options.logger,
  });

  return async (task, signal) => {
    try {
      return await handler(task, signal);
    } finally {
      await retriever?.disconnect();
    }
  };
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

const run = async () => {
  const [, , command, ...rest] = process.argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stderr.write(usage);
    process.exitCode = command ? 0 : 1;
    return;
  }

  const args = parseArgMap(rest);
  if ('handler' in args) {
    throw new Error(
      '--handler is no longer supported. run-once and run-worker always use knowflow handler',
    );
  }

  const outputFormat = resolveOutputFormat(args);
  const verbose = readBooleanFlag(args, 'verbose');
  const dryRun = readBooleanFlag(args, 'dry-run');
  const strictComplete = readBooleanFlag(args, 'strict-complete');
  const runLogger = await createRunLogger({
    runId: readStringFlag(args, 'run-id'),
  });

  try {
    const profileInput = readStringFlag(args, 'profile');
    const profileInfo = await loadKnowflowProfile(profileInput);
    const profilePath = profileInfo?.path;

    const localLlmPath =
      readStringFlag(args, 'local-llm-path') ??
      profileInfo?.profile.localLlmPath ??
      config.localLlmPath;
    const llmConfig = mergeLlmConfig(config.knowflow.llm, profileInfo?.profile.knowflow?.llm);

    const logger = runLogger.createStructuredLogger({ verbose });
    const llmLogger = runLogger.createLlmLogger({ verbose });

    runLogger.log('cli.start', {
      command,
      argv: rest,
      outputFormat,
      verbose,
      dryRun,
      strictComplete,
      profilePath,
    });

    const writeResult = (payload: Record<string, unknown>) => {
      process.stdout.write(renderOutput(payload, outputFormat));
      runLogger.log('cli.result', payload);
    };

    const writeErrorOnlyForMutationCommands = (commandName: string) => {
      if (!dryRun) return;
      if (commandName === 'enqueue' || commandName === 'merge-knowledge') {
        return;
      }
      throw new Error('--dry-run is supported only for enqueue and merge-knowledge');
    };

    if (strictComplete && command !== 'run-once') {
      throw new Error('--strict-complete is supported only for run-once');
    }

    // PostgreSQL (Drizzle) backend is fixed.
    const buildQueueRepository = () => new PgJsonbQueueRepository(defaultDb);

    if (command === 'enqueue') {
      const topic = readStringFlag(args, 'topic');
      if (!topic) {
        throw new Error('--topic is required for enqueue');
      }

      const mode = parseMode(readStringFlag(args, 'mode'));
      const source = parseSource(readStringFlag(args, 'source'));
      const priority = readNumberFlag(args, 'priority');
      const requestedBy = readStringFlag(args, 'requested-by');

      if (dryRun) {
        const taskPreview = createTask({
          topic,
          mode,
          source,
          priority,
          requestedBy,
        });
        writeResult({
          command,
          runId: runLogger.runId,
          dryRun: true,
          profilePath,
          taskPreview,
          note: 'dedupe check skipped in dry-run',
        });
        return;
      }

      const repository = buildQueueRepository();
      const result = await repository.enqueue({
        topic,
        mode,
        source,
        priority,
        requestedBy,
      });

      writeResult({
        command,
        runId: runLogger.runId,
        profilePath,
        deduped: result.deduped,
        task: result.task,
      });
      return;
    }

    if (command === 'run-once') {
      writeErrorOnlyForMutationCommands(command);
      const repository = buildQueueRepository();
      const workerId = readStringFlag(args, 'worker-id') ?? `worker-${process.pid}`;
      const maxAttempts = readNumberFlag(args, 'max-attempts');
      const handler = createHandler({
        simulateFailure: readBooleanFlag(args, 'fail'),
        localLlmPath,
        llmConfig,
        logger,
        llmLogger,
      });

      const result = await runWorkerOnce(repository, handler, {
        workerId,
        maxAttempts,
        logger,
      });

      if (strictComplete) {
        if (!result.processed) {
          throw new Error('--strict-complete failed: no runnable task was processed');
        }
        if (result.status !== 'done') {
          const errorDetail = result.error ? ` error=${result.error}` : '';
          throw new Error(
            `--strict-complete failed: task ${result.taskId} ended with status=${result.status}.${errorDetail}`,
          );
        }
      }

      writeResult({
        command,
        runId: runLogger.runId,
        profilePath,
        workerId,
        strictComplete,
        result,
      });
      return;
    }

    if (command === 'run-worker') {
      writeErrorOnlyForMutationCommands(command);
      const repository = buildQueueRepository();
      const workerId = readStringFlag(args, 'worker-id') ?? `worker-${process.pid}`;
      const maxAttempts = readNumberFlag(args, 'max-attempts');
      const intervalMs = readNumberFlag(args, 'interval-ms') ?? 1_000;
      const maxIterations = readNumberFlag(args, 'max-iterations');
      const handler = createHandler({
        simulateFailure: readBooleanFlag(args, 'fail'),
        localLlmPath,
        llmConfig,
        logger,
        llmLogger,
      });

      await runWorkerLoop(repository, handler, {
        workerId,
        maxAttempts,
        intervalMs,
        maxIterations,
        logger,
      });

      writeResult({
        command,
        runId: runLogger.runId,
        profilePath,
        status: 'stopped',
        workerId,
      });
      return;
    }

    if (command === 'llm-task') {
      writeErrorOnlyForMutationCommands(command);
      const taskRaw = readStringFlag(args, 'task');
      if (!taskRaw) {
        throw new Error('--task is required for llm-task');
      }

      const parsedTask = LlmTaskNameSchema.safeParse(taskRaw.trim());
      if (!parsedTask.success) {
        throw new Error('--task must be phrase_scout or research_note');
      }
      const task = parsedTask.data;
      const context = parseContextJson(readStringFlag(args, 'context-json'));
      const requestId = readStringFlag(args, 'request-id') ?? runLogger.runId;

      const result = await runLlmTask(
        {
          task,
          context,
          requestId,
        },
        {
          config: llmConfig,
          deps: { logger: llmLogger },
        },
      );

      writeResult({
        command,
        runId: runLogger.runId,
        profilePath,
        result,
      });
      return;
    }

    if (command === 'search-knowledge') {
      writeErrorOnlyForMutationCommands(command);
      const query = readStringFlag(args, 'query');
      if (!query) {
        throw new Error('--query is required for search-knowledge');
      }
      const limit = readNumberFlag(args, 'limit') ?? 5;
      const results = await searchKnowledgeClaims(query, limit);
      writeResult({
        command,
        runId: runLogger.runId,
        profilePath,
        query,
        limit,
        results,
      });
      return;
    }

    if (command === 'get-knowledge') {
      writeErrorOnlyForMutationCommands(command);
      const topic = readStringFlag(args, 'topic');
      if (!topic) {
        throw new Error('--topic is required for get-knowledge');
      }

      const knowledgeRepository = new PgKnowledgeRepository({}, defaultDb);
      const result = await knowledgeRepository.getByTopic(topic);
      writeResult({
        command,
        runId: runLogger.runId,
        profilePath,
        result,
      });
      return;
    }

    if (command === 'merge-knowledge') {
      const inputRaw = readStringFlag(args, 'input');
      if (!inputRaw) {
        throw new Error('--input is required for merge-knowledge');
      }
      const input = KnowledgeUpsertInputSchema.parse(JSON.parse(inputRaw));

      if (dryRun) {
        writeResult({
          command,
          runId: runLogger.runId,
          dryRun: true,
          profilePath,
          preview: {
            topic: input.topic,
            aliases: input.aliases.length,
            claims: input.claims.length,
            relations: input.relations.length,
            sources: input.sources.length,
          },
        });
        return;
      }

      const repository = new PgKnowledgeRepository({}, defaultDb);
      const result = await repository.merge(input);
      writeResult({
        command,
        runId: runLogger.runId,
        profilePath,
        ...result,
      });
      return;
    }

    if (command === 'seed-phrases') {
      writeErrorOnlyForMutationCommands(command);
      const limit = readNumberFlag(args, 'limit');
      const result = await runKeywordSeederOnce({
        database: defaultDb,
        queueRepository: buildQueueRepository(),
        maxTopics: limit,
      });
      writeResult({
        command,
        runId: runLogger.runId,
        profilePath,
        result,
      });
      return;
    }

    if (command === 'eval-run') {
      writeErrorOnlyForMutationCommands(command);
      if ('max-degraded-rate' in args) {
        throw new Error('--max-degraded-rate is no longer supported; eval-run uses pass/fail only');
      }
      const suiteName = readStringFlag(args, 'suite') ?? 'local';
      const mockMode = readBooleanFlag(args, 'mock');
      const result = await runEvalSuite({
        suiteName,
        llmConfig,
        requestPrefix: runLogger.runId,
        llmLogger,
        mode: mockMode ? 'mock' : 'live',
      });
      writeResult({
        command,
        runId: runLogger.runId,
        profilePath,
        mode: mockMode ? 'mock' : 'live',
        result,
      });
      return;
    }

    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    runLogger.log('cli.error', {
      command,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await runLogger.flush();
  }
};

if (import.meta.main) {
  run().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n\n${usage}`);
    process.exitCode = 1;
  });
}
