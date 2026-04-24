import { describe, expect, it } from 'bun:test';
import { reviewDocument } from './documentReviewer.js';

describe('reviewDocument', () => {
  it('throws E013 when both documentPath and content are provided', async () => {
    await expect(
      reviewDocument(
        {
          repoPath: process.cwd(),
          documentPath: 'docs/spec-agent.md',
          content: '# inline',
          documentType: 'spec',
        },
        {
          llmService: {
            provider: 'local',
            generate: async () => '{"summary":"ok","findings":[],"nextActions":[]}',
          },
        },
      ),
    ).rejects.toThrow('[E013]');
  });

  it('throws E015 when content exceeds max size', async () => {
    await expect(
      reviewDocument(
        {
          repoPath: process.cwd(),
          content: 'a'.repeat(205_000),
          documentType: 'plan',
        },
        {
          llmService: {
            provider: 'local',
            generate: async () => '{"summary":"ok","findings":[],"nextActions":[]}',
          },
        },
      ),
    ).rejects.toThrow('[E015]');
  });

  it('returns normalized review result with applied context ids', async () => {
    const result = await reviewDocument(
      {
        repoPath: process.cwd(),
        content: '## Overview\nDo something safely.',
        documentType: 'spec',
        goal: 'Auth refactor',
      },
      {
        llmService: {
          provider: 'local',
          generate: async () =>
            JSON.stringify({
              summary: 'Need more acceptance criteria.',
              nextActions: ['Add AC for failure path'],
              findings: [
                {
                  title: 'Acceptance criteria missing',
                  severity: 'error',
                  confidence: 'high',
                  category: 'missing_requirement',
                  rationale: 'No measurable acceptance criteria were listed.',
                },
              ],
            }),
        },
        queryProcedureFn: async () => ({
          goal: { id: 'goal-1', name: 'g', description: 'd' },
          tasks: [],
          constraints: [],
        }),
        recallLessonsFn: async () => [
          {
            failure: {
              id: 'lesson-1',
              scenarioId: 's1',
              content: 'failure',
              failureType: null,
              metadata: {},
              similarity: 0.9,
            },
            solutions: [],
          },
        ],
        searchMemoryFn: async () => [
          { id: 'mem-1', content: 'm', metadata: {}, createdAt: new Date(), similarity: 0.8 },
        ],
        getAlwaysGuidanceFn: async () => [
          { id: 'g-always-1', content: 'always', metadata: {}, priority: 80 },
        ],
        getOnDemandGuidanceFn: async () => [
          { id: 'g-demand-1', content: 'ondemand', metadata: {}, similarity: 0.7 },
        ],
      },
    );

    expect(result.documentType).toBe('spec');
    expect(result.status).toBe('changes_requested');
    expect(result.appliedContext.procedureIds).toContain('goal-1');
    expect(result.appliedContext.lessonIds).toContain('lesson-1');
    expect(result.appliedContext.memoryIds).toContain('mem-1');
    expect(result.appliedContext.guidanceIds).toEqual(
      expect.arrayContaining(['g-always-1', 'g-demand-1']),
    );
    expect(result.findings[0]?.knowledgeRefs?.length).toBeGreaterThan(0);
  });
});
