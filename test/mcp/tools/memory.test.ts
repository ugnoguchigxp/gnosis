import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { memoryTools } from '../../../src/mcp/tools/memory';

// サービスのモック
const mockSaveMemory = mock();
const mockSearchMemory = mock();
const mockDeleteMemory = mock();
const mockSaveEntities = mock();
const mockSaveRelations = mock();

mock.module('../../../src/services/memory.js', () => ({
  saveMemory: mockSaveMemory,
  saveEpisodeMemory: mockSaveMemory,
  searchMemory: mockSearchMemory,
  deleteMemory: mockDeleteMemory,
}));

mock.module('../../../src/services/graph.js', () => ({
  saveEntities: mockSaveEntities,
  saveRelations: mockSaveRelations,
}));

mock.module('../../../src/db/index.js', () => ({
  db: {
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb('mock-tx'),
  },
}));

describe('memory tool handlers', () => {
  const storeHandler = memoryTools.find((t) => t.name === 'store_memory')?.handler;
  const searchHandler = memoryTools.find((t) => t.name === 'search_memory')?.handler;
  const deleteHandler = memoryTools.find((t) => t.name === 'delete_memory')?.handler;

  if (!storeHandler || !searchHandler || !deleteHandler) {
    throw new Error('Memory tools not found');
  }

  beforeEach(() => {
    mockSaveMemory.mockClear();
    mockSearchMemory.mockClear();
    mockDeleteMemory.mockClear();
    mockSaveEntities.mockClear();
    mockSaveRelations.mockClear();
  });

  it('store_memory: saves memory, entities and relations within a transaction', async () => {
    mockSaveMemory.mockResolvedValue({ id: 'mem-1' });

    const args = {
      sessionId: 's1',
      content: 'text contents',
      entities: [{ id: 'e1', type: 'node', name: 'entity1' }],
      relations: [{ sourceId: 'e1', targetId: 'e2', relationType: 'linked' }],
    };

    const result = await storeHandler(args);

    expect(mockSaveMemory).toHaveBeenCalledWith(
      {
        sessionId: 's1',
        content: 'text contents',
        metadata: undefined,
        memoryType: 'raw',
        episodeAt: undefined,
        importance: undefined,
      },
      'mock-tx',
    );
    expect(mockSaveEntities).toHaveBeenCalledWith(args.entities, 'mock-tx');
    expect(mockSaveRelations).toHaveBeenCalledWith(args.relations, 'mock-tx');
    expect(result.content[0].text).toContain('Memory stored successfully with ID: mem-1');
  });

  it('search_memory: calls search service', async () => {
    mockSearchMemory.mockResolvedValue([{ id: 'm1', content: 'c1' }]);

    const args = {
      sessionId: 's1',
      query: 'search query',
      limit: 10,
    };

    const result = await searchHandler(args);

    expect(mockSearchMemory).toHaveBeenCalledWith('s1', 'search query', 10, undefined);
    expect(result.content[0].text).toContain('m1');
  });

  it('delete_memory: calls delete service', async () => {
    mockDeleteMemory.mockResolvedValue(undefined);

    const args = { memoryId: 'm1' };
    const result = await deleteHandler(args);

    expect(mockDeleteMemory).toHaveBeenCalledWith('m1');
    expect(result.content[0].text).toContain('deleted successfully');
  });
});
