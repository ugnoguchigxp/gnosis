import { describe, expect, it } from 'bun:test';
import { updateConfidence } from '../src/services/procedure.js';

describe('updateConfidence', () => {
  it('followed_success: increases confidence (diminishing returns)', () => {
    const result = updateConfidence(0.5, 'followed_success');
    expect(result).toBeCloseTo(0.5 + 0.1 * 0.5, 5);
    expect(result).toBeGreaterThan(0.5);
  });

  it('followed_failure: decreases confidence', () => {
    const result = updateConfidence(0.5, 'followed_failure');
    expect(result).toBeCloseTo(0.5 - 0.15 * 0.5, 5);
    expect(result).toBeLessThan(0.5);
  });

  it('ignored_success: decreases slightly', () => {
    const result = updateConfidence(0.5, 'ignored_success');
    expect(result).toBeCloseTo(0.45, 5);
  });

  it('ignored_failure: increases slightly', () => {
    const result = updateConfidence(0.5, 'ignored_failure');
    expect(result).toBeCloseTo(0.55, 5);
  });

  it('clamps at 0.0 (minimum)', () => {
    const result = updateConfidence(0.0, 'followed_failure');
    expect(result).toBe(0.0);
  });

  it('clamps at 1.0 (maximum)', () => {
    // At confidence=1.0, followed_success delta = 0.1*(1-1) = 0
    const result = updateConfidence(1.0, 'followed_success');
    expect(result).toBe(1.0);
  });

  it('confidence near 0 decreases only slightly on followed_failure', () => {
    const result = updateConfidence(0.01, 'followed_failure');
    expect(result).toBeGreaterThanOrEqual(0.0);
    expect(result).toBeLessThan(0.01);
  });

  it('confidence near 1 increases only slightly on followed_success', () => {
    const result = updateConfidence(0.99, 'followed_success');
    expect(result).toBeLessThanOrEqual(1.0);
    expect(result).toBeGreaterThan(0.99);
  });
});

describe('queryProcedure (unit)', () => {
  it('returns null when no goal entities found', async () => {
    // Import lazily so mocks from other modules don't interfere
    const { queryProcedure } = await import('../src/services/procedure.js');

    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => Promise.resolve([]),
            }),
          }),
        }),
      }),
    };

    const result = await queryProcedure('some goal text', undefined, {
      database: mockDb as never,
      embed: async () => [0.1, 0.2, 0.3],
    });

    expect(result).toBeNull();
  });
});
