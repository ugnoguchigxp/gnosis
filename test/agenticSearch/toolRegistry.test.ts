import { describe, expect, it, mock } from 'bun:test';
import type { AgenticSearchToolExecutorRegistry } from '../../src/services/agenticSearch/toolRegistry.js';
import {
  executeToolCall,
  listAgenticSearchToolSpecs as listSpecs,
} from '../../src/services/agenticSearch/toolRegistry.js';

describe('agenticSearch toolRegistry', () => {
  it('exposes only 3 tool names', () => {
    const names = listSpecs().map((tool) => tool.name);
    expect(names).toEqual(['knowledge_search', 'brave_search', 'fetch']);
  });

  it('has required fields in each input schema', () => {
    const schemaMap = new Map(listSpecs().map((tool) => [tool.name, tool.inputSchema]));
    const knowledgeSchema = schemaMap.get('knowledge_search') as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    const braveSchema = schemaMap.get('brave_search') as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    const fetchSchema = schemaMap.get('fetch') as {
      required?: string[];
      properties?: Record<string, unknown>;
    };

    expect(knowledgeSchema.required).toEqual(['query', 'type']);
    expect(Object.keys(knowledgeSchema.properties ?? {})).toEqual(['query', 'type', 'limit']);
    expect(braveSchema.required).toEqual(['query']);
    expect(Object.keys(braveSchema.properties ?? {})).toEqual(['query', 'count']);
    expect(fetchSchema.required).toEqual(['url']);
    expect(Object.keys(fetchSchema.properties ?? {})).toEqual(['url']);
  });

  it('calls matched executor through registry', async () => {
    const executors: AgenticSearchToolExecutorRegistry = {
      knowledge_search: mock(async () => ({ items: [{ id: 'k1' }] })),
      brave_search: mock(async () => ({ results: [] })),
      fetch: mock(async () => ({ text: 'ok' })),
    };

    const result = await executeToolCall(executors, {
      id: 'call-1',
      name: 'knowledge_search',
      arguments: { query: 'agentic', type: 'rule' },
    });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ items: [{ id: 'k1' }] });
    expect(executors.knowledge_search).toHaveBeenCalledTimes(1);
    expect(executors.brave_search).not.toHaveBeenCalled();
    expect(executors.fetch).not.toHaveBeenCalled();
  });

  it('returns invalid arguments error on schema mismatch', async () => {
    const executors: AgenticSearchToolExecutorRegistry = {
      knowledge_search: mock(async () => ({ items: [] })),
      brave_search: mock(async () => ({ results: [] })),
      fetch: mock(async () => ({ text: 'ok' })),
    };
    const result = await executeToolCall(executors, {
      id: 'call-2',
      name: 'fetch',
      arguments: { url: 'not-url' },
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_ARGUMENTS');
  });
});
