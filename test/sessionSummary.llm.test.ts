import { describe, expect, it } from 'bun:test';
import { parseConfidenceByIndex } from '../src/services/sessionSummary/llm.js';

describe('session summary LLM refinement', () => {
  it('accepts confidence only when every line is a bare score', () => {
    const result = parseConfidenceByIndex('0.8\n0.2', 2);

    expect([...result.values()]).toEqual([0.8, 0.2]);
  });

  it('does not partially parse malformed confidence output', () => {
    const result = parseConfidenceByIndex('0.8\nreason: strong', 2);

    expect(result.size).toBe(0);
  });

  it('rejects outputs with the wrong line count', () => {
    const result = parseConfidenceByIndex('0.8\n0.2\n0.9', 2);

    expect(result.size).toBe(0);
  });
});
