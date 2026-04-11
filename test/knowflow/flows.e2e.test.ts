import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCronFlow } from '../../src/services/knowflow/flows/cronFlow';
import { runUserFlow } from '../../src/services/knowflow/flows/userFlow';
import type { Knowledge, KnowledgeUpsertInput } from '../../src/services/knowflow/knowledge/types';
import { FileQueueRepository } from '../../src/services/knowflow/queue/repository';
import { createKnowFlowTaskHandler } from '../../src/services/knowflow/worker/knowFlowHandler';
import { runWorkerOnce } from '../../src/services/knowflow/worker/loop';

class InMemoryKnowledgeRepository {
  private readonly map = new Map<string, Knowledge>();

  async getByTopic(topic: string): Promise<Knowledge | null> {
    return this.map.get(topic.toLowerCase()) ?? null;
  }

  async merge(input: KnowledgeUpsertInput): Promise<{ knowledge: Knowledge; changed: boolean }> {
    const key = input.topic.toLowerCase();
    const existing = this.map.get(key);
    const now = Date.now();
    const knowledge: Knowledge = {
      id: existing?.id ?? `k-${key}`,
      canonicalTopic: key,
      aliases: input.aliases,
      claims: input.claims.map((claim, index) => ({
        id: claim.id ?? `${key}-claim-${index}`,
        text: claim.text,
        confidence: claim.confidence,
        sourceIds: claim.sourceIds,
        embedding: claim.embedding,
      })),
      relations: input.relations,
      sources: input.sources,
      confidence: input.claims.length > 0 ? 0.7 : 0.2,
      coverage: Math.min(1, (input.claims.length + input.relations.length) / 10),
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    const changed =
      JSON.stringify(existing?.claims ?? []) !== JSON.stringify(knowledge.claims) ||
      JSON.stringify(existing?.relations ?? []) !== JSON.stringify(knowledge.relations) ||
      JSON.stringify(existing?.sources ?? []) !== JSON.stringify(knowledge.sources);
    this.map.set(key, knowledge);
    return { knowledge, changed };
  }
}

describe('Phase5/6 e2e', () => {
  it('returns exploration report for user flow and no report for cron flow', async () => {
    const repository = new InMemoryKnowledgeRepository();
    const now = Date.now();

    const user = await runUserFlow({
      topic: 'TypeScript',
      repository,
      userBudget: 5,
      evidence: {
        queryCountUsed: 2,
        claims: [
          {
            text: 'TypeScript is a typed superset of JavaScript.',
            confidence: 0.9,
            sourceIds: ['s1', 's2'],
          },
        ],
        sources: [
          { id: 's1', domain: 'docs.typescriptlang.org', fetchedAt: now },
          { id: 's2', domain: 'developer.mozilla.org', fetchedAt: now },
        ],
        normalizedSources: [
          {
            id: 's1',
            url: 'https://docs.typescriptlang.org/',
            fetchedAt: now,
            domain: 'docs.typescriptlang.org',
          },
          {
            id: 's2',
            url: 'https://developer.mozilla.org/',
            fetchedAt: now,
            domain: 'developer.mozilla.org',
          },
        ],
      },
    });

    expect(user.report.topic).toBe('TypeScript');
    expect(user.report.summary.length).toBeGreaterThan(0);
    expect(user.acceptedClaims).toBeGreaterThan(0);

    const cron = await runCronFlow({
      topic: 'TypeScript',
      repository,
      cronBudget: 3,
      cronRunBudget: 4,
      cronRunConsumed: 1,
      evidence: {
        queryCountUsed: 2,
        claims: [
          {
            text: 'TypeScript has trade-offs in build speed for large repos.',
            confidence: 0.8,
            sourceIds: ['s3', 's4'],
          },
        ],
        sources: [
          { id: 's3', domain: 'github.com', fetchedAt: now },
          { id: 's4', domain: 'typescriptlang.org', fetchedAt: now },
        ],
        normalizedSources: [
          {
            id: 's3',
            url: 'https://github.com/microsoft/TypeScript',
            fetchedAt: now,
            domain: 'github.com',
          },
          {
            id: 's4',
            url: 'https://www.typescriptlang.org/docs/',
            fetchedAt: now,
            domain: 'typescriptlang.org',
          },
        ],
      },
    });

    expect(cron.summary).toContain('accepted=');
    expect(cron.runConsumedBudget).toBe(3);
  });

  it('enforces cron run budget', async () => {
    const repository = new InMemoryKnowledgeRepository();
    await expect(
      runCronFlow({
        topic: 'budget-topic',
        repository,
        cronBudget: 2,
        cronRunBudget: 3,
        cronRunConsumed: 2,
        evidence: {
          queryCountUsed: 2,
          claims: [],
          sources: [],
          normalizedSources: [],
        },
      }),
    ).rejects.toThrow(/CRON_RUN_BUDGET/);
  });

  it('updates task resultSummary through knowflow handler', async () => {
    const repository = new InMemoryKnowledgeRepository();
    const dir = await mkdtemp(join(tmpdir(), 'knowflow-phase5-'));
    const queueFile = join(dir, 'tasks.json');
    const queue = new FileQueueRepository(queueFile);

    try {
      await queue.enqueue({
        topic: 'cron topic',
        source: 'cron',
        mode: 'directed',
      });
      const userTask = await queue.enqueue({
        topic: 'user topic',
        source: 'user',
        mode: 'directed',
      });

      const handler = createKnowFlowTaskHandler({
        repository,
        budget: {
          userBudget: 3,
          cronBudget: 2,
          cronRunBudget: 5,
        },
        evidenceProvider: async (task) => {
          const now = Date.now();
          return {
            queryCountUsed: 1,
            claims: [
              {
                text: `${task.topic} is important.`,
                confidence: 0.9,
                sourceIds: [`src-${task.id}`],
              },
            ],
            sources: [
              {
                id: `src-${task.id}`,
                domain: 'docs.example.com',
                fetchedAt: now,
              },
            ],
            normalizedSources: [
              {
                id: `src-${task.id}`,
                url: 'https://docs.example.com',
                domain: 'docs.example.com',
                fetchedAt: now,
              },
            ],
          };
        },
      });

      const first = await runWorkerOnce(queue, handler, { workerId: 'w-1' });
      expect(first.processed).toBe(true);
      if (first.processed) {
        expect(first.taskId).toBe(userTask.task.id);
      }

      const second = await runWorkerOnce(queue, handler, { workerId: 'w-1' });
      expect(second.processed).toBe(true);

      const all = await queue.list();
      const firstDone = all.find((task) => task.id === userTask.task.id);
      expect(firstDone?.status).toBe('done');
      expect(firstDone?.resultSummary).toContain('accepted=');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resets cron run budget window to avoid permanent cron starvation', async () => {
    const repository = new InMemoryKnowledgeRepository();
    const dir = await mkdtemp(join(tmpdir(), 'knowflow-phase5-cron-window-'));
    const queueFile = join(dir, 'tasks.json');
    const queue = new FileQueueRepository(queueFile);
    let now = 1_000;

    try {
      await queue.enqueue({
        topic: 'cron-window-a',
        source: 'cron',
        mode: 'directed',
      });
      await queue.enqueue({
        topic: 'cron-window-b',
        source: 'cron',
        mode: 'directed',
      });

      const handler = createKnowFlowTaskHandler({
        repository,
        budget: {
          userBudget: 3,
          cronBudget: 2,
          cronRunBudget: 2,
        },
        cronRunWindowMs: 1_000,
        now: () => now,
        evidenceProvider: async (task) => {
          const sourceA = `${task.id}-a`;
          const sourceB = `${task.id}-b`;
          return {
            queryCountUsed: 2,
            claims: [
              {
                text: `${task.topic} has trade-offs.`,
                confidence: 0.9,
                sourceIds: [sourceA, sourceB],
              },
            ],
            sources: [
              { id: sourceA, domain: 'docs.example.com', fetchedAt: now },
              { id: sourceB, domain: 'developer.mozilla.org', fetchedAt: now },
            ],
            normalizedSources: [
              {
                id: sourceA,
                url: `https://docs.example.com/${task.id}`,
                domain: 'docs.example.com',
                fetchedAt: now,
              },
              {
                id: sourceB,
                url: `https://developer.mozilla.org/${task.id}`,
                domain: 'developer.mozilla.org',
                fetchedAt: now,
              },
            ],
          };
        },
      });

      const first = await runWorkerOnce(queue, handler, {
        workerId: 'cron-worker',
        now: () => now,
        baseBackoffMs: 0,
      });
      expect(first).toMatchObject({ processed: true, status: 'done' });

      now = 1_500;
      const second = await runWorkerOnce(queue, handler, {
        workerId: 'cron-worker',
        now: () => now,
        baseBackoffMs: 0,
      });
      expect(second).toMatchObject({ processed: true, status: 'deferred' });

      now = 2_200;
      const third = await runWorkerOnce(queue, handler, {
        workerId: 'cron-worker',
        now: () => now,
        baseBackoffMs: 0,
      });
      expect(third).toMatchObject({ processed: true, status: 'done' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
