import { describe, expect, it } from 'bun:test';
import { extractJsonCandidate } from './llm.js';

describe('extractJsonCandidate', () => {
  it('returns trimmed text when non-empty', () => {
    const text = '  hello world  ';
    expect(extractJsonCandidate(text)).toBe('hello world');
  });

  it('returns original plain text even when markdown exists', () => {
    const text = 'Here is the result:\n```json\n{"status": "ok"}\n```\nHope it helps.';
    expect(extractJsonCandidate(text)).toContain('{"status": "ok"}');
  });

  it('should return undefined if no brace found', () => {
    const text = '';
    expect(extractJsonCandidate(text)).toBeUndefined();
  });
});
