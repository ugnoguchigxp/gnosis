import { beforeEach, describe, expect, it, mock } from 'bun:test';

const mockSearchKnowledgeV2 = mock();
const mockAgenticSearch = mock();
const mockResolveStaleMetadataSignal = mock();
const mockBuildDoctorRuntimeHealth = mock();
const mockRecordTaskNote = mock();
const mockBuildTask = mock();
const mockSelectPhrases = mock();
const mockSearchWeb = mock();
const mockFetchContent = mock();
const mockRunPromptWithMemoryLoopRouter = mock();

mock.module('../../../src/services/agentFirst.js', () => ({
  searchKnowledgeV2: mockSearchKnowledgeV2,
  agenticSearch: mockAgenticSearch,
  resolveStaleMetadataSignal: mockResolveStaleMetadataSignal,
  buildDoctorRuntimeHealth: mockBuildDoctorRuntimeHealth,
  recordTaskNote: mockRecordTaskNote,
  buildAgenticSearchTaskEnvelope: mockBuildTask,
  selectAgenticSearchPhrases: mockSelectPhrases,
}));

mock.module('../../../src/scripts/webTools.js', () => ({
  searchWeb: mockSearchWeb,
  fetchContent: mockFetchContent,
}));
mock.module('../../../src/services/memoryLoopLlmRouter.js', () => ({
  runPromptWithMemoryLoopRouter: mockRunPromptWithMemoryLoopRouter,
}));

import { agentFirstTools } from '../../../src/mcp/tools/agentFirst.js';

const getHandler = (name: string) => {
  const tool = agentFirstTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Tool '${name}' not found`);
  return tool.handler;
};

describe('agent-first MCP tools minimal flow', () => {
  beforeEach(() => {
    mockSearchKnowledgeV2.mockReset();
    mockAgenticSearch.mockReset();
    mockResolveStaleMetadataSignal.mockReset();
    mockBuildDoctorRuntimeHealth.mockReset();
    mockRecordTaskNote.mockReset();
    mockBuildTask.mockReset();
    mockSelectPhrases.mockReset();
    mockSearchWeb.mockReset();
    mockFetchContent.mockReset();
    mockRunPromptWithMemoryLoopRouter.mockReset();

    mockBuildTask.mockReturnValue({
      request: 'Find guidance',
      intent: 'edit',
      files: [],
      changeTypes: [],
      technologies: [],
      tokens: ['find'],
    });
    mockSelectPhrases.mockReturnValue(['find', 'guidance']);
  });

  it('returns natural answer when SystemContext evaluation accepts agenticSearch output', async () => {
    mockAgenticSearch.mockResolvedValue({
      decision: 'use_knowledge',
      usedKnowledge: [{ title: 'Rule A', summary: 'Use A for this task.' }],
    });
    mockRunPromptWithMemoryLoopRouter.mockResolvedValue({
      output: 'Rule A をこのタスクに適用してください。',
    });

    const handler = getHandler('agentic_search');
    const result = await handler({ userRequest: 'Find guidance' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('Rule A');
    expect(() => JSON.parse(text)).toThrow();
    expect(mockSearchWeb).not.toHaveBeenCalled();
    expect(mockRunPromptWithMemoryLoopRouter).toHaveBeenCalledTimes(1);
  });

  it('uses web fallback and returns answer from fetched page', async () => {
    mockAgenticSearch.mockResolvedValue({ decision: 'no_relevant_knowledge', usedKnowledge: [] });
    mockSearchWeb.mockResolvedValue(
      [
        '- community post (https://a.example.com)',
        '  This is a third-party discussion.',
        '- product docs (https://b.example.com)',
        '  This is the primary documentation.',
      ].join('\n'),
    );
    mockFetchContent.mockResolvedValue(
      'Find guidance for MCP diagnostics. This guidance explains how to verify MCP tool behavior.',
    );
    mockRunPromptWithMemoryLoopRouter
      .mockResolvedValueOnce({
        output: 'https://b.example.com',
      })
      .mockResolvedValueOnce({
        output: 'MCP診断の確認手順として、tool behavior を検証するガイドを参照してください。',
      });

    const handler = getHandler('agentic_search');
    const result = await handler({ userRequest: 'Find guidance' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('MCP診断');
    expect(() => JSON.parse(text)).toThrow();
    expect(mockFetchContent).toHaveBeenCalledTimes(1);
    expect(mockFetchContent).toHaveBeenCalledWith('https://b.example.com');
    expect(mockRunPromptWithMemoryLoopRouter).toHaveBeenCalledTimes(2);
    expect(mockRunPromptWithMemoryLoopRouter.mock.calls[0]?.[0]?.prompt).toContain(
      '公式サイト・一次情報',
    );
  });

  it('stops after up to 3 fetch attempts when answer cannot be built', async () => {
    mockAgenticSearch.mockResolvedValue({ decision: 'no_relevant_knowledge', usedKnowledge: [] });
    mockSearchWeb.mockResolvedValue(
      [1, 2, 3, 4, 5, 6].map((n) => `- ${n} (https://example${n}.com)`).join('\n'),
    );
    mockFetchContent.mockResolvedValue('This page is unrelated to the request topic.');
    mockRunPromptWithMemoryLoopRouter.mockResolvedValue({
      output: '候補だけでは特定できません。',
    });

    const handler = getHandler('agentic_search');
    const result = await handler({ userRequest: 'Find guidance' });
    const text = result.content[0]?.text ?? '';

    expect(text).toBe('結果が見つかりませんでした。');
    expect(mockFetchContent).toHaveBeenCalledTimes(3);
    expect(mockRunPromptWithMemoryLoopRouter).toHaveBeenCalledTimes(4);
  });
});
