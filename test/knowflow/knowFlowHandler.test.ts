import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('../../src/config.js', () => ({
  config: {
    knowflow: {
      llm: {
        apiBaseUrl: 'http://localhost:8080/v1',
        apiPath: 'chat/completions',
        apiKeyEnv: 'LOCAL_LLM_API_KEY',
        model: 'model',
        temperature: 0.1,
        maxRetries: 1,
        retryDelayMs: 1,
        timeoutMs: 5000,
        enableCliFallback: false,
        cliCommand: 'echo test',
        cliPromptMode: 'arg',
        cliPromptPlaceholder: '{{prompt}}',
      },
      worker: {
        maxQueriesPerTask: 3,
        cronRunWindowMs: 3600000,
      },
    },
    llm: {
      maxBuffer: 1024 * 1024,
      concurrencyLimit: 1,
    },
  },
}));

import type { TopicTask } from '../../src/services/knowflow/domain/task.js';
import {
  createKnowFlowTaskHandler,
  createMcpEvidenceProvider,
} from '../../src/services/knowflow/worker/knowFlowHandler.js';

const makeTask = (overrides: Partial<TopicTask> = {}): TopicTask => ({
  id: 'task-1',
  topic: 'TypeScript compiler API',
  mode: 'directed',
  source: 'user',
  priority: 50,
  status: 'pending',
  attempts: 0,
  dedupeKey: 'typescript-compiler-api',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

const makeDatabase = () => {
  const insertedValues: unknown[] = [];
  const onConflictDoUpdate = mock().mockResolvedValue(undefined);
  const values = mock((payload: unknown) => {
    insertedValues.push(payload);
    return { onConflictDoUpdate };
  });
  const insert = mock(() => ({ values }));
  return { database: { insert } as never, insertedValues, insert, values, onConflictDoUpdate };
};

describe('createMcpEvidenceProvider', () => {
  const mockRunLlmTask = mock();

  beforeEach(() => {
    mockRunLlmTask.mockReset();
  });

  afterEach(() => {
    mockRunLlmTask.mockReset();
  });

  it('fetches search results and asks Research Note Writer for plain text only', async () => {
    mockRunLlmTask.mockResolvedValue({
      task: 'research_note',
      text: 'Use the TypeScript compiler API when AST-level type information is required.',
      backend: 'api',
      warnings: [],
    });

    const retriever = {
      search: mock().mockResolvedValue(`- TS docs (https://typescriptlang.org/docs)
  Compiler API documentation.
- Blog (https://example.com/blog)
  Supporting article.`),
      fetch: mock().mockImplementation(async (url: string) =>
        url === 'https://typescriptlang.org/docs'
          ? 'Title: TypeScript docs\nURL Source: https://typescriptlang.org/docs\nMarkdown Content:\nThe compiler API exposes Program and TypeChecker APIs.'
          : 'AST tooling can use compiler symbols for analysis.',
      ),
      disconnect: mock(),
    };

    const provider = createMcpEvidenceProvider(retriever, {
      runLlmTask: mockRunLlmTask,
    });
    const evidence = await provider(makeTask());

    expect(retriever.search).toHaveBeenCalledWith('TypeScript compiler API', undefined);
    expect(retriever.fetch).toHaveBeenCalledTimes(1);
    expect(mockRunLlmTask).toHaveBeenCalledTimes(1);
    expect(mockRunLlmTask.mock.calls[0]?.[0].task).toBe('research_note');
    expect(mockRunLlmTask.mock.calls[0]?.[0].context.source_texts).toContain('Program');
    expect(mockRunLlmTask.mock.calls[0]?.[0].context.source_texts).not.toContain('https://');
    expect(mockRunLlmTask.mock.calls[0]?.[0].context.source_texts).not.toContain('URL Source');
    expect(evidence.researchNote).toContain('compiler API');
    expect(evidence.referenceUrls).toEqual(['https://typescriptlang.org/docs']);
  });

  it('does not call LLM when no page is fetched', async () => {
    const retriever = {
      search: mock().mockResolvedValue(''),
      fetch: mock(),
      disconnect: mock(),
    };

    const provider = createMcpEvidenceProvider(retriever, {
      runLlmTask: mockRunLlmTask,
    });
    const evidence = await provider(makeTask());

    expect(mockRunLlmTask).not.toHaveBeenCalled();
    expect(evidence.researchNote).toBeUndefined();
    expect(evidence.diagnostics?.outcome).toBe('no_search_results');
  });

  it('does not call LLM when fetched page fails', async () => {
    const retriever = {
      search: mock().mockResolvedValue(`- TS docs (https://typescriptlang.org/docs)
  Compiler API documentation.`),
      fetch: mock().mockRejectedValue(new Error('HTTP 403')),
      disconnect: mock(),
    };

    const provider = createMcpEvidenceProvider(retriever, {
      runLlmTask: mockRunLlmTask,
    });
    const evidence = await provider(makeTask());

    expect(retriever.fetch).toHaveBeenCalledTimes(1);
    expect(mockRunLlmTask).not.toHaveBeenCalled();
    expect(evidence.researchNote).toBeUndefined();
    expect(evidence.diagnostics?.outcome).toBe('fetch_failed');
  });
});

describe('createKnowFlowTaskHandler', () => {
  it('records a concept only when Research Note text exists', async () => {
    const db = makeDatabase();
    const handler = createKnowFlowTaskHandler({
      database: db.database,
      evidenceProvider: mock().mockResolvedValue({
        researchNote: 'Compiler API exposes TypeChecker for semantic analysis.',
        referenceUrls: ['https://typescriptlang.org/docs'],
        fetchedPageCount: 1,
        queryCountUsed: 1,
      }),
    });

    const result = await handler(makeTask());

    expect(result.ok).toBe(true);
    expect(db.insert).toHaveBeenCalledTimes(1);
    const inserted = db.insertedValues[0] as {
      type: string;
      description: string;
      metadata: unknown;
      confidence: unknown;
    };
    expect(inserted.type).toBe('concept');
    expect(inserted.description).toContain('TypeChecker');
    expect(inserted.description).not.toBe('TypeScript compiler API');
    expect(inserted.confidence).toBeNull();
    expect((inserted.metadata as { referenceUrls: string[] }).referenceUrls).toEqual([
      'https://typescriptlang.org/docs',
    ]);
  });

  it('fails the task without creating an entity when the note is empty', async () => {
    const db = makeDatabase();
    const handler = createKnowFlowTaskHandler({
      database: db.database,
      evidenceProvider: mock().mockResolvedValue({
        referenceUrls: ['https://example.com'],
        fetchedPageCount: 1,
        diagnostics: { outcome: 'no_research_note', messages: [] },
      }),
    });

    const result = await handler(makeTask());

    expect(result.ok).toBe(false);
    expect(db.insert).not.toHaveBeenCalled();
  });
});
