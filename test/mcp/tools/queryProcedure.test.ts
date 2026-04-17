import { beforeEach, describe, expect, it, mock } from 'bun:test';

const mockQueryProcedure = mock();
mock.module('../../../src/services/procedure.js', () => ({
  queryProcedure: mockQueryProcedure,
}));

import { queryProcedureTools } from '../../../src/mcp/tools/queryProcedure.js';

describe('query_procedure MCP tool', () => {
  const handler = queryProcedureTools.find((t) => t.name === 'query_procedure')?.handler;
  if (!handler) throw new Error('query_procedure tool not found');

  beforeEach(() => {
    mockQueryProcedure.mockReset();
  });

  it('passes expanded applicability filters to service', async () => {
    mockQueryProcedure.mockResolvedValue({
      goal: { id: 'g1', name: 'goal', description: '' },
      tasks: [],
      constraints: [],
    });

    await handler({
      goal: 'Improve code quality',
      context: 'backend maintenance',
      project: 'gnosis',
      domains: ['programming'],
      languages: ['typescript'],
      frameworks: ['drizzle-orm'],
      environment: 'local',
      repo: 'github.com/ugnoguchigxp/gnosis',
    });

    expect(mockQueryProcedure).toHaveBeenCalledTimes(1);
    // biome-ignore lint/suspicious/noExplicitAny: test mock call
    const [goal, options] = (mockQueryProcedure.mock.calls as any)[0];
    expect(goal).toBe('Improve code quality');
    expect(options).toEqual({
      context: 'backend maintenance',
      project: 'gnosis',
      domains: ['programming'],
      languages: ['typescript'],
      frameworks: ['drizzle-orm'],
      environment: 'local',
      repo: 'github.com/ugnoguchigxp/gnosis',
    });
  });
});
