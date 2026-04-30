import { describe, expect, it, mock } from 'bun:test';
import { synthesizeKnowledge } from '../src/services/synthesis.js';

// biome-ignore lint/suspicious/noExplicitAny: mock helper
const makeDb = (selectData: any[] = [], updateOk = true) => ({
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => selectData,
      }),
    }),
  }),
  update: () => ({
    set: () => ({
      where: async () =>
        updateOk
          ? undefined
          : (() => {
              throw new Error('update failed');
            })(),
    }),
  }),
});

describe('synthesizeKnowledge', () => {
  it('returns count=0 when no pending memories', async () => {
    const db = makeDb([]);
    const result = await synthesizeKnowledge({ database: db as never });
    expect(result).toEqual({ count: 0, message: 'No pending memories to synthesize.' });
  });

  it('distills memories and saves entities and relations', async () => {
    const memories = [
      { id: 'm1', sessionId: 'sess1', content: 'TypeScript is typed.', isSynthesized: false },
      { id: 'm2', sessionId: 'sess1', content: 'Bun is fast.', isSynthesized: false },
    ];
    const db = makeDb(memories);

    const mockDistill = mock().mockResolvedValue({
      memories: [],
      entities: [
        // 新形式: id なし、制御語彙の type
        {
          type: 'rule',
          name: 'TypeScript 型安全ルール',
          description:
            'JavaScriptに静的型付けを追加したTypeScriptを使い、型安全なコードを書くためのプロジェクトルール',
          metadata: { category: 'coding_convention', tags: ['typescript'] },
        },
      ],
      relations: [
        // 新形式: name ベース
        {
          sourceType: 'rule',
          sourceName: 'TypeScript 型安全ルール',
          targetType: 'tool',
          targetName: 'Bun',
          relationType: 'depends_on',
        },
      ],
    });
    const mockSaveEnts = mock().mockResolvedValue(undefined);
    const mockSaveRels = mock().mockResolvedValue(undefined);

    const result = await synthesizeKnowledge({
      database: db as never,
      distill: mockDistill,
      saveEnts: mockSaveEnts,
      saveRels: mockSaveRels,
      batchSize: 10,
    });

    expect(mockDistill).toHaveBeenCalledTimes(1);
    // biome-ignore lint/suspicious/noExplicitAny: mock
    const transcript = (mockDistill.mock.calls as any)[0][0] as string;
    expect(transcript).toContain('[Session: sess1]');
    expect(transcript).toContain('TypeScript is typed.');

    expect(mockSaveEnts).toHaveBeenCalledTimes(1);
    expect(mockSaveRels).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ count: 2, extractedEntities: 1, extractedRelations: 1 });
  });

  it('skips saveEnts when no entities extracted', async () => {
    const memories = [
      { id: 'm1', sessionId: 'sess1', content: 'Just a memory.', isSynthesized: false },
    ];
    const db = makeDb(memories);

    const mockDistill = mock().mockResolvedValue({
      memories: [],
      entities: [],
      relations: [],
    });
    const mockSaveEnts = mock();
    const mockSaveRels = mock();

    const result = await synthesizeKnowledge({
      database: db as never,
      distill: mockDistill,
      saveEnts: mockSaveEnts,
      saveRels: mockSaveRels,
    });

    expect(mockSaveEnts).not.toHaveBeenCalled();
    expect(mockSaveRels).not.toHaveBeenCalled();
    expect(result).toEqual({ count: 1, extractedEntities: 0, extractedRelations: 0 });
  });

  it('propagates errors from distillKnowledgeFromTranscript', async () => {
    const memories = [{ id: 'm1', sessionId: 's', content: 'text', isSynthesized: false }];
    const db = makeDb(memories);
    const mockDistill = mock().mockRejectedValue(new Error('LLM failed'));

    await expect(
      synthesizeKnowledge({ database: db as never, distill: mockDistill }),
    ).rejects.toThrow('LLM failed');
  });

  it('respects batchSize dep', async () => {
    const db = makeDb([]);
    const result = await synthesizeKnowledge({ database: db as never, batchSize: 5 });
    expect(result.count).toBe(0);
  });
});
