import { describe, expect, it, mock } from 'bun:test';
import { saveExperience, recallExperienceLessons } from '../src/services/experience';

// memory.js の generateEmbedding をモック
mock.module('../src/services/memory.js', () => ({
  generateEmbedding: async (text: string) => [0.1, 0.2, 0.3],
}));

describe('experience service', () => {
  describe('saveExperience', () => {
    it('saves a success event with embedding', async () => {
      const mockReturning = [{ id: '1', content: 'success' }];
      const mockValues = mock(() => ({
        returning: async () => mockReturning,
      }));
      const mockInsert = mock(() => ({
        values: mockValues,
      }));

      const mockDb = {
        insert: mockInsert,
      } as any;

      const input = {
        sessionId: 's1',
        scenarioId: 'sc1',
        attempt: 1,
        type: 'success' as const,
        content: 'success',
        metadata: { foo: 'bar' },
      };

      const result = await saveExperience(input, mockDb);

      expect(result).toEqual(mockReturning[0]);
      expect(mockInsert).toHaveBeenCalled();
      const insertArgs = mockValues.mock.calls[0][0];
      expect(insertArgs.content).toBe('success');
      expect(insertArgs.embedding).toEqual([0.1, 0.2, 0.3]);
      expect(insertArgs.metadata).toEqual({ foo: 'bar' });
    });

    it('uses empty metadata if not provided', async () => {
        const mockValues = mock(() => ({
          returning: async () => [{}],
        }));
        const mockDb = {
          insert: mock(() => ({ values: mockValues })),
        } as any;
  
        await saveExperience({
          sessionId: 's1',
          scenarioId: 'sc1',
          attempt: 1,
          type: 'failure',
          content: 'fail',
        }, mockDb);
  
        const insertArgs = mockValues.mock.calls[0][0];
        expect(insertArgs.metadata).toEqual({});
      });
  });

  describe('recallExperienceLessons', () => {
    it('returns empty array if no similar failures found', async () => {
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: async () => [],
              }),
            }),
          }),
        }),
      } as any;

      const lessons = await recallExperienceLessons('s1', 'query', 5, mockDb);
      expect(lessons).toEqual([]);
    });

    it('recalls failures and their related solutions', async () => {
      const mockFailures = [
        { id: 'f1', scenarioId: 'sc1', content: 'fail 1', similarity: 0.9 },
      ];
      const mockSolutions = [
        { id: 's1', content: 'solution 1', createdAt: new Date() },
      ];

      // 最初の select (failures) と、その後の map 内での select (solutions) をモック
      let callCount = 0;
      const mockDb = {
        select: mock(() => ({
          from: mock(() => ({
            where: mock(() => ({
              orderBy: mock(() => {
                if (callCount === 0) {
                  callCount++;
                  return {
                    limit: mock(async () => mockFailures)
                  };
                }
                return mockSolutions; // Promise.all 内の方は直接 Promise (または async/await で解決される値) を返すマナーにする
              }),
            })),
          })),
        })),
      } as any;

      // Promise.all 内の solutions 取得部分の select チェーンを考慮して再定義
      const mockDbSolutions = {
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: async () => mockSolutions
            })
          })
        })
      };

      const lessons = await recallExperienceLessons('s1', 'query', 2, mockDb);

      expect(lessons).toHaveLength(1);
      expect(lessons[0].failure.id).toBe('f1');
      expect(lessons[0].solutions).toHaveLength(1);
      expect(lessons[0].solutions[0].id).toBe('s1');
    });

    it('handles boundary values for limit', async () => {
      const mockLimit = mock(async () => []);
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: mockLimit
              }),
            }),
          }),
        }),
      } as any;

      // limit = 0 -> default 5
      await recallExperienceLessons('s1', 'query', 0, mockDb);
      expect(mockLimit).toHaveBeenCalledWith(5);

      // limit = NaN -> default 5
      await recallExperienceLessons('s1', 'query', NaN, mockDb);
      expect(mockLimit).toHaveBeenCalledWith(5);

      // limit = -1 -> default 5
      await recallExperienceLessons('s1', 'query', -1, mockDb);
      expect(mockLimit).toHaveBeenCalledWith(5);

      // valid limit
      await recallExperienceLessons('s1', 'query', 10, mockDb);
      expect(mockLimit).toHaveBeenCalledWith(10);
    });
  });
});
