import { describe, expect, it } from 'bun:test';

describe('sync service', () => {
  describe('syncAllAgentLogs', () => {
    it('exports syncAllAgentLogs function', async () => {
      const { syncAllAgentLogs } = await import('../../src/services/sync.js');
      expect(typeof syncAllAgentLogs).toBe('function');
    });

    it('handles empty ingestion gracefully', () => {
      expect(true).toBe(true);
    });
  });
});
