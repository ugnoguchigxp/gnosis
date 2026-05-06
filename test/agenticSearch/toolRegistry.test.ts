import { describe, expect, it, mock } from 'bun:test';
import type { AgenticSearchToolExecutorRegistry } from '../../src/services/agenticSearch/toolRegistry.js';
import {
  executeToolCall,
  listAgenticSearchToolSpecs as listSpecs,
} from '../../src/services/agenticSearch/toolRegistry.js';

describe('agenticSearch toolRegistry', () => {
  it('exposes expected tool names', () => {
    const names = listSpecs().map((tool) => tool.name);
    expect(names).toEqual([
      'knowledge_search',
      'brave_search',
      'fetch',
      'memory_search',
      'memory_fetch',
    ]);
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
    const memorySearchSchema = schemaMap.get('memory_search') as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    const memoryFetchSchema = schemaMap.get('memory_fetch') as {
      required?: string[];
      properties?: Record<string, unknown>;
    };

    expect(knowledgeSchema.required).toEqual(['query', 'type']);
    expect(Object.keys(knowledgeSchema.properties ?? {})).toEqual(['query', 'type', 'limit']);
    expect(braveSchema.required).toEqual(['query']);
    expect(Object.keys(braveSchema.properties ?? {})).toEqual(['query', 'count']);
    expect(fetchSchema.required).toEqual(['url']);
    expect(Object.keys(fetchSchema.properties ?? {})).toEqual(['url']);
    expect(memorySearchSchema.required).toEqual(['query']);
    expect(Object.keys(memorySearchSchema.properties ?? {})).toEqual([
      'query',
      'mode',
      'limit',
      'sessionId',
      'memoryType',
      'maxSnippetChars',
    ]);
    expect(memoryFetchSchema.required).toEqual(['id']);
    expect(Object.keys(memoryFetchSchema.properties ?? {})).toEqual([
      'id',
      'query',
      'start',
      'end',
      'maxChars',
    ]);
  });

  it('calls matched executor through registry', async () => {
    const executors: AgenticSearchToolExecutorRegistry = {
      knowledge_search: mock(async () => ({ items: [{ id: 'k1' }] })),
      brave_search: mock(async () => ({ results: [] })),
      fetch: mock(async () => ({ text: 'ok' })),
      memory_search: mock(async () => ({ items: [] })),
      memory_fetch: mock(async () => ({ text: '' })),
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
    expect(executors.memory_search).not.toHaveBeenCalled();
    expect(executors.memory_fetch).not.toHaveBeenCalled();
  });

  it('accepts concept entity knowledge searches', async () => {
    const executors: AgenticSearchToolExecutorRegistry = {
      knowledge_search: mock(async () => ({ items: [{ id: 'concept/property-based-testing' }] })),
      brave_search: mock(async () => ({ results: [] })),
      fetch: mock(async () => ({ text: 'ok' })),
      memory_search: mock(async () => ({ items: [] })),
      memory_fetch: mock(async () => ({ text: '' })),
    };

    const result = await executeToolCall(executors, {
      id: 'call-concept',
      name: 'knowledge_search',
      arguments: { query: 'Property-Based Testing', type: 'concept' },
    });

    expect(result.ok).toBe(true);
    expect(executors.knowledge_search).toHaveBeenCalledWith({
      query: 'Property-Based Testing',
      type: 'concept',
    });
  });

  it('returns invalid arguments error on schema mismatch', async () => {
    const executors: AgenticSearchToolExecutorRegistry = {
      knowledge_search: mock(async () => ({ items: [] })),
      brave_search: mock(async () => ({ results: [] })),
      fetch: mock(async () => ({ text: 'ok' })),
      memory_search: mock(async () => ({ items: [] })),
      memory_fetch: mock(async () => ({ text: '' })),
    };
    const result = await executeToolCall(executors, {
      id: 'call-2',
      name: 'fetch',
      arguments: { url: 'not-url' },
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_ARGUMENTS');

    const blankMemorySearch = await executeToolCall(executors, {
      id: 'call-blank-memory',
      name: 'memory_search',
      arguments: { query: '   ' },
    });
    expect(blankMemorySearch.ok).toBe(false);
    expect(blankMemorySearch.error?.code).toBe('INVALID_ARGUMENTS');
  });

  it('routes memory_search and memory_fetch through their schemas', async () => {
    const executors: AgenticSearchToolExecutorRegistry = {
      knowledge_search: mock(async () => ({ items: [] })),
      brave_search: mock(async () => ({ results: [] })),
      fetch: mock(async () => ({ text: 'ok' })),
      memory_search: mock(async () => ({ items: [{ id: 'm1' }] })),
      memory_fetch: mock(async () => ({ text: 'excerpt' })),
    };

    const searchResult = await executeToolCall(executors, {
      id: 'memory-search-call',
      name: 'memory_search',
      arguments: { query: ' compressed context ', mode: 'like', limit: 3 },
    });
    const fetchResult = await executeToolCall(executors, {
      id: 'memory-fetch-call',
      name: 'memory_fetch',
      arguments: { id: ' m1 ', query: ' context ', maxChars: 1000 },
    });

    expect(searchResult.ok).toBe(true);
    expect(fetchResult.ok).toBe(true);
    expect(executors.memory_search).toHaveBeenCalledWith({
      query: 'compressed context',
      mode: 'like',
      limit: 3,
    });
    expect(executors.memory_fetch).toHaveBeenCalledWith({
      id: 'm1',
      query: 'context',
      maxChars: 1000,
    });
  });
});
