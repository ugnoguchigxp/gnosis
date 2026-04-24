import { beforeEach, describe, expect, it, mock } from 'bun:test';

const mockGenerateImplementationPlan = mock();
mock.module('../../../src/services/specAgent/implementationPlanner.js', () => ({
  generateImplementationPlan: mockGenerateImplementationPlan,
}));

import { generateImplementationPlanTools } from '../../../src/mcp/tools/generateImplementationPlan.js';

describe('generate_implementation_plan MCP tool', () => {
  const handler = generateImplementationPlanTools.find(
    (tool) => tool.name === 'generate_implementation_plan',
  )?.handler;
  if (!handler) throw new Error('generate_implementation_plan tool not found');

  beforeEach(() => {
    mockGenerateImplementationPlan.mockReset();
  });

  it('passes planning options to service and returns markdown in payload', async () => {
    mockGenerateImplementationPlan.mockResolvedValue({
      goal: { id: 'g1', name: 'goal', description: '' },
      tasks: [{ id: 't1', name: 'task', confidence: 0.8 }],
      constraints: [],
      lessons: [],
      reviewChecklist: ['check 1'],
      markdown: '# Implementation Plan',
    });

    const result = await handler({
      goal: 'Refactor auth',
      context: 'JWT + session',
      project: 'gnosis',
      includeLessons: true,
    });

    expect(mockGenerateImplementationPlan).toHaveBeenCalledTimes(1);
    // biome-ignore lint/suspicious/noExplicitAny: test mock call
    const [input] = (mockGenerateImplementationPlan.mock.calls as any)[0];
    expect(input.goal).toBe('Refactor auth');
    expect(input.project).toBe('gnosis');

    const text = result.content[0]?.text ?? '';
    expect(text).toContain('"markdown":');
    expect(text).toContain('# Implementation Plan');
  });
});
