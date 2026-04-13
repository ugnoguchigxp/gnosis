import { describe, expect, it, mock } from 'bun:test';
import type { runLlmTask } from '../../src/adapters/llm';
import { extractEvidenceFromText } from '../../src/services/knowflow/ops/evidenceExtractor';

const makeRunLlmTask = (
  claims: Array<{ text: string; confidence: number }>,
  relations: Array<{ type: string; targetTopic: string; confidence: number }> = [],
) =>
  mock(async () => ({
    task: 'extract_evidence' as const,
    output: { claims, relations },
    backend: 'api' as const,
    degraded: false,
    warnings: [],
  })) as unknown as typeof runLlmTask;

const baseInput = {
  topic: 'TypeScript',
  url: 'https://example.com/article',
  title: 'TypeScript Deep Dive',
  text: 'TypeScript adds static types to JavaScript.',
  requestId: 'req-1',
  now: 1_700_000_000_000,
};

describe('extractEvidenceFromText', () => {
  it('maps LLM claims to FlowEvidence claims with sourceId', async () => {
    const runLlmTask = makeRunLlmTask([
      { text: 'TypeScript is a superset of JavaScript', confidence: 0.9 },
    ]);

    const result = await extractEvidenceFromText(baseInput, { runLlmTask });

    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]?.text).toBe('TypeScript is a superset of JavaScript');
    expect(result.claims[0]?.confidence).toBe(0.9);
    expect(result.claims[0]?.sourceIds).toHaveLength(1);
  });

  it('attaches source with URL and domain derived from input', async () => {
    const runLlmTask = makeRunLlmTask([{ text: 'A claim', confidence: 0.8 }]);

    const result = await extractEvidenceFromText(baseInput, { runLlmTask });

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.url).toBe('https://example.com/article');
    expect(result.sources[0]?.domain).toBe('example.com');
    expect(result.sources[0]?.fetchedAt).toBe(1_700_000_000_000);
  });

  it('includes normalizedSources with title', async () => {
    const runLlmTask = makeRunLlmTask([{ text: 'claim', confidence: 0.7 }]);

    const result = await extractEvidenceFromText(baseInput, { runLlmTask });

    expect(result.normalizedSources ?? []).toHaveLength(1);
    const ns = (result.normalizedSources ?? [])[0];
    expect(ns?.title).toBe('TypeScript Deep Dive');
  });

  it('maps LLM relations to FlowEvidence relations', async () => {
    const runLlmTask = makeRunLlmTask(
      [{ text: 'claim', confidence: 0.8 }],
      [{ type: 'related_to', targetTopic: 'JavaScript', confidence: 0.95 }],
    );

    const result = await extractEvidenceFromText(baseInput, { runLlmTask });

    const relations = result.relations ?? [];
    expect(relations).toHaveLength(1);
    expect(relations[0]?.type).toBe('related_to');
    expect(relations[0]?.targetTopic).toBe('JavaScript');
  });

  it('handles empty claims and relations gracefully', async () => {
    const runLlmTask = makeRunLlmTask([]);

    const result = await extractEvidenceFromText(baseInput, { runLlmTask });

    expect(result.claims).toEqual([]);
    expect(result.relations ?? []).toEqual([]);
    expect(result.sources).toHaveLength(1);
  });

  it('uses Date.now() as fetchedAt when now is not provided', async () => {
    const runLlmTask = makeRunLlmTask([{ text: 'claim', confidence: 0.5 }]);
    const before = Date.now();

    const result = await extractEvidenceFromText({ ...baseInput, now: undefined }, { runLlmTask });

    const after = Date.now();
    const fetchedAt = result.sources[0]?.fetchedAt ?? 0;
    expect(fetchedAt).toBeGreaterThanOrEqual(before);
    expect(fetchedAt).toBeLessThanOrEqual(after);
  });

  it('uses claim sourceId that links to source id', async () => {
    const runLlmTask = makeRunLlmTask([{ text: 'claim', confidence: 0.6 }]);

    const result = await extractEvidenceFromText(baseInput, { runLlmTask });

    const claimSourceId = result.claims[0]?.sourceIds?.[0];
    const sourceId = result.sources[0]?.id;
    expect(claimSourceId).toBe(sourceId);
  });
});
