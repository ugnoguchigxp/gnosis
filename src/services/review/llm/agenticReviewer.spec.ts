import { describe, expect, it, vi } from 'bun:test';
import type { ReviewerToolContext } from '../tools/types.js';
import { reviewWithTools } from './agenticReviewer.js';
import type { ReviewLLMService } from './types.js';

describe('reviewWithNativeTools', () => {
  const ctx: ReviewerToolContext = {
    repoPath: '/mock/repo',
    gnosisSessionId: 'test-session',
    maxToolRounds: 2,
  };

  it('should handle native tool use loop', async () => {
    const mockLLM: Partial<ReviewLLMService> = {
      provider: 'cloud',
      generateMessagesStructured: vi
        .fn()
        .mockResolvedValueOnce({
          text: 'Let me check.',
          toolCalls: [{ name: 'read_file', arguments: { file_path: 'a.ts' } }],
        })
        .mockResolvedValueOnce({
          text: 'Looks good.',
          toolCalls: [],
        }),
    };

    const result = await reviewWithTools(mockLLM as ReviewLLMService, [], ctx);

    expect(result).toBe('Looks good.');
    expect(mockLLM.generateMessagesStructured).toHaveBeenCalledTimes(2);
  });

  it('should throw if llm does not support structured calls', async () => {
    const mockLLM: Partial<ReviewLLMService> = {
      provider: 'cloud',
    };

    await expect(reviewWithTools(mockLLM as ReviewLLMService, [], ctx)).rejects.toThrow(
      'LLM service does not support structured tool calls',
    );
  });
});
