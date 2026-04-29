import { describe, expect, it, mock } from 'bun:test';
import {
  type FrontierCandidate,
  getFrontierImportanceScore,
  rerankFrontierCandidatesWithLlm,
} from '../../src/services/knowflow/frontier/selector.js';

const candidate = (input: Partial<FrontierCandidate> & Pick<FrontierCandidate, 'entityId'>) => ({
  name: input.entityId,
  type: 'concept',
  score: 0.4,
  deterministicScore: 0.4,
  importanceScore: 0.4,
  reason: 'test candidate',
  relationCount: 0,
  communityRank: 0,
  ...input,
});

describe('KnowFlow frontier selector', () => {
  it('treats reusable operational knowledge as high-value frontier material', () => {
    expect(getFrontierImportanceScore('risk')).toBeGreaterThan(
      getFrontierImportanceScore('concept'),
    );
    expect(getFrontierImportanceScore('procedure')).toBeGreaterThan(
      getFrontierImportanceScore('observation'),
    );
    expect(getFrontierImportanceScore('rule')).toBeGreaterThan(
      getFrontierImportanceScore('project_doc'),
    );
  });

  it('lets LLM ranking promote important candidates from the deterministic shortlist', async () => {
    const runLlmTask = mock(async () => ({
      degraded: false,
      output: {
        selected: [
          {
            entityId: 'procedure/high-value',
            score: 0.95,
            reason: 'Important procedure with sparse graph coverage.',
          },
        ],
      },
    }));

    const reranked = await rerankFrontierCandidatesWithLlm(
      [
        candidate({
          entityId: 'concept/common',
          type: 'concept',
          score: 0.8,
          deterministicScore: 0.8,
        }),
        candidate({
          entityId: 'procedure/high-value',
          type: 'procedure',
          score: 0.6,
          deterministicScore: 0.6,
          importanceScore: 0.95,
        }),
      ],
      { limit: 1, runLlmTask },
    );

    expect(reranked[0]?.entityId).toBe('procedure/high-value');
    expect(reranked[0]?.llmScore).toBe(0.95);
    expect(reranked[0]?.reason).toContain('LLM: Important procedure');
  });

  it('falls back to deterministic order when LLM output is degraded', async () => {
    const runLlmTask = mock(async () => ({
      degraded: true,
      output: { selected: [] },
    }));
    const candidates = [
      candidate({ entityId: 'rule/first', score: 0.7, deterministicScore: 0.7 }),
      candidate({ entityId: 'risk/second', score: 0.6, deterministicScore: 0.6 }),
    ];

    const reranked = await rerankFrontierCandidatesWithLlm(candidates, { limit: 2, runLlmTask });

    expect(reranked).toEqual(candidates);
  });
});
