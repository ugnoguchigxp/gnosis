import { describe, expect, it } from 'bun:test';
import { ReviewerToolRegistry } from './index.js';
import type { ReviewerToolContext, ReviewerToolEntry } from './types.js';

describe('ReviewerToolRegistry', () => {
  const ctx: ReviewerToolContext = {
    repoPath: '/mock/repo',
    gnosisSessionId: 'test-session',
  };

  it('should register and execute a tool', async () => {
    const registry = new ReviewerToolRegistry();
    const testTool: ReviewerToolEntry = {
      definition: {
        name: 'test_tool',
        description: 'A test tool',
        inputSchema: { type: 'object' },
      },
      handler: async (args) => `Hello ${args.name}`,
    };

    registry.register(testTool);
    const result = await registry.execute('test_tool', { name: 'World' }, ctx);
    expect(result).toBe('Hello World');
  });

  it('should throw error for unknown tool', async () => {
    const registry = new ReviewerToolRegistry();
    await expect(registry.execute('unknown', {}, ctx)).rejects.toThrow('Unknown reviewer tool');
  });

  it('should return error message when handler fails', async () => {
    const registry = new ReviewerToolRegistry();
    const failingTool: ReviewerToolEntry = {
      definition: {
        name: 'fail',
        description: 'Fails',
        inputSchema: { type: 'object' },
      },
      handler: async () => {
        throw new Error('Handler failed');
      },
    };

    registry.register(failingTool);
    const result = await registry.execute('fail', {}, ctx);
    expect(result).toBe("[Tool 'fail' failed]: Handler failed");
  });

  it('should convert to LLM tool definitions', () => {
    const registry = new ReviewerToolRegistry();
    registry.register({
      definition: { name: 't1', description: 'd1', inputSchema: { s1: 1 } },
      handler: async () => '',
    });

    const definitions = registry.toLLMToolDefinitions();
    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toEqual({
      name: 't1',
      description: 'd1',
      parameters: { s1: 1 },
    });
  });
});
