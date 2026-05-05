import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const mockAgenticSearchRun = mock();

import {
  agentFirstTools,
  resetAgenticSearchRunnerForTest,
  setAgenticSearchRunnerForTest,
} from '../../../src/mcp/tools/agentFirst.js';

const getHandler = (name: string) => {
  const tool = agentFirstTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Tool '${name}' not found`);
  return tool.handler;
};

describe('agent-first MCP tools', () => {
  beforeEach(() => {
    mockAgenticSearchRun.mockReset();
    setAgenticSearchRunnerForTest({ run: mockAgenticSearchRun as never });
  });

  afterEach(() => {
    resetAgenticSearchRunnerForTest();
  });

  it('agentic_search delegates to AgenticSearchRunner', async () => {
    mockAgenticSearchRun.mockResolvedValue({ answer: 'Runner answer' });
    const handler = getHandler('agentic_search');
    const result = await handler({ userRequest: 'Find guidance' });
    expect(result.content[0]?.text).toBe('Runner answer');
    expect(mockAgenticSearchRun).toHaveBeenCalledWith({ userRequest: 'Find guidance' });
  });
});
