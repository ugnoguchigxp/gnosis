import { describe, expect, it } from 'bun:test';
import { detectGaps } from '../../src/services/knowflow/gap/detector';

describe('gap detector', () => {
  it('combines rule-based gaps and llm gaps', () => {
    const now = Date.now();
    const result = detectGaps({
      topic: 'TypeScript Compiler API',
      now,
      knowledge: {
        id: 'k1',
        canonicalTopic: 'typescript compiler api',
        aliases: ['typescript compiler api'],
        claims: [
          {
            id: 'c1',
            text: 'Compiler API allows AST traversal.',
            confidence: 0.7,
            sourceIds: ['src-1'],
          },
        ],
        relations: [],
        sources: [
          {
            id: 'src-1',
            url: 'https://example.com/old',
            fetchedAt: now - 500 * 24 * 60 * 60 * 1000,
            domain: 'example.com',
          },
        ],
        confidence: 0.7,
        coverage: 0.2,
        version: 1,
        createdAt: now - 500 * 24 * 60 * 60 * 1000,
        updatedAt: now - 500 * 24 * 60 * 60 * 1000,
      },
      verifierResult: {
        acceptedClaims: [],
        rejectedClaims: [
          {
            claim: {
              text: 'Compiler API cannot parse TypeScript.',
              confidence: 0.2,
              sourceIds: ['src-1'],
            },
            score: 0.2,
            reasons: ['contradiction-detected'],
            blocking: true,
          },
        ],
        conflicts: [
          {
            leftClaim: 'Compiler API can parse TypeScript.',
            rightClaim: 'Compiler API cannot parse TypeScript.',
            reason: 'contradiction',
          },
        ],
        metrics: {
          totalClaims: 2,
          acceptedCount: 1,
          rejectedCount: 1,
          conflictCount: 1,
        },
      },
      llmGaps: [
        {
          type: 'missing_example',
          description: 'Need concrete code examples.',
          priority: 0.9,
        },
      ],
    });

    const gapTypes = result.gaps.map((gap) => gap.type);
    expect(gapTypes).toContain('missing_definition');
    expect(gapTypes).toContain('missing_constraints');
    expect(gapTypes).toContain('weak_evidence');
    expect(gapTypes).toContain('outdated');
    expect(gapTypes).toContain('uncertain');
    expect(gapTypes).toContain('missing_example');

    const missingExample = result.gaps.find((gap) => gap.type === 'missing_example');
    expect(missingExample?.origin).toBe('merged');
    expect((missingExample?.priority ?? 0) >= 0.9).toBe(true);
  });

  it('avoids false positive rule gaps when evidence is sufficiently complete', () => {
    const now = Date.now();
    const result = detectGaps({
      topic: 'Feature Flags',
      now,
      knowledge: {
        id: 'k2',
        canonicalTopic: 'feature flags',
        aliases: ['feature flags'],
        claims: [
          {
            id: 'c1',
            text: 'Feature flags is a deployment technique for releasing code safely.',
            confidence: 0.8,
            sourceIds: ['src-1', 'src-2'],
          },
          {
            id: 'c2',
            text: 'For example, teams compare feature flags versus branch-by-abstraction as a trade-off.',
            confidence: 0.78,
            sourceIds: ['src-1', 'src-2'],
          },
        ],
        relations: [
          {
            type: 'compares_with',
            targetTopic: 'branch by abstraction',
            confidence: 0.7,
          },
        ],
        sources: [
          {
            id: 'src-1',
            url: 'https://martinfowler.com',
            fetchedAt: now - 7 * 24 * 60 * 60 * 1000,
            domain: 'martinfowler.com',
          },
          {
            id: 'src-2',
            url: 'https://docs.example.com/feature-flags',
            fetchedAt: now - 3 * 24 * 60 * 60 * 1000,
            domain: 'docs.example.com',
          },
        ],
        confidence: 0.8,
        coverage: 0.75,
        version: 3,
        createdAt: now - 30 * 24 * 60 * 60 * 1000,
        updatedAt: now - 3 * 24 * 60 * 60 * 1000,
      },
      verifierResult: {
        acceptedClaims: [
          {
            text: 'Feature flags is a deployment technique for releasing code safely.',
            confidence: 0.8,
            sourceIds: ['src-1', 'src-2'],
          },
          {
            text: 'For example, teams compare feature flags versus branch-by-abstraction as a trade-off.',
            confidence: 0.78,
            sourceIds: ['src-1', 'src-2'],
          },
        ],
        rejectedClaims: [],
        conflicts: [],
        metrics: {
          totalClaims: 2,
          acceptedCount: 2,
          rejectedCount: 0,
          conflictCount: 0,
        },
      },
    });

    const gapTypes = result.gaps.map((gap) => gap.type);
    expect(gapTypes).not.toContain('missing_definition');
    expect(gapTypes).not.toContain('missing_comparison');
    expect(gapTypes).not.toContain('missing_example');
    expect(gapTypes).not.toContain('missing_constraints');
    expect(gapTypes).not.toContain('weak_evidence');
    expect(gapTypes).not.toContain('outdated');
    expect(gapTypes).not.toContain('uncertain');
  });

  it('keeps llm-only gap origin when no matching rule gap exists', () => {
    const now = Date.now();
    const result = detectGaps({
      topic: 'Caching',
      now,
      knowledge: {
        id: 'k3',
        canonicalTopic: 'caching',
        aliases: ['caching'],
        claims: [
          {
            id: 'c1',
            text: 'Caching is a method of storing computed results for faster reads.',
            confidence: 0.9,
            sourceIds: ['src-1', 'src-2'],
          },
          {
            id: 'c2',
            text: 'For example, CDN cache and application cache have different invalidation trade-offs.',
            confidence: 0.85,
            sourceIds: ['src-1', 'src-2'],
          },
        ],
        relations: [],
        sources: [
          {
            id: 'src-1',
            url: 'https://developer.mozilla.org',
            fetchedAt: now - 2 * 24 * 60 * 60 * 1000,
            domain: 'developer.mozilla.org',
          },
          {
            id: 'src-2',
            url: 'https://docs.example.com/cache',
            fetchedAt: now - 1 * 24 * 60 * 60 * 1000,
            domain: 'docs.example.com',
          },
        ],
        confidence: 0.85,
        coverage: 0.7,
        version: 2,
        createdAt: now - 10 * 24 * 60 * 60 * 1000,
        updatedAt: now - 1 * 24 * 60 * 60 * 1000,
      },
      llmGaps: [
        {
          type: 'uncertain',
          description: 'Need stronger confidence calibration by source type.',
          priority: 0.72,
        },
      ],
    });

    const uncertain = result.gaps.find((gap) => gap.type === 'uncertain');
    expect(uncertain?.origin).toBe('llm');
    expect(uncertain?.priority).toBe(0.72);
  });
});
