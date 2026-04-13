import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const mockSearchKnowledgeClaims = mock();
const mockGetKnowledgeByTopic = mock();
mock.module('../../../src/services/knowledge.js', () => ({
  searchKnowledgeClaims: mockSearchKnowledgeClaims,
  getKnowledgeByTopic: mockGetKnowledgeByTopic,
}));

const mockFindEntityById = mock();
const mockSearchEntityByQuery = mock();
const mockQueryGraphContext = mock();
mock.module('../../../src/services/graph.js', () => ({
  findEntityById: mockFindEntityById,
  searchEntityByQuery: mockSearchEntityByQuery,
  queryGraphContext: mockQueryGraphContext,
  digestTextIntelligence: mock(),
  updateEntity: mock(),
  deleteRelation: mock(),
  findPathBetweenEntities: mock(),
  saveEntities: mock(),
  saveRelations: mock(),
  buildGraph: mock(),
  searchEntitiesByText: mock(),
}));

const mockSearchMemory = mock();
mock.module('../../../src/services/memory.js', () => ({
  searchMemory: mockSearchMemory,
  generateEmbedding: mock(),
  storeMemory: mock(),
  deleteMemory: mock(),
}));

import { knowledgeTools } from '../../../src/mcp/tools/knowledge.js';

const getHandler = (name: string) => {
  const tool = knowledgeTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool '${name}' not found`);
  return tool.handler;
};

describe('knowledge MCP tools', () => {
  beforeEach(() => {
    mockSearchKnowledgeClaims.mockReset();
    mockGetKnowledgeByTopic.mockReset();
    mockFindEntityById.mockReset();
    mockSearchEntityByQuery.mockReset();
    mockQueryGraphContext.mockReset();
    mockSearchMemory.mockReset();
  });

  afterEach(() => {
    mockSearchKnowledgeClaims.mockReset();
    mockGetKnowledgeByTopic.mockReset();
    mockFindEntityById.mockReset();
    mockSearchEntityByQuery.mockReset();
    mockQueryGraphContext.mockReset();
    mockSearchMemory.mockReset();
  });

  describe('search_knowledge', () => {
    it('calls searchKnowledgeClaims with query and returns results', async () => {
      const mockClaims = [
        { topic: 'TypeScript', text: 'TypeScript is typed.', confidence: 0.9, score: 1.0 },
      ];
      mockSearchKnowledgeClaims.mockResolvedValue(mockClaims);

      const handler = getHandler('search_knowledge');
      const result = await handler({ query: 'TypeScript', limit: 3 });

      expect(mockSearchKnowledgeClaims).toHaveBeenCalledWith('TypeScript', 3);
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(JSON.parse(text)).toEqual(mockClaims);
    });

    it('uses default limit of 5 when not specified', async () => {
      mockSearchKnowledgeClaims.mockResolvedValue([]);

      const handler = getHandler('search_knowledge');
      await handler({ query: 'test' });

      // biome-ignore lint/suspicious/noExplicitAny: mock
      const callArgs = (mockSearchKnowledgeClaims.mock.calls as any)[0];
      expect(callArgs[1]).toBe(5);
    });
  });

  describe('get_knowledge', () => {
    it('returns JSON knowledge when topic exists', async () => {
      const mockKnowledge = {
        topic: 'TypeScript',
        aliases: [],
        confidence: 0.9,
        coverage: 0.5,
        claims: [{ text: 'TypeScript is typed.', confidence: 0.9, sourceIds: [] }],
        relations: [],
        sources: [],
      };
      mockGetKnowledgeByTopic.mockResolvedValue(mockKnowledge);

      const handler = getHandler('get_knowledge');
      const result = await handler({ topic: 'TypeScript' });

      expect(mockGetKnowledgeByTopic).toHaveBeenCalledWith('TypeScript');
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(JSON.parse(text)).toEqual(mockKnowledge);
    });

    it('returns not-found message when topic does not exist', async () => {
      mockGetKnowledgeByTopic.mockResolvedValue(null);

      const handler = getHandler('get_knowledge');
      const result = await handler({ topic: 'unknown-topic' });

      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain('No detailed knowledge found');
      expect(text).toContain('unknown-topic');
    });
  });

  describe('search_unified', () => {
    it('mode=fts calls searchKnowledgeClaims', async () => {
      const mockClaims = [{ topic: 'ts', text: 'claim', confidence: 0.8, score: 0.5 }];
      mockSearchKnowledgeClaims.mockResolvedValue(mockClaims);

      const handler = getHandler('search_unified');
      const result = await handler({ query: 'TypeScript', mode: 'fts' });

      expect(mockSearchKnowledgeClaims).toHaveBeenCalledWith('TypeScript', 5);
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(JSON.parse(text)).toEqual(mockClaims);
    });

    it('mode=kg calls findEntityById then queryGraphContext when found', async () => {
      mockFindEntityById.mockResolvedValue('entity-1');
      mockQueryGraphContext.mockResolvedValue({ entities: [], relations: [], communities: [] });

      const handler = getHandler('search_unified');
      const result = await handler({ query: 'ent-1', mode: 'kg' });

      expect(mockFindEntityById).toHaveBeenCalledWith('ent-1');
      expect(mockQueryGraphContext).toHaveBeenCalledWith('entity-1');
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(JSON.parse(text)).toBeDefined();
    });

    it('mode=kg falls back to searchEntityByQuery when no exact match', async () => {
      mockFindEntityById.mockResolvedValue(null);
      mockSearchEntityByQuery.mockResolvedValue('entity-2');
      mockQueryGraphContext.mockResolvedValue({ entities: [], relations: [], communities: [] });

      const handler = getHandler('search_unified');
      await handler({ query: 'TypeScript', mode: 'kg' });

      expect(mockSearchEntityByQuery).toHaveBeenCalledWith('TypeScript');
      expect(mockQueryGraphContext).toHaveBeenCalledWith('entity-2');
    });

    it('mode=kg returns not-found when no entity exists', async () => {
      mockFindEntityById.mockResolvedValue(null);
      mockSearchEntityByQuery.mockResolvedValue(null);

      const handler = getHandler('search_unified');
      const result = await handler({ query: 'nobody', mode: 'kg' });

      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain('No entity found');
    });

    it('mode=semantic calls searchMemory', async () => {
      const mockMemories = [{ id: 'm1', content: 'memory', similarity: 0.9 }];
      mockSearchMemory.mockResolvedValue(mockMemories);

      const handler = getHandler('search_unified');
      const result = await handler({ query: 'test', mode: 'semantic', sessionId: 'my-session' });

      expect(mockSearchMemory).toHaveBeenCalledWith('my-session', 'test', 5);
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(JSON.parse(text)).toEqual(mockMemories);
    });

    it('mode=semantic uses default sessionId when not specified', async () => {
      mockSearchMemory.mockResolvedValue([]);

      const handler = getHandler('search_unified');
      await handler({ query: 'test', mode: 'semantic' });

      // biome-ignore lint/suspicious/noExplicitAny: mock
      const [sessionId] = (mockSearchMemory.mock.calls as any)[0];
      expect(sessionId).toBe('gnosis');
    });
  });
});
