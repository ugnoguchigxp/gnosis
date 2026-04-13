import { type LlmLogEvent, runLlmTask } from '../../../adapters/llm.js';
import type { LlmClientConfig } from '../../../config.js';
import type { FlowEvidence } from '../flows/types';

export type EvidenceExtractionInput = {
  topic: string;
  url: string;
  title: string;
  text: string;
  requestId?: string;
  now?: number;
  llmConfig?: Partial<LlmClientConfig>;
  llmLogger?: (event: LlmLogEvent) => void;
};

export type EvidenceExtractorDeps = {
  runLlmTask?: typeof runLlmTask;
};

export const extractEvidenceFromText = async (
  input: EvidenceExtractionInput,
  deps: EvidenceExtractorDeps = {},
): Promise<FlowEvidence> => {
  const runTask = deps.runLlmTask ?? runLlmTask;
  const result = await runTask(
    {
      task: 'extract_evidence',
      context: {
        topic: input.topic,
        url: input.url,
        title: input.title,
        text: input.text,
      },
      requestId: input.requestId,
    },
    {
      config: input.llmConfig,
      deps: input.llmLogger ? { logger: input.llmLogger } : undefined,
    },
  );

  const now = input.now ?? Date.now();
  const sourceId = `fetch:${Buffer.from(input.url).toString('base64').slice(0, 16)}`;

  return {
    claims: result.output.claims.map((c) => ({
      text: c.text,
      confidence: c.confidence,
      sourceIds: [sourceId],
    })),
    sources: [
      {
        id: sourceId,
        url: input.url,
        domain: new URL(input.url).hostname,
        fetchedAt: now,
      },
    ],
    normalizedSources: [
      {
        id: sourceId,
        url: input.url,
        domain: new URL(input.url).hostname,
        title: input.title,
        fetchedAt: now,
      },
    ],
    relations: (result.output.relations ?? []).map((r) => ({
      type: r.type,
      targetTopic: r.targetTopic,
      confidence: r.confidence,
    })),
  };
};
