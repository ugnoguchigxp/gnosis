import { afterEach, describe, expect, it, mock } from 'bun:test';
import { formatAlwaysContextRows, server, shouldInjectAlwaysContext } from '../src/mcp/server';
import {
  resetMemoryFetchRunnerForTest,
  resetMemorySearchRunnerForTest,
  resetReviewTaskRunnerForTest,
  setReviewTaskRunnerForTest,
} from '../src/mcp/tools/agentFirst';

type RequestHandler = (request: Record<string, unknown>) => Promise<Record<string, unknown>>;

const getHandler = (method: string): RequestHandler => {
  const handlers = (server as unknown as { _requestHandlers: Map<string, RequestHandler> })
    ._requestHandlers;
  const handler = handlers.get(method);
  if (!handler) {
    throw new Error(`MCP handler not found: ${method}`);
  }
  return handler;
};

describe('mcp contract', () => {
  afterEach(() => {
    resetMemorySearchRunnerForTest();
    resetMemoryFetchRunnerForTest();
    resetReviewTaskRunnerForTest();
  });

  it('exposes expected tool contracts via tools/list', async () => {
    const listHandler = getHandler('tools/list');
    const result = (await listHandler({
      method: 'tools/list',
      params: {},
    })) as {
      tools: Array<{ name: string; inputSchema: Record<string, unknown> }>;
    };

    const toolNames = result.tools.map((tool) => tool.name);
    expect(toolNames).not.toContain('store_memory');
    expect(toolNames).not.toContain('search_unified');
    expect(toolNames).not.toContain('register_guidance');
    expect(toolNames).toContain('initial_instructions');
    expect(toolNames).toContain('agentic_search');
    expect(toolNames).toContain('search_knowledge');
    expect(toolNames).toContain('record_task_note');
    expect(toolNames).toContain('memory_search');
    expect(toolNames).toContain('memory_fetch');
    expect(toolNames).toContain('review_task');
    expect(toolNames).toContain('doctor');
    expect(toolNames).not.toContain('activate_project');
    expect(toolNames).not.toContain('start_task');
    expect(toolNames).not.toContain('finish_task');
    expect(toolNames.length).toBe(8);
  });

  it('returns isError=true for unknown tool and invalid arguments', async () => {
    const callHandler = getHandler('tools/call');

    const unknown = (await callHandler({
      method: 'tools/call',
      params: { name: 'unknown_tool_name', arguments: {} },
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(unknown.isError).toBe(true);
    expect(unknown.content?.[0]?.text).toContain('Unknown tool');

    const hidden = (await callHandler({
      method: 'tools/call',
      params: { name: 'store_memory', arguments: { content: 'only-content' } },
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(hidden.isError).toBe(true);
    expect(hidden.content?.[0]?.text).toContain('Unknown tool');

    const invalid = (await callHandler({
      method: 'tools/call',
      params: { name: 'agentic_search', arguments: {} },
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(invalid.isError).toBe(true);
    expect(invalid.content?.[0]?.text).toContain('userRequest');
  });

  it('injects always context only into bootstrap instructions', () => {
    const matrix: Record<string, boolean> = {
      initial_instructions: true,
      agentic_search: false,
      search_knowledge: false,
      record_task_note: false,
      memory_search: false,
      memory_fetch: false,
      review_task: false,
      doctor: false,
    };

    for (const [toolName, expected] of Object.entries(matrix)) {
      expect(shouldInjectAlwaysContext(toolName)).toBe(expected);
    }
  });

  it('formats bootstrap guidance as compact rules plus tool usage', () => {
    const text = formatAlwaysContextRows([
      {
        name: 'KISS + YAGNI: シンプル優先、未確定機能作成禁止 / DRY: 重複コード共通化',
        type: 'constraint',
        description:
          '## 設計原則\n- **DRY**: 重複コード共通化\n- **KISS + YAGNI**: シンプル優先、未確定機能作成禁止',
        metadata: {},
      },
      {
        name: 'KISS + YAGNI: シンプル優先、未確定機能作成禁止 / DRY: 重複コード共通化',
        type: 'rule',
        description:
          '## 設計原則\n- **DRY**: 重複コード共通化\n- **KISS + YAGNI**: シンプル優先、未確定機能作成禁止',
        metadata: {},
      },
    ]);

    expect(text.startsWith('## 常用ルール')).toBe(true);
    expect(text).toContain('## MCPツール種別');
    expect(text).toContain('`agentic_search`');
    expect(text).not.toContain('現行ユーザー指示と AGENTS.md');
    expect(text).not.toContain('必要な context だけを取り込み');
    expect(text).not.toContain('Gnosis MCP ツール利用ガイド');
    expect(text.match(/設計は KISS\/YAGNI/g)?.length).toBe(1);
  });

  it('review_task call is wired to a review runner instead of the minimal stub', async () => {
    setReviewTaskRunnerForTest(
      mock(async () => ({
        status: 'ok',
        reviewStatus: 'no_major_findings',
        findings: [],
        summary: 'reviewed',
        knowledgeUsed: [],
      })) as never,
    );
    const callHandler = getHandler('tools/call');

    const result = (await callHandler({
      method: 'tools/call',
      params: {
        name: 'review_task',
        arguments: {
          targetType: 'document',
          target: { content: '# Doc\nReview me.' },
          knowledgePolicy: 'off',
        },
      },
    })) as { isError?: boolean; content?: Array<{ text?: string }> };

    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content?.[0]?.text ?? '{}') as Record<string, unknown>;
    expect(payload.status).toBe('ok');
    expect(payload.status).not.toBe('unavailable_in_minimal_mode');
  });
});
