import { beforeEach, describe, expect, it, mock } from 'bun:test';

const now = new Date('2026-01-01T00:00:00.000Z');
let selectCount = 0;

const entityRows = [
  {
    id: 'rule/always',
    type: 'rule',
    name: 'Always rule',
    description: 'Session-level guidance that should not be repeated by demand lookup.',
    embedding: null,
    communityId: null,
    metadata: {
      category: 'mcp',
      appliesWhen: {
        intents: ['edit'],
        changeTypes: ['mcp'],
        fileGlobs: ['src/mcp/**'],
        technologies: ['typescript'],
        keywords: ['rule lookup'],
      },
    },
    referenceCount: 99,
    lastReferencedAt: now,
    createdAt: now,
    confidence: 1,
    provenance: 'test',
    freshness: now,
    scope: 'always',
  },
  {
    id: 'rule/frontend',
    type: 'rule',
    name: 'Frontend rule',
    description: 'Use component conventions for UI work.',
    embedding: null,
    communityId: null,
    metadata: {
      category: 'coding_convention',
      appliesWhen: {
        changeTypes: ['frontend'],
        technologies: ['react'],
      },
    },
    referenceCount: 20,
    lastReferencedAt: now,
    createdAt: now,
    confidence: 0.9,
    provenance: 'test',
    freshness: now,
    scope: 'on_demand',
  },
  {
    id: 'rule/mcp',
    type: 'rule',
    name: 'MCP task-context rule lookup',
    description: 'Search task-specific rules before Agent-First MCP implementation.',
    embedding: null,
    communityId: null,
    metadata: {
      category: 'mcp',
      appliesWhen: {
        intents: ['edit'],
        changeTypes: ['mcp', 'refactor'],
        fileGlobs: ['src/mcp/**', 'src/services/agentFirst.ts'],
        technologies: ['typescript', 'mcp'],
        keywords: ['rule lookup'],
        severity: 'required',
      },
    },
    referenceCount: 1,
    lastReferencedAt: now,
    createdAt: now,
    confidence: 0.8,
    provenance: 'test',
    freshness: now,
    scope: 'on_demand',
  },
];

mock.module('../src/db/index.js', () => ({
  db: {
    select: () => {
      selectCount += 1;
      return {
        from: () => ({
          orderBy: () => ({
            limit: async () => entityRows,
          }),
          limit: async () => [],
        }),
      };
    },
  },
}));

mock.module('../src/services/memory.js', () => ({
  generateEmbedding: async () => {
    throw new Error('embedding unavailable in unit test');
  },
}));

mock.module('../src/hooks/service.js', () => ({
  getLoadedHookRuleCount: () => 0,
}));

import { searchKnowledgeV2 } from '../src/services/agentFirst';

describe('searchKnowledgeV2 task-context applicability', () => {
  beforeEach(() => {
    selectCount = 0;
  });

  it('prioritizes rules whose applicability metadata matches the task context', async () => {
    const result = await searchKnowledgeV2({
      preset: 'task_context',
      intent: 'edit',
      taskGoal: 'Refactor MCP rule lookup before implementation',
      files: ['src/mcp/tools/agentFirst.ts', 'src/services/agentFirst.ts'],
      changeTypes: ['mcp', 'refactor'],
      technologies: ['typescript', 'mcp'],
      kinds: ['rule'],
      grouping: 'flat',
    });

    expect(selectCount).toBe(2);
    expect(result.taskContext).toBeDefined();
    expect(result.flatTopHits[0]?.entityId).toBe('rule/mcp');
    expect(result.flatTopHits.map((hit) => hit.entityId)).not.toContain('rule/always');
    expect(result.flatTopHits[0]?.applicabilityScore).toBeGreaterThan(0.8);
    expect(result.taskContext?.changeTypes).toContain('mcp');
  });
});
