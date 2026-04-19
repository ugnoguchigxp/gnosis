import { createLocalLlmRetriever } from '../src/adapters/retriever/mcpRetriever.js';
import { config } from '../src/config.js';
import { PgKnowledgeRepository } from '../src/services/knowflow/knowledge/repository.js';
import { checkLlmHealth } from '../src/services/knowflow/ops/healthCheck.js';
import { createRunLogger } from '../src/services/knowflow/ops/runLog.js';
import { PgJsonbQueueRepository } from '../src/services/knowflow/queue/pgJsonbRepository.js';
import {
  createKnowFlowTaskHandler,
  createMcpEvidenceProvider,
} from '../src/services/knowflow/worker/knowFlowHandler.js';
import { runWorkerOnce } from '../src/services/knowflow/worker/loop.js';

async function main() {
  const runId = `exec-once-${Date.now()}`;
  const runLogger = await createRunLogger({ runId });
  const logger = runLogger.createStructuredLogger({ verbose: true });
  const llmLogger = runLogger.createLlmLogger({ verbose: true });

  console.log(`--- Gnosis KnowFlow Run-Once Execution (ID: ${runId}) ---`);

  const queueRepository = new PgJsonbQueueRepository();
  const knowledgeRepository = new PgKnowledgeRepository();
  const retriever = createLocalLlmRetriever(config.localLlmPath);

  const evidenceProvider = createMcpEvidenceProvider(retriever, {
    logger,
    llmConfig: config.knowflow.llm,
    llmLogger,
  });

  const handler = createKnowFlowTaskHandler({
    repository: knowledgeRepository,
    evidenceProvider,
    budget: config.knowflow.budget,
    logger,
  });

  const health = await checkLlmHealth(config.knowflow.llm, logger);
  if (!health.ok) {
    console.error('LLM Health Check Failed. Aborting.');
    process.exit(1);
  }

  const result = await runWorkerOnce(queueRepository, handler, {
    workerId: `exec-once-${process.pid}`,
    logger,
  });

  if (result.processed) {
    console.log(`Successfully processed task: ${result.taskId}. Status: ${result.status}`);
  } else {
    console.log('No pending tasks found.');
  }
}

main().catch(console.error);
