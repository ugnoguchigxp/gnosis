import { beforeEach, describe, expect, it, mock } from 'bun:test';

const now = new Date('2026-01-01T00:00:00.000Z');
let selectCount = 0;
let llmRouterShouldFail = false;
let llmRouterLastTimeoutMs: number | undefined;

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
    execute: async () => [],
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
    update: () => ({
      set: () => ({
        where: async () => [],
      }),
    }),
  },
}));

mock.module('../src/services/memory.js', () => ({
  generateEmbedding: async () => {
    throw new Error('embedding unavailable in unit test');
  },
  searchMemoriesByType: async () => [],
}));

mock.module('../src/services/memoryLoopLlmRouter.js', () => ({
  runPromptWithMemoryLoopRouter: async (input: { llmTimeoutMs?: number }) => {
    llmRouterLastTimeoutMs = input.llmTimeoutMs;
    if (llmRouterShouldFail) throw new Error('Gemma4 failed');
    return {
      output: JSON.stringify({
        decisions: [
          {
            id: 'rule/mcp',
            decision: 'use',
            confidence: 0.9,
            reason: 'Directly relevant to MCP rule lookup.',
            summary: 'Search task-specific rules before Agent-First MCP implementation.',
          },
          {
            id: 'rule/frontend',
            decision: 'skip',
            confidence: 0.8,
            reason: 'Frontend UI guidance is unrelated.',
            summary: '',
          },
        ],
      }),
      route: { alias: 'gemma4', script: 'mock', allowCloud: false, cloudEnabledForAttempt: false },
      attempts: 1,
    };
  },
}));

mock.module('../src/hooks/service.js', () => ({
  getLoadedHookRuleCount: () => 0,
}));

import {
  agenticSearch,
  buildActivateProjectResult,
  searchKnowledgeV2,
} from '../src/services/agentFirst';

describe('searchKnowledgeV2 task-context applicability', () => {
  beforeEach(() => {
    selectCount = 0;
    llmRouterShouldFail = false;
    llmRouterLastTimeoutMs = undefined;
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

  it('asks for refinement when task-context lookup lacks concrete task scope', async () => {
    const result = await searchKnowledgeV2({
      preset: 'task_context',
      intent: 'plan',
      query: 'todo',
    });

    expect(result.suggestedNextAction).toBe('refine_query');
    expect(result.degraded?.reason).toBe('insufficient_task_context');
    expect(result.flatTopHits).toHaveLength(0);
  });

  it('treats explicit kind and category filters as narrowing constraints', async () => {
    const result = await searchKnowledgeV2({
      preset: 'task_context',
      intent: 'edit',
      taskGoal: 'Refactor MCP rule lookup before implementation',
      files: ['src/mcp/tools/agentFirst.ts', 'src/services/agentFirst.ts'],
      changeTypes: ['mcp', 'refactor'],
      technologies: ['typescript', 'mcp'],
      kinds: ['rule'],
      categories: ['mcp'],
      grouping: 'flat',
    });

    expect(result.flatTopHits.map((hit) => hit.category)).toEqual(['mcp']);
    expect(result.flatTopHits.map((hit) => hit.entityId)).not.toContain('rule/frontend');
  });

  it('counts always guidance in project health without repeating it as contextual top items', async () => {
    const result = await buildActivateProjectResult('/tmp/gnosis', 'planning');

    expect(result.knowledgeIndex.totalActive).toBe(3);
    expect(result.knowledgeIndex.byKind.rule).toBe(3);
    expect(result.knowledgeIndex.topItems.map((item) => item.entityId)).not.toContain(
      'rule/always',
    );
  });

  it('uses local LLM filtering in agentic_search to return only task-relevant knowledge', async () => {
    const result = await agenticSearch({
      userRequest: 'Refactor MCP rule lookup before implementation',
      files: ['src/mcp/tools/agentFirst.ts', 'src/services/agentFirst.ts'],
      changeTypes: ['mcp', 'refactor'],
      technologies: ['typescript', 'mcp'],
      localLlm: { enabled: true },
    });

    expect(result.decision).toBe('use_knowledge');
    expect(result.diagnostics.localLlmUsed).toBe(true);
    expect(result.usedKnowledge.map((item) => item.id)).toContain('rule/mcp');
    expect(result.usedKnowledge.map((item) => item.id)).not.toContain('rule/frontend');
    expect(llmRouterLastTimeoutMs).toBe(180_000);
  });

  it('does not inject unfiltered candidates when Gemma4 filtering fails', async () => {
    llmRouterShouldFail = true;
    const result = await agenticSearch({
      userRequest: 'Refactor MCP rule lookup before implementation',
      files: ['src/mcp/tools/agentFirst.ts', 'src/services/agentFirst.ts'],
      changeTypes: ['mcp', 'refactor'],
      technologies: ['typescript', 'mcp'],
    });

    expect(result.decision).toBe('degraded');
    expect(result.usedKnowledge).toHaveLength(0);
    expect(result.skippedCount).toBeGreaterThan(0);
    expect(result.diagnostics.degradedReasons.join('\n')).toContain('LLM_FILTER_FAILED:');
    expect(result.diagnostics.degradedReasons.join('\n')).toContain('Gemma4 failed');
  });

  it('returns degraded when localLlm.required=true but localLlm.enabled=false', async () => {
    const result = await agenticSearch({
      userRequest: 'Refactor MCP rule lookup before implementation',
      files: ['src/mcp/tools/agentFirst.ts', 'src/services/agentFirst.ts'],
      changeTypes: ['mcp', 'refactor'],
      technologies: ['typescript', 'mcp'],
      localLlm: { enabled: false, required: true },
    });

    expect(result.decision).toBe('degraded');
    expect(result.usedKnowledge).toHaveLength(0);
    expect(result.nextAction).toBe('retry_later');
    expect(result.diagnostics.degradedReasons.join('\n')).toContain('LLM_REQUIRED_DISABLED:');
  });
});
