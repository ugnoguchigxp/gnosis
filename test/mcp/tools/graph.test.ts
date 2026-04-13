import { beforeEach, describe, expect, it, mock } from 'bun:test';

const mockFindEntityById = mock();
const mockSearchEntityByQuery = mock();
const mockQueryGraphContext = mock();
const mockDigestTextIntelligence = mock();
const mockUpdateEntity = mock();
const mockDeleteRelation = mock();
const mockFindPathBetweenEntities = mock();
const mockBuildCommunities = mock();

mock.module('../../../src/services/graph.js', () => ({
  findEntityById: mockFindEntityById,
  searchEntityByQuery: mockSearchEntityByQuery,
  queryGraphContext: mockQueryGraphContext,
  digestTextIntelligence: mockDigestTextIntelligence,
  updateEntity: mockUpdateEntity,
  deleteRelation: mockDeleteRelation,
  findPathBetweenEntities: mockFindPathBetweenEntities,
  saveEntities: mock(),
  saveRelations: mock(),
  buildGraph: mock(),
}));

mock.module('../../../src/services/community.js', () => ({
  buildCommunities: mockBuildCommunities,
}));

import { graphTools } from '../../../src/mcp/tools/graph';

const getHandler = (name: string) => {
  const tool = graphTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool '${name}' not found`);
  return tool.handler;
};

describe('graph MCP tools', () => {
  beforeEach(() => {
    mockFindEntityById.mockReset();
    mockSearchEntityByQuery.mockReset();
    mockQueryGraphContext.mockReset();
    mockDigestTextIntelligence.mockReset();
    mockUpdateEntity.mockReset();
    mockDeleteRelation.mockReset();
    mockFindPathBetweenEntities.mockReset();
    mockBuildCommunities.mockReset();
  });

  describe('query_graph', () => {
    it('returns entity context when found by exact id', async () => {
      mockFindEntityById.mockResolvedValue('ent-1');
      mockQueryGraphContext.mockResolvedValue({ nodes: [], edges: [] });

      const handler = getHandler('query_graph');
      const result = await handler({ query: 'ent-1' });

      expect(mockFindEntityById).toHaveBeenCalledWith('ent-1');
      expect(mockQueryGraphContext).toHaveBeenCalledWith('ent-1');
      expect(result.content[0]?.type).toBe('text');
    });

    it('falls back to search when no exact id match', async () => {
      mockFindEntityById.mockResolvedValue(null);
      mockSearchEntityByQuery.mockResolvedValue('ent-2');
      mockQueryGraphContext.mockResolvedValue({ nodes: [], edges: [] });

      const handler = getHandler('query_graph');
      await handler({ query: 'TypeScript' });

      expect(mockSearchEntityByQuery).toHaveBeenCalledWith('TypeScript');
      expect(mockQueryGraphContext).toHaveBeenCalledWith('ent-2');
    });

    it('returns not-found message when no entity matches', async () => {
      mockFindEntityById.mockResolvedValue(null);
      mockSearchEntityByQuery.mockResolvedValue(null);

      const handler = getHandler('query_graph');
      const result = await handler({ query: 'nonexistent' });

      expect((result.content[0] as { text: string })?.text).toContain('No entity found');
    });
  });

  describe('digest_text', () => {
    it('returns intelligence results as JSON', async () => {
      const mockResults = [{ entity: 'TypeScript', matches: [] }];
      mockDigestTextIntelligence.mockResolvedValue(mockResults);

      const handler = getHandler('digest_text');
      const result = await handler({ text: 'TypeScript is great', limit: 3 });

      expect(mockDigestTextIntelligence).toHaveBeenCalledWith('TypeScript is great', 3);
      expect(result.content).toHaveLength(2);
    });
  });

  describe('update_graph', () => {
    it('updates entity and returns success message', async () => {
      mockUpdateEntity.mockResolvedValue(undefined);

      const handler = getHandler('update_graph');
      const result = await handler({
        action: 'update_entity',
        entity: { id: 'ent-1', name: 'Updated Name' },
      });

      expect(mockUpdateEntity).toHaveBeenCalledWith('ent-1', { id: 'ent-1', name: 'Updated Name' });
      expect((result.content[0] as { text: string })?.text).toContain('updated successfully');
    });

    it('throws when update_entity is called without entity.id', async () => {
      const handler = getHandler('update_graph');
      await expect(handler({ action: 'update_entity', entity: { id: '' } })).rejects.toThrow(
        'entity.id is required',
      );
    });

    it('deletes relation and returns success message', async () => {
      mockDeleteRelation.mockResolvedValue(undefined);

      const handler = getHandler('update_graph');
      const result = await handler({
        action: 'delete_relation',
        relation: { sourceId: 'A', targetId: 'B', relationType: 'works_for' },
      });

      expect(mockDeleteRelation).toHaveBeenCalledWith('A', 'B', 'works_for');
      expect((result.content[0] as { text: string })?.text).toContain('deleted successfully');
    });

    it('throws when delete_relation is called without relation', async () => {
      const handler = getHandler('update_graph');
      await expect(handler({ action: 'delete_relation' })).rejects.toThrow(
        'relation info is required',
      );
    });
  });

  describe('find_path', () => {
    it('returns path result as JSON', async () => {
      const pathResult = { path: ['A', 'B'], length: 1 };
      mockFindPathBetweenEntities.mockResolvedValue(pathResult);

      const handler = getHandler('find_path');
      const result = await handler({ queryA: 'Alice', queryB: 'Bob' });

      expect(mockFindPathBetweenEntities).toHaveBeenCalledWith('Alice', 'Bob');
      const text = (result.content[0] as { text: string })?.text ?? '';
      expect(JSON.parse(text)).toEqual(pathResult);
    });
  });

  describe('build_communities', () => {
    it('returns community rebuild result as JSON', async () => {
      const rebuildResult = { message: 'Communities rebuilt successfully.', count: 3 };
      mockBuildCommunities.mockResolvedValue(rebuildResult);

      const handler = getHandler('build_communities');
      const result = await handler({});

      expect(mockBuildCommunities).toHaveBeenCalled();
      const text = (result.content[0] as { text: string })?.text ?? '';
      expect(JSON.parse(text)).toEqual(rebuildResult);
    });
  });
});
