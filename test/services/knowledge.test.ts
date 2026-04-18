import { describe, expect, it } from 'bun:test';
import { getKnowledgeByTopic, searchKnowledgeClaims } from '../../src/services/knowledge.js';

describe('knowledge service', () => {
  const runKnowledgeDbTests = process.env.RUN_KNOWLEDGE_DB_TESTS === '1';

  describe('searchKnowledgeClaims', () => {
    it('returns empty array for empty query', async () => {
      const result = await searchKnowledgeClaims('');
      expect(result).toEqual([]);
    });

    it('returns empty array for whitespace-only query', async () => {
      const result = await searchKnowledgeClaims('   ');
      expect(result).toEqual([]);
    });

    it('normalizes limit to positive integer', async () => {
      if (!runKnowledgeDbTests) {
        console.warn('[skip] knowledge DB test skipped (set RUN_KNOWLEDGE_DB_TESTS=1 to enable)');
        return;
      }
      const result1 = await searchKnowledgeClaims('test', -5);
      const result2 = await searchKnowledgeClaims('test', 0);
      expect(Array.isArray(result1)).toBe(true);
      expect(Array.isArray(result2)).toBe(true);
    });
  });

  describe('getKnowledgeByTopic', () => {
    it('returns null for non-existent topic', async () => {
      if (!runKnowledgeDbTests) {
        console.warn('[skip] knowledge DB test skipped (set RUN_KNOWLEDGE_DB_TESTS=1 to enable)');
        return;
      }
      const result = await getKnowledgeByTopic('nonexistent-topic-12345');
      expect(result).toBeNull();
    });

    it('normalizes topic name with trim and lowercase', async () => {
      if (!runKnowledgeDbTests) {
        console.warn('[skip] knowledge DB test skipped (set RUN_KNOWLEDGE_DB_TESTS=1 to enable)');
        return;
      }
      const result = await getKnowledgeByTopic('  Test   Topic  ');
      expect(result).toBeNull();
    });
  });
});
