export interface ReviewLLMService {
  generate(prompt: string, options?: { format?: 'json' | 'text' }): Promise<string>;
  readonly provider: 'local' | 'cloud';
}

export type ReviewLLMPreference = 'local' | 'cloud';
