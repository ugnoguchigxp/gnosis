import { resolve } from 'node:path';
import { runLlmTask } from '../../adapters/llm.js';
import type { LlmLogEvent } from '../../adapters/llm.js';
import { createLocalLlmRetriever } from '../../adapters/retriever/mcpRetriever.js';
import { type BudgetConfig, type LlmClientConfig, config } from '../../config.js';
import { searchKnowledgeClaims } from '../knowledge.js';
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
import { loadKnowflowProfile, mergeBudgetConfig, mergeLlmConfig } from './utils/profile';
import {
  type EvidenceProvider,
  createKnowFlowTaskHandler,
  createMcpEvidenceProvider,
} from './worker/knowFlowHandler';
import { type TaskHandler, runWorkerLoop, runWorkerOnce } from './worker/loop';

const usage = `Usage:
  bun src/services/knowflow/cli.ts enqueue --topic <text> [--mode directed|expand|explore] [--source user|cron] [--priority <n>] [--requested-by <id>] [--dry-run]
  bun src/services/knowflow/cli.ts run-once [--worker-id <id>] [--max-attempts <n>] [--fail] [--local-llm-path <path>]
  bun src/services/knowflow/cli.ts run-worker [--worker-id <id>] [--interval-ms <n>] [--max-iterations <n>] [--max-attempts <n>] [--fail] [--local-llm-path <path>]
  bun src/services/knowflow/cli.ts llm-task --task hypothesis|query_generation|gap_detection|gap_planner|summarize|extract_evidence --context-json <json>
  bun src/services/knowflow/cli.ts search-knowledge --query <text> [--limit <n>]
  bun src/services/knowflow/cli.ts get-knowledge --topic <text>
  bun src/services/knowflow/cli.ts merge-knowledge --input <json> [--dry-run]
  bun src/services/knowflow/cli.ts eval-run [--suite local]

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
  budgetOverride?: Partial<BudgetConfig>;
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

  const repository = new PgKnowledgeRepository();
  let evidenceProvider: EvidenceProvider | undefined;
  if (options.localLlmPath) {
    const retriever = createLocalLlmRetriever(resolve(options.localLlmPath));
    evidenceProvider = createMcpEvidenceProvider(retriever, {
      logger: options.logger,
      llmConfig: options.llmConfig,
      llmLogger: options.llmLogger,
    });
  }

  return createKnowFlowTaskHandler({
    repository,
    evidenceProvider,
    budget: options.budgetOverride,
    logger: options.logger,
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
  const runLogger = await createRunLogger({
    runId: readStringFlag(args, 'run-id'),
  });

  try {
    const profileInput = readStringFlag(args, 'profile');
    const profileInfo = await loadKnowflowProfile(profileInput);
    const profilePath = profileInfo?.path;

    const localLlmPath =
      readStringFlag(args, 'local-llm-path') ?? profileInfo?.profile.localLlmPath;
    const llmConfig = mergeLlmConfig(config.knowflow.llm, profileInfo?.profile.knowflow?.llm);
    const budgetConfig = mergeBudgetConfig(
      config.knowflow.budget,
      profileInfo?.profile.knowflow?.budget,
    );

    const logger = runLogger.createStructuredLogger({ verbose });
    const llmLogger = runLogger.createLlmLogger({ verbose });

    runLogger.log('cli.start', {
      command,
      argv: rest,
      outputFormat,
      verbose,
      dryRun,
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

    // PostgreSQL (Drizzle) backend is fixed.
    const buildQueueRepository = () => new PgJsonbQueueRepository();

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
        budgetOverride: budgetConfig,
        llmConfig,
        logger,
        llmLogger,
      });

      const result = await runWorkerOnce(repository, handler, {
        workerId,
        maxAttempts,
        logger,
      });

      writeResult({
        command,
        runId: runLogger.runId,
        profilePath,
        workerId,
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
        budgetOverride: budgetConfig,
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

      const task = LlmTaskNameSchema.parse(taskRaw);
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

      const repository = new PgKnowledgeRepository();
      const result = await repository.getByTopic(topic);
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

      const repository = new PgKnowledgeRepository();
      const result = await repository.merge(input);
      writeResult({
        command,
        runId: runLogger.runId,
        profilePath,
        ...result,
      });
      return;
    }

    if (command === 'eval-run') {
      writeErrorOnlyForMutationCommands(command);
      const suiteName = readStringFlag(args, 'suite') ?? 'local';
      const result = await runEvalSuite({
        suiteName,
        llmConfig,
        requestPrefix: runLogger.runId,
        llmLogger,
      });
      writeResult({
        command,
        runId: runLogger.runId,
        profilePath,
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

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n\n${usage}`);
  process.exitCode = 1;
});
