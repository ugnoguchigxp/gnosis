import { describe, expect, it, vi } from 'bun:test';
import type { ReviewerToolContext } from '../tools/types.js';
import { reviewWithPseudoTools } from './pseudoToolReviewer.js';
import type { ReviewLLMService } from './types.js';

describe('reviewWithPseudoTools', () => {
  const ctx: ReviewerToolContext = {
    repoPath: '/mock/repo',
    gnosisSessionId: 'test-session',
    maxToolRounds: 2,
  };

  it('should handle a successful tool call loop', async () => {
    const mockLLM: Partial<ReviewLLMService> = {
      provider: 'local',
      generate: vi
        .fn()
        .mockResolvedValueOnce('<tool_call name="read_file" args=\'{"file_path": "test.ts"}\' />')
        .mockResolvedValueOnce('The file looks good.'),
    };

    // We need to mock the registry execution or just let it fail/succeed if tools were registered
    // For unit testing pseudoToolReviewer logic, we mainly care about parsing and loop
    const result = await reviewWithPseudoTools(mockLLM as ReviewLLMService, [], ctx);

    expect(result).toBe('The file looks good.');
    expect(mockLLM.generate).toHaveBeenCalledTimes(2);

    // Check that history was updated (implicitly by seeing 2nd generate call)
    // In a more detailed test we'd inspect the messages passed to 2nd call
  });

  it('should handle malformed JSON args in tool call', async () => {
    const mockLLM: Partial<ReviewLLMService> = {
      provider: 'local',
      generate: vi
        .fn()
        .mockResolvedValueOnce('<tool_call name="read_file" args=\'invalid json\' />')
        .mockResolvedValueOnce('Error handled.'),
    };

    const result = await reviewWithPseudoTools(mockLLM as ReviewLLMService, [], ctx);
    expect(result).toBe('Error handled.');
  });

  it('should terminate after max rounds', async () => {
    const mockLLM: Partial<ReviewLLMService> = {
      provider: 'local',
      generate: vi.fn().mockResolvedValue('<tool_call name="loop" args="{}" />'),
    };

    await expect(
      reviewWithPseudoTools(mockLLM as ReviewLLMService, [], { ...ctx, maxToolRounds: 1 }),
    ).rejects.toThrow(/maximum agentic rounds/);
  });
});
