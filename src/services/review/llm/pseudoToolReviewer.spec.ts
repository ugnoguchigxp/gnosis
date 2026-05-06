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

  it('returns the local LLM response without parsing pseudo tool calls', async () => {
    const mockLLM: Partial<ReviewLLMService> = {
      provider: 'local',
      generate: vi
        .fn()
        .mockResolvedValue('<tool_call name="read_file" args=\'{"file_path": "test.ts"}\' />'),
    };

    const result = await reviewWithPseudoTools(mockLLM as ReviewLLMService, [], ctx);

    expect(result).toBe('<tool_call name="read_file" args=\'{"file_path": "test.ts"}\' />');
    expect(mockLLM.generate).toHaveBeenCalledTimes(1);
  });

  it('adds a local-only instruction instead of pseudo tool specs', async () => {
    const generate = vi.fn().mockResolvedValue('The file looks good.');
    const mockLLM: Partial<ReviewLLMService> = {
      provider: 'local',
      generate,
    };

    await reviewWithPseudoTools(mockLLM as ReviewLLMService, [], ctx);
    const prompt = generate.mock.calls[0]?.[0] as string;
    expect(prompt).toContain('疑似ツール呼び出し構文を使わず');
    expect(prompt).not.toContain('<tool_call name=');
  });
});
