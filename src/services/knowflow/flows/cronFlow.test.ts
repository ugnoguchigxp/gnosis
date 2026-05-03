import { describe, expect, it, vi } from 'bun:test';
import type { Knowledge } from '../knowledge/types';
import { runCronFlow } from './cronFlow';
import type { CronFlowRepository } from './cronFlow';
import type { FlowEvidence } from './types';

const createRepository = (): CronFlowRepository => ({
  getByTopic: vi.fn(async () => null),
  merge: vi.fn(async () => ({
    knowledge: {
      id: 'k1',
      canonicalTopic: 'test topic',
      aliases: [],
      claims: [],
      relations: [],
      sources: [],
      confidence: 0,
      coverage: 0,
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } satisfies Knowledge,
    changed: true,
  })),
});

const baseEvidence: FlowEvidence = {
  claims: [
    {
      text: 'TypeScript strict mode can improve bug detection in large codebases.',
      confidence: 0.9,
      sourceIds: ['s1', 's2'],
    },
  ],
  sources: [
    { id: 's1', domain: 'docs.typescriptlang.org', fetchedAt: Date.now(), qualityScore: 0.9 },
    { id: 's2', domain: 'developer.mozilla.org', fetchedAt: Date.now(), qualityScore: 0.9 },
  ],
  normalizedSources: [
    {
      id: 's1',
      url: 'https://docs.typescriptlang.org/tsconfig#strict',
      domain: 'docs.typescriptlang.org',
      fetchedAt: Date.now(),
    },
    {
      id: 's2',
      url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
      domain: 'developer.mozilla.org',
      fetchedAt: Date.now(),
    },
  ],
  relations: [],
  queryCountUsed: 1,
};

describe('runCronFlow registration gating', () => {
  it('skips merge when LLM registration decision is deny', async () => {
    const repository = createRepository();

    const result = await runCronFlow({
      topic: 'TypeScript strict mode',
      evidence: baseEvidence,
      repository,
      cronBudget: 10,
      cronRunBudget: 10,
      cronRunConsumed: 0,
      evaluateRegistration: async () => ({
        allow: false,
        reason: 'insufficient novelty',
        confidence: 0.8,
      }),
    });

    expect(result.changed).toBe(false);
    expect(result.registrationDecision?.allow).toBe(false);
    expect(result.summary).toContain('registration=skip');
    expect(repository.merge).toHaveBeenCalledTimes(0);
  });

  it('executes merge when LLM registration decision is allow', async () => {
    const repository = createRepository();

    const result = await runCronFlow({
      topic: 'TypeScript strict mode',
      evidence: baseEvidence,
      repository,
      cronBudget: 10,
      cronRunBudget: 10,
      cronRunConsumed: 0,
      evaluateRegistration: async () => ({
        allow: true,
        reason: 'actionable and supported',
        confidence: 0.9,
      }),
    });

    expect(result.changed).toBe(true);
    expect(result.registrationDecision?.allow).toBe(true);
    expect(result.summary).toContain('registration=allow');
    expect(repository.merge).toHaveBeenCalledTimes(1);
  });
});
