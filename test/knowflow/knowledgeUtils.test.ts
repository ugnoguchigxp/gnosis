import { describe, expect, it } from 'bun:test';
import {
  canonicalizeTopic,
  uniqueNormalizedStrings,
} from '../../src/services/knowflow/knowledge/canonicalize';
import {
  cosineSimilarity,
  fingerprintText,
  jaccardSimilarity,
  shouldMergeClaim,
  shouldMergeClaimText,
} from '../../src/services/knowflow/knowledge/similarity';
import { KnowledgeUpsertInputSchema } from '../../src/services/knowflow/knowledge/types';

describe('knowledge utils', () => {
  it('canonicalizes topics', () => {
    expect(canonicalizeTopic('  TypeScript   Compiler API  ')).toBe('typescript compiler api');
    expect(canonicalizeTopic('Graph-RAG!')).toBe('graph-rag');
    expect(canonicalizeTopic('日本語トピック')).toBe('日本語トピック');
  });

  it('normalizes and deduplicates aliases', () => {
    const result = uniqueNormalizedStrings(['TypeScript', 'typescript', ' TypeScript  ', 'TS']);

    expect(result).toEqual(['typescript', 'ts']);
  });

  it('does not collapse unrelated non-ascii aliases', () => {
    const result = uniqueNormalizedStrings(['日本語トピック', '別トピック', '日本語トピック']);

    expect(result).toEqual(['日本語トピック', '別トピック']);
  });

  it('generates stable fingerprint', () => {
    const a = fingerprintText('TypeScript is typed');
    const b = fingerprintText('typescript is   typed');
    expect(a).toBe(b);
  });

  it('computes jaccard similarity', () => {
    const score = jaccardSimilarity(
      'TypeScript compiler API overview',
      'TypeScript compiler API basics',
    );
    expect(score).toBeGreaterThan(0.3);
    expect(score).toBeLessThan(1);
  });

  it('decides claim merge by similarity or exact fingerprint', () => {
    expect(
      shouldMergeClaimText(
        'TypeScript Compiler API provides AST access',
        'TypeScript Compiler API provides AST access',
      ),
    ).toBe(true);

    expect(
      shouldMergeClaimText('TypeScript Compiler API provides AST access', 'Banana smoothie recipe'),
    ).toBe(false);
  });

  it('computes cosine similarity when vectors are valid', () => {
    const score = cosineSimilarity([1, 0, 0], [0.9, 0.1, 0]);
    expect(score).not.toBeNull();
    expect(score as number).toBeGreaterThan(0.9);
  });

  it('merges claims by embedding when texts differ', () => {
    expect(
      shouldMergeClaim(
        { text: 'TypeScript Compiler API', embedding: [0.1, 0.2, 0.3] },
        { text: 'TS AST access APIs', embedding: [0.11, 0.21, 0.29] },
      ),
    ).toBe(true);
  });

  it('accepts upsert input claims without id', () => {
    const parsed = KnowledgeUpsertInputSchema.parse({
      topic: 'TypeScript',
      claims: [
        {
          text: 'TypeScript has structural typing',
          confidence: 0.8,
          sourceIds: ['src-1'],
        },
      ],
      relations: [],
      sources: [],
    });

    expect(parsed.claims[0]?.id).toBeUndefined();
  });
});
