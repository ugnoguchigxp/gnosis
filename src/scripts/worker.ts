import { resolve } from 'node:path';
import { createLocalLlmRetriever } from '../adapters/retriever/mcpRetriever.js';
import { config } from '../config.js';
import { PgKnowledgeRepository } from '../services/knowflow/knowledge/repository.js';
import { createRunLogger } from '../services/knowflow/ops/runLog.js';
import { PgJsonbQueueRepository } from '../services/knowflow/queue/pgJsonbRepository.js';
import {
  createKnowFlowTaskHandler,
  createMcpEvidenceProvider,
} from '../services/knowflow/worker/knowFlowHandler.js';
import { runWorkerLoop } from '../services/knowflow/worker/loop.js';

async function main() {
  const runLogger = await createRunLogger({ runId: `worker-daemon-${Date.now()}` });
  const logger = runLogger.createStructuredLogger({ verbose: true });
  const llmLogger = runLogger.createLlmLogger({ verbose: true });

  console.log('--- Gnosis KnowFlow Worker Daemon Start ---');

  const queueRepository = new PgJsonbQueueRepository();
  const knowledgeRepository = new PgKnowledgeRepository();

  // localLlm のパス解決（プロジェクトルートからの相対パスを想定）
  const localLlmPath = resolve(process.cwd(), '../localLlm');
  const retriever = createLocalLlmRetriever(localLlmPath);

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

  try {
    await runWorkerLoop(queueRepository, handler, {
      workerId: `daemon-${process.pid}`,
      intervalMs: 10000, // 10秒おきにキューを確認
      logger,
    });
  } catch (error) {
    console.error('Worker Daemon Critical Error:', error);
    process.exit(1);
  }
}

main();
