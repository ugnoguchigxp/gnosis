import { describe, expect, it, mock } from 'bun:test';
import Graph from 'graphology';
import { buildCommunities } from '../src/services/community';

const makeGraph = (nodeIds: string[]) => {
  const graph = new Graph();
  for (const id of nodeIds) {
    graph.addNode(id, { id, name: id, type: 'Concept', description: '' });
  }
  if (nodeIds.length >= 2) {
    // Louvain requires at least one edge to detect communities
    for (let i = 0; i < nodeIds.length - 1; i++) {
      graph.addEdge(nodeIds[i], nodeIds[i + 1], {
        id: `r-${i}`,
        sourceId: nodeIds[i],
        targetId: nodeIds[i + 1],
        relationType: 'related',
      });
    }
  }
  return graph;
};

const makeMockDatabase = () => {
  const deletedTables: string[] = [];
  const insertedCommunities: Array<{ name: string; summary: string; metadata: unknown }> = [];
  const updatedEntityIds: string[] = [];

  const mockDelete = mock(() => ({ execute: mock(async () => {}) }));
  const mockReturning = mock(async () => [{ id: 'comm-1' }]);
  const mockValues = mock(() => ({ returning: mockReturning }));
  const mockInsert = mock(() => ({ values: mockValues }));
  const mockWhere = mock(async () => {});
  const mockSet = mock(() => ({ where: mockWhere }));
  const mockUpdate = mock(() => ({ set: mockSet }));

  // biome-ignore lint/suspicious/noExplicitAny: mock object
  const database: any = {
    delete: mockDelete,
    insert: mockInsert,
    update: mockUpdate,
  };

  return { database, deletedTables, insertedCommunities, updatedEntityIds, mockDelete, mockInsert };
};

describe('buildCommunities', () => {
  it('returns early when graph has no entities', async () => {
    const graph = new Graph();
    const result = await buildCommunities({
      graphBuilder: async () => graph,
      summarize: mock(async () => ({ name: 'test', summary: 'test' })),
      logger: () => {},
    });
    expect(result).toEqual({ message: 'No entities found to group.' });
  });

  it('deletes existing communities before rebuilding', async () => {
    const graph = makeGraph(['A', 'B', 'C']);
    const { database, mockDelete } = makeMockDatabase();

    await buildCommunities({
      database,
      graphBuilder: async () => graph,
      summarize: async () => ({ name: 'Group', summary: 'A group of nodes' }),
      logger: () => {},
    });

    expect(mockDelete).toHaveBeenCalled();
  });

  it('calls summarize for each detected community', async () => {
    const graph = makeGraph(['X', 'Y', 'Z']);
    const summarize = mock(async () => ({ name: 'Topic', summary: 'summary text' }));
    const { database } = makeMockDatabase();

    await buildCommunities({
      database,
      graphBuilder: async () => graph,
      summarize,
      logger: () => {},
    });

    expect(summarize).toHaveBeenCalled();
  });

  it('returns rebuilt result with community count', async () => {
    const graph = makeGraph(['N1', 'N2']);
    const { database } = makeMockDatabase();

    const result = await buildCommunities({
      database,
      graphBuilder: async () => graph,
      summarize: async () => ({ name: 'C', summary: 's' }),
      logger: () => {},
    });

    expect(result).toHaveProperty('message', 'Communities rebuilt successfully.');
    expect(result).toHaveProperty('count');
  });

  it('uses default dependencies when none are provided (smoke test structure)', async () => {
    // graphBuilder is the only dep we override to avoid real DB + Louvain on empty graph
    const graph = new Graph();
    const result = await buildCommunities({
      graphBuilder: async () => graph,
      // No database or summarize - function should return early before touching them
      logger: () => {},
    });
    expect(result).toEqual({ message: 'No entities found to group.' });
  });
});
