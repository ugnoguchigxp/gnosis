import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Pool } from 'pg';

const connectionString = process.env.KNOWLEDGE_POSTGRES_URL ?? process.env.DATABASE_URL;
const shouldRunIntegration = process.env.KNOWFLOW_RUN_INTEGRATION === '1' && !!connectionString;

const describeIntegration = shouldRunIntegration ? describe : describe.skip;

let searchKnowledgeClaims: typeof import('../../src/services/knowledge.js').searchKnowledgeClaims;

describeIntegration('knowledge search integration', () => {
  let pool: Pool;

  beforeAll(async () => {
    if (connectionString && !process.env.DATABASE_URL) {
      process.env.DATABASE_URL = connectionString;
    }
    ({ searchKnowledgeClaims } = await import('../../src/services/knowledge.js'));
    pool = new Pool({ connectionString });
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE knowledge_sources, knowledge_relations, knowledge_claims, knowledge_topics CASCADE',
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('returns FTS-ranked results with score', async () => {
    await pool.query(
      `
      INSERT INTO knowledge_topics (id, canonical_topic, aliases, confidence, coverage, version)
      VALUES ($1, $2, '[]'::jsonb, 0.9, 0.6, 1)
      `,
      ['00000000-0000-0000-0000-000000000001', 'postgresql logical replication'],
    );

    await pool.query(
      `
      INSERT INTO knowledge_claims (id, topic_id, text, confidence, source_ids, fingerprint)
      VALUES
        ($1, $2, $3, 0.9, '["src-a"]'::jsonb, $4),
        ($5, $2, $6, 0.6, '["src-b"]'::jsonb, $7)
      `,
      [
        '00000000-0000-0000-0000-000000000011',
        '00000000-0000-0000-0000-000000000001',
        'Logical replication streams row-level changes between PostgreSQL nodes.',
        'fp-001',
        '00000000-0000-0000-0000-000000000012',
        'Replication slots can retain WAL files until consumers catch up.',
        'fp-002',
      ],
    );

    const results = await searchKnowledgeClaims('logical replication', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.score).toBeGreaterThan(0);
    expect(results[0]?.topic).toBe('postgresql logical replication');
  });

  it('falls back to LIKE when FTS has no hit', async () => {
    await pool.query(
      `
      INSERT INTO knowledge_topics (id, canonical_topic, aliases, confidence, coverage, version)
      VALUES ($1, $2, '[]'::jsonb, 0.8, 0.5, 1)
      `,
      ['00000000-0000-0000-0000-000000000002', 'postgresql replication'],
    );

    await pool.query(
      `
      INSERT INTO knowledge_claims (id, topic_id, text, confidence, source_ids, fingerprint)
      VALUES ($1, $2, $3, 0.7, '["src-c"]'::jsonb, $4)
      `,
      [
        '00000000-0000-0000-0000-000000000021',
        '00000000-0000-0000-0000-000000000002',
        'Replication improves durability and supports read scaling.',
        'fp-003',
      ],
    );

    const results = await searchKnowledgeClaims('replicat', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.score).toBe(0);
    expect(results[0]?.text).toContain('Replication');
  });
});
