import { describe, expect, it } from 'bun:test';
import { extractJsonCandidate } from './llm.js';

describe('extractJsonCandidate', () => {
  it('should extract direct JSON object', () => {
    const text = '  {"foo": "bar"}  ';
    expect(extractJsonCandidate(text)).toBe('{"foo": "bar"}');
  });

  it('should extract JSON from markdown code blocks', () => {
    const text = 'Here is the result:\n```json\n{"status": "ok"}\n```\nHope it helps.';
    expect(extractJsonCandidate(text)).toBe('{"status": "ok"}');
  });

  it('should extract JSON from markdown without language label', () => {
    const text = 'Result:\n```\n{"id": 123}\n```';
    expect(extractJsonCandidate(text)).toBe('{"id": 123}');
  });

  it('should extract outer most object when multiple braces exist', () => {
    const text = 'Intro text { "nested": { "a": 1 } } final text';
    expect(extractJsonCandidate(text)).toBe('{ "nested": { "a": 1 } }');
  });

  it('should handle missing trailing brace (truncated output)', () => {
    const text = 'The result is { "foo": "bar" ';
    // It should return the substring starting from {
    expect(extractJsonCandidate(text)).toBe('{ "foo": "bar"');
  });

  it('should handle junk text before and after', () => {
    const text = 'JUNK {"valid": true} MORE JUNK';
    expect(extractJsonCandidate(text)).toBe('{"valid": true}');
  });

  it('should return undefined if no brace found', () => {
    const text = 'No json here';
    expect(extractJsonCandidate(text)).toBeUndefined();
  });
});
