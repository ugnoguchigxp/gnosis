import { describe, expect, it, mock } from 'bun:test';
import { GnosisError } from '../../../src/domain/errors';
import { experienceTools } from '../../../src/mcp/tools/experience';

// サービスのモック
const mockSaveExperience = mock();
const mockRecallLessons = mock();

mock.module('../../../src/services/experience.js', () => ({
  saveExperience: mockSaveExperience,
  recallExperienceLessons: mockRecallLessons,
}));

describe('experience tool handlers', () => {
  const recordHandler = experienceTools.find((t) => t.name === 'record_experience')?.handler;
  const recallHandler = experienceTools.find((t) => t.name === 'recall_lessons')?.handler;

  if (!recordHandler || !recallHandler) {
    throw new Error('Experience tools not found');
  }

  it('record_experience: calls service and returns accepted message', async () => {
    mockSaveExperience.mockResolvedValue({ id: 'exp-123' });

    const args = {
      sessionId: 's1',
      scenarioId: 'sc1',
      attempt: 1,
      type: 'failure',
      content: 'something failed',
    };

    const result = await recordHandler(args);

    expect(mockSaveExperience).toHaveBeenCalledWith(expect.objectContaining(args));
    expect(result.content[0].text).toContain('accepted');
  });

  it('record_experience: throws Zod error for invalid input', async () => {
    const args = {
      sessionId: 's1',
      // scenarioId missing
      attempt: 0, // should be positive
      type: 'invalid', // should be success/failure
    };

    await expect(recordHandler(args)).rejects.toThrow();
  });

  it('recall_lessons: calls service and returns results as JSON', async () => {
    const mockResults = [{ failure: { id: 'f1' }, solutions: [] }];
    mockRecallLessons.mockResolvedValue(mockResults);

    const args = {
      sessionId: 's1',
      query: 'how to fix X',
      limit: 3,
    };

    const result = await recallHandler(args);

    expect(mockRecallLessons).toHaveBeenCalledWith('s1', 'how to fix X', 3);
    expect(result.content[0].text).toBe(JSON.stringify(mockResults, null, 2));
  });
});
