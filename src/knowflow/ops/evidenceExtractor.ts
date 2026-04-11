import { runLlmTask } from '../adapters/llm';
import type { FlowEvidence } from '../flows/types';

export type EvidenceExtractionInput = {
  topic: string;
  url: string;
  title: string;
  text: string;
  requestId?: string;
  now?: number;
};

export const extractEvidenceFromText = async (
  input: EvidenceExtractionInput,
): Promise<FlowEvidence> => {
  const result = await runLlmTask({
    task: 'extract_evidence',
    context: {
      topic: input.topic,
      url: input.url,
      title: input.title,
      text: input.text,
    },
    requestId: input.requestId,
  });

  const now = input.now ?? Date.now();
  const sourceId = `fetch:${Buffer.from(input.url).toString('base64').slice(0, 16)}`;

  return {
    // biome-ignore lint/suspicious/noExplicitAny: c is from LLM output mapping
    claims: result.output.claims.map((c: any) => ({
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
    // biome-ignore lint/suspicious/noExplicitAny: r is from LLM output mapping
    relations: (result.output.relations ?? []).map((r: any) => ({
      type: r.type,
      targetTopic: r.targetTopic,
      confidence: r.confidence,
    })),
  };
};
