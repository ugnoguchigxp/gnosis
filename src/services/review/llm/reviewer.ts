import { ReviewError } from '../errors.js';
import { createCloudReviewLLMService } from './cloudProvider.js';
import { createLocalReviewLLMService } from './localProvider.js';
import type { ReviewLLMPreference, ReviewLLMService } from './types.js';

export async function getReviewLLMService(
  preference: ReviewLLMPreference = 'cloud',
): Promise<ReviewLLMService> {
  const local = createLocalReviewLLMService();

  if (preference === 'local') {
    return local;
  }

  try {
    const cloud = createCloudReviewLLMService();

    return {
      provider: 'cloud',
      async generate(prompt: string, options?: { format?: 'json' | 'text' }): Promise<string> {
        try {
          return await cloud.generate(prompt, options);
        } catch (error) {
          if (error instanceof ReviewError && error.code === 'E007') {
            return local.generate(prompt, options);
          }

          if (error instanceof ReviewError && error.code === 'E006') {
            return local.generate(prompt, options);
          }

          throw error;
        }
      },
    };
  } catch (error) {
    if (error instanceof ReviewError) {
      return local;
    }

    throw new ReviewError('E007', `No review LLM providers available: ${error}`);
  }
}
