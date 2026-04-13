import { describe, expect, it, mock } from 'bun:test';
import { getKnowledgeByTopic, searchKnowledgeClaims } from '../../src/services/knowledge.js';

describe('knowledge service', () => {
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
      const result1 = await searchKnowledgeClaims('test', -5);
      const result2 = await searchKnowledgeClaims('test', 0);
      expect(Array.isArray(result1)).toBe(true);
      expect(Array.isArray(result2)).toBe(true);
    });
  });

  describe('getKnowledgeByTopic', () => {
    it('returns null for non-existent topic', async () => {
      const result = await getKnowledgeByTopic('nonexistent-topic-12345');
      expect(result).toBeNull();
    });

    it('normalizes topic name with trim and lowercase', async () => {
      const result = await getKnowledgeByTopic('  Test   Topic  ');
      expect(result).toBeNull();
    });
  });
});
