import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const mockSyncAllAgentLogs = mock();
mock.module('../../../src/services/sync.js', () => ({
  syncAllAgentLogs: mockSyncAllAgentLogs,
}));

const mockSynthesizeKnowledge = mock();
mock.module('../../../src/services/synthesis.js', () => ({
  synthesizeKnowledge: mockSynthesizeKnowledge,
}));

import { syncTools } from '../../../src/mcp/tools/sync.js';

const getHandler = (name: string) => {
  const tool = syncTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool '${name}' not found`);
  return tool.handler;
};

describe('sync MCP tools', () => {
  beforeEach(() => {
    mockSyncAllAgentLogs.mockReset();
    mockSynthesizeKnowledge.mockReset();
  });

  afterEach(() => {
    mockSyncAllAgentLogs.mockReset();
    mockSynthesizeKnowledge.mockReset();
  });

  describe('sync_agent_logs', () => {
    it('calls syncAllAgentLogs and returns accepted message', async () => {
      const mockResult = { imported: 5, sources: ['Claude Code'] };
      mockSyncAllAgentLogs.mockResolvedValue(mockResult);

      const handler = getHandler('sync_agent_logs');
      const result = await handler({});

      expect(mockSyncAllAgentLogs).toHaveBeenCalledTimes(1);
      expect(result.content[0]?.type).toBe('text');
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain('accepted');
    });

    it('handles empty sync result with accepted message', async () => {
      mockSyncAllAgentLogs.mockResolvedValue({ imported: 0, sources: [] });

      const handler = getHandler('sync_agent_logs');
      const result = await handler({});

      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain('background');
    });
  });

  describe('reflect_on_memories', () => {
    it('calls synthesizeKnowledge and returns accepted message', async () => {
      const mockResult = { count: 3, extractedEntities: 5, extractedRelations: 2 };
      mockSynthesizeKnowledge.mockResolvedValue(mockResult);

      const handler = getHandler('reflect_on_memories');
      const result = await handler({});

      expect(mockSynthesizeKnowledge).toHaveBeenCalledTimes(1);
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain('background');
    });

    it('handles no pending memories result with accepted message', async () => {
      mockSynthesizeKnowledge.mockResolvedValue({ count: 0, message: 'No pending memories.' });

      const handler = getHandler('reflect_on_memories');
      const result = await handler({});

      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain('Reflection');
    });
  });
});
