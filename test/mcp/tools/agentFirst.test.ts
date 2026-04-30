import { beforeEach, describe, expect, it, mock } from 'bun:test';

const mockSearchKnowledgeV2 = mock();
const mockAgenticSearch = mock();
const mockResolveStaleMetadataSignal = mock();
const mockBuildDoctorRuntimeHealth = mock();
const mockRecordTaskNote = mock();
const mockGetReviewLLMService = mock();
const mockRunReviewStageB = mock();
const mockRunReviewStageD = mock();
const mockRunReviewStageE = mock();
const mockReviewDocument = mock();
const mockGenerateImplementationPlan = mock();
const mockAnalyzePlanAlignment = mock();
const mockAnalyzeSpecAlignment = mock();

mock.module('../../../src/services/agentFirst.js', () => ({
  searchKnowledgeV2: mockSearchKnowledgeV2,
  agenticSearch: mockAgenticSearch,
  resolveStaleMetadataSignal: mockResolveStaleMetadataSignal,
  buildDoctorRuntimeHealth: mockBuildDoctorRuntimeHealth,
  recordTaskNote: mockRecordTaskNote,
}));
mock.module('../../../src/services/review/llm/reviewer.js', () => ({
  getReviewLLMService: mockGetReviewLLMService,
}));
mock.module('../../../src/services/review/orchestrator.js', () => ({
  runReviewStageB: mockRunReviewStageB,
  runReviewStageD: mockRunReviewStageD,
  runReviewStageE: mockRunReviewStageE,
}));
mock.module('../../../src/services/reviewAgent/documentReviewer.js', () => ({
  reviewDocument: mockReviewDocument,
}));
mock.module('../../../src/services/specAgent/implementationPlanner.js', () => ({
  generateImplementationPlan: mockGenerateImplementationPlan,
}));
mock.module('../../../src/services/specAgent/planAlignment.js', () => ({
  analyzePlanAlignment: mockAnalyzePlanAlignment,
}));
mock.module('../../../src/services/specAgent/specAlignment.js', () => ({
  analyzeSpecAlignment: mockAnalyzeSpecAlignment,
}));

import { agentFirstTools } from '../../../src/mcp/tools/agentFirst.js';
import { ReviewError } from '../../../src/services/review/errors.js';

const originalReviewer = process.env.GNOSIS_REVIEWER;

const getHandler = (name: string) => {
  const tool = agentFirstTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Tool '${name}' not found`);
  return tool.handler;
};

describe('agent-first MCP tools', () => {
  beforeEach(() => {
    mockSearchKnowledgeV2.mockReset();
    mockAgenticSearch.mockReset();
    mockResolveStaleMetadataSignal.mockReset();
    mockBuildDoctorRuntimeHealth.mockReset();
    mockRecordTaskNote.mockReset();
    mockGetReviewLLMService.mockReset();
    mockRunReviewStageB.mockReset();
    mockRunReviewStageD.mockReset();
    mockRunReviewStageE.mockReset();
    mockReviewDocument.mockReset();
    mockGenerateImplementationPlan.mockReset();
    mockAnalyzePlanAlignment.mockReset();
    mockAnalyzeSpecAlignment.mockReset();
    if (originalReviewer === undefined) {
      process.env.GNOSIS_REVIEWER = undefined;
    } else {
      process.env.GNOSIS_REVIEWER = originalReviewer;
    }
  });

  it('initial_instructions returns lightweight agentic search guidance', async () => {
    const handler = getHandler('initial_instructions');
    const result = await handler({});
    const text = result.content[0]?.text ?? '';
    const payload = JSON.parse(text) as {
      defaultKnowledgeTool?: string;
      rawSearchTool?: string;
      reviewTool?: string;
      saveKnowledgeTool?: string;
      rules?: string[];
    };
    expect(payload.defaultKnowledgeTool).toBe('agentic_search');
    expect(payload.rawSearchTool).toBe('search_knowledge');
    expect(payload.reviewTool).toBe('review_task');
    expect(payload.saveKnowledgeTool).toBe('record_task_note');
    expect(payload.rules?.join('\n')).toContain('Use agentic_search');
    expect(payload.rules?.join('\n')).toContain('Failure Firewall or Golden Path context only');
    expect(payload.rules?.join('\n')).toContain('Before registering implementation learnings');
    expect(payload.rules?.join('\n')).toContain('After verify passes and the user approves commit');
    expect(payload.rules?.join('\n')).toContain('Before final completion reporting');
  });

  it('agentic_search delegates to agenticSearch', async () => {
    mockAgenticSearch.mockResolvedValue({
      taskSummary: 'Refactor lifecycle tools',
      decision: 'use_knowledge',
      usedKnowledge: [],
      diagnostics: {},
    });
    const handler = getHandler('agentic_search');
    const result = await handler({ userRequest: 'Refactor lifecycle tools' });
    expect(mockAgenticSearch).toHaveBeenCalledWith(
      expect.objectContaining({ userRequest: 'Refactor lifecycle tools' }),
    );
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as { decision?: string };
    expect(payload.decision).toBe('use_knowledge');
  });

  it('search_knowledge delegates to service with validated args', async () => {
    mockSearchKnowledgeV2.mockResolvedValue({ groups: [], flatTopHits: [] });
    const handler = getHandler('search_knowledge');
    const result = await handler({
      query: 'risk',
      taskGoal: 'Refactor MCP rule lookup',
      changeTypes: ['mcp', 'refactor'],
      technologies: ['typescript', 'mcp'],
      grouping: 'flat',
    });
    expect(mockSearchKnowledgeV2).toHaveBeenCalledWith(
      expect.objectContaining({
        taskGoal: 'Refactor MCP rule lookup',
        changeTypes: ['mcp', 'refactor'],
        technologies: ['typescript', 'mcp'],
      }),
    );
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as { flatTopHits?: unknown[] };
    expect(Array.isArray(payload.flatTopHits)).toBe(true);
  });

  it('doctor returns stale metadata payload', async () => {
    mockResolveStaleMetadataSignal.mockResolvedValue({
      status: 'unknown',
      reasons: ['client_snapshot_unavailable'],
      evidence: [],
    });
    mockBuildDoctorRuntimeHealth.mockResolvedValue({
      toolVisibility: {
        status: 'ok',
        exposedToolCount: 8,
        requiredPrimaryTools: [],
        presentPrimaryTools: [],
        missingPrimaryTools: [],
      },
      db: { status: 'ok' },
      knowledgeIndex: { status: 'fresh', staleAfterHours: 72 },
    });
    const handler = getHandler('doctor');
    const result = await handler({});
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as {
      staleMetadata?: { status?: string };
    };
    expect(payload.staleMetadata?.status).toBe('unknown');
    expect((payload as { toolVisibility?: { status?: string } }).toolVisibility?.status).toBe('ok');
  });

  it('record_task_note delegates to recordTaskNote', async () => {
    mockRecordTaskNote.mockResolvedValue({ saved: true, entityId: 'rule/r1' });
    const handler = getHandler('record_task_note');
    const result = await handler({ content: 'Always run typecheck' });
    expect(mockRecordTaskNote).toHaveBeenCalled();
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as { saved?: boolean };
    expect(payload.saved).toBe(true);
  });

  it('review_task returns wrapper response with knowledgeUsed', async () => {
    mockAgenticSearch.mockResolvedValue({
      usedKnowledge: [
        {
          id: 'rule/auth-rule',
          kind: 'rule',
          category: 'architecture',
          title: 'Auth rule',
          summary: 'Require auth boundaries in reviewed changes.',
          reason: 'Matched terms',
        },
      ],
    });
    mockGetReviewLLMService.mockResolvedValue({});
    mockRunReviewStageD.mockResolvedValue({
      review_id: 'r1',
      review_status: 'needs_confirmation',
      findings: [
        {
          id: 'f1',
          title: 'Check null handling',
          severity: 'warning',
          confidence: 'high',
          file_path: 'src/a.ts',
          line_new: 10,
          category: 'bug',
          rationale: 'Potential null dereference',
          evidence: 'line 10',
          fingerprint: 'fp1',
          needsHumanConfirmation: false,
          source: 'local_llm',
        },
      ],
      summary: '1 finding',
      next_actions: [],
      rerun_review: false,
      metadata: {
        reviewed_files: 1,
        risk_level: 'medium',
        static_analysis_used: false,
        knowledge_applied: [],
        degraded_mode: false,
        degraded_reasons: [],
        local_llm_used: true,
        heavy_llm_used: false,
        review_duration_ms: 1000,
      },
      markdown: '',
    });

    const handler = getHandler('review_task');
    const result = await handler({
      targetType: 'code_diff',
      target: { diff: 'diff --git a b' },
      provider: 'local',
    });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as {
      providerUsed?: string;
      knowledgeUsed?: unknown[];
    };
    expect(payload.providerUsed).toBe('local');
    expect(mockGetReviewLLMService).toHaveBeenCalledWith(
      'local',
      expect.objectContaining({ invoker: 'mcp' }),
    );
    expect(mockRunReviewStageD).toHaveBeenCalledWith(
      expect.objectContaining({ knowledgePolicy: 'required' }),
      expect.anything(),
    );
    const reviewDeps = mockRunReviewStageD.mock.calls[0]?.[1] as {
      retrieveGuidanceFn?: () => Promise<{
        principles: Array<{ id: string; content: string; tags: string[] }>;
      }>;
    };
    const injectedGuidance = await reviewDeps.retrieveGuidanceFn?.();
    expect(injectedGuidance?.principles[0]?.id).toBe('rule/auth-rule');
    expect(injectedGuidance?.principles[0]?.content).toContain('Require auth boundaries');
    expect(injectedGuidance?.principles[0]?.tags).toContain('principle');
    expect(payload.knowledgeUsed?.length).toBe(1);
    expect((payload as { findings?: unknown[] }).findings?.length).toBe(1);
  });

  it('review_task stops before review when required agentic knowledge retrieval degrades', async () => {
    mockAgenticSearch.mockResolvedValue({
      decision: 'degraded',
      usedKnowledge: [],
      diagnostics: { degradedReasons: ['Gemma4 failed'] },
    });

    const handler = getHandler('review_task');
    const result = await handler({
      targetType: 'code_diff',
      target: { diff: 'diff --git a b' },
      provider: 'local',
      knowledgePolicy: 'required',
    });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as {
      summary?: string;
      diagnostics?: { degradedReasons?: string[] };
    };

    expect(result.isError).toBe(true);
    expect(payload.summary).toContain('Knowledge retrieval degraded');
    expect(payload.diagnostics?.degradedReasons).toContain('Gemma4 failed');
    expect(mockRunReviewStageD).not.toHaveBeenCalled();
  });

  it('review_task returns degraded implementation_plan result before MCP host timeout', async () => {
    mockAgenticSearch.mockResolvedValue({ usedKnowledge: [] });
    mockGetReviewLLMService.mockResolvedValue({ provider: 'local' });
    mockReviewDocument.mockRejectedValue(
      new ReviewError('E016', 'Document review timed out after 180000ms'),
    );

    const handler = getHandler('review_task');
    const result = await handler({
      targetType: 'implementation_plan',
      target: { content: '# Plan\n- Run initial_instructions' },
      provider: 'local',
      knowledgePolicy: 'off',
      useKnowledge: false,
    });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as {
      summary?: string;
      findings?: unknown[];
      diagnostics?: { errorCode?: string; timeoutMs?: number; provider?: string };
    };

    expect(mockGetReviewLLMService).toHaveBeenCalledWith(
      'local',
      expect.objectContaining({
        invoker: 'mcp',
        timeoutMs: 90000,
        disableFallback: true,
      }),
    );
    expect(payload.summary).toContain('LLM review degraded');
    expect(payload.findings?.length).toBe(0);
    expect(payload.diagnostics?.errorCode).toBe('E016');
    expect(payload.diagnostics?.timeoutMs).toBe(90000);
    expect(payload.diagnostics?.provider).toBe('local');
    expect(mockGenerateImplementationPlan).not.toHaveBeenCalled();
  });

  it('review_task uses Azure OpenAI as the default MCP reviewer', async () => {
    mockAgenticSearch.mockResolvedValue({ usedKnowledge: [] });
    mockGetReviewLLMService.mockResolvedValue({ provider: 'cloud' });
    mockRunReviewStageD.mockResolvedValue({
      review_id: 'r-openai',
      review_status: 'ok',
      findings: [],
      summary: 'ok',
      next_actions: [],
      rerun_review: false,
      metadata: {
        reviewed_files: 0,
        risk_level: 'low',
        static_analysis_used: false,
        knowledge_applied: [],
        degraded_mode: false,
        degraded_reasons: [],
        local_llm_used: false,
        heavy_llm_used: true,
        review_duration_ms: 1,
      },
      markdown: '',
    });

    const handler = getHandler('review_task');
    const result = await handler({
      targetType: 'code_diff',
      target: { diff: 'diff --git a b' },
    });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as { providerUsed?: string };

    expect(payload.providerUsed).toBe('azure-openai');
    expect(mockGetReviewLLMService).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        invoker: 'mcp',
        timeoutMs: 90000,
        disableFallback: true,
      }),
    );
  });

  it('review_task treats GNOSIS_REVIEWER=openai as Azure OpenAI', async () => {
    process.env.GNOSIS_REVIEWER = 'openai';
    mockAgenticSearch.mockResolvedValue({ usedKnowledge: [] });
    mockGetReviewLLMService.mockResolvedValue({ provider: 'cloud' });
    mockRunReviewStageD.mockResolvedValue({
      review_id: 'r-azure-alias',
      review_status: 'ok',
      findings: [],
      summary: 'ok',
      next_actions: [],
      rerun_review: false,
      metadata: {
        reviewed_files: 0,
        risk_level: 'low',
        static_analysis_used: false,
        knowledge_applied: [],
        degraded_mode: false,
        degraded_reasons: [],
        local_llm_used: false,
        heavy_llm_used: true,
        review_duration_ms: 1,
      },
      markdown: '',
    });

    const handler = getHandler('review_task');
    const result = await handler({
      targetType: 'code_diff',
      target: { diff: 'diff --git a b' },
    });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as { providerUsed?: string };

    expect(payload.providerUsed).toBe('azure-openai');
    expect(mockGetReviewLLMService).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ invoker: 'mcp' }),
    );
  });

  it('review_task forwards explicit cloud provider selection', async () => {
    mockAgenticSearch.mockResolvedValue({ usedKnowledge: [] });
    mockGetReviewLLMService.mockResolvedValue({});
    mockRunReviewStageD.mockResolvedValue({
      review_id: 'r2',
      review_status: 'ok',
      findings: [],
      summary: 'ok',
      next_actions: [],
      rerun_review: false,
      metadata: {
        reviewed_files: 0,
        risk_level: 'low',
        static_analysis_used: false,
        knowledge_applied: [],
        degraded_mode: false,
        degraded_reasons: [],
        local_llm_used: false,
        heavy_llm_used: true,
        review_duration_ms: 1,
      },
      markdown: '',
    });
    const handler = getHandler('review_task');
    await handler({
      targetType: 'code_diff',
      target: { diff: 'diff --git a b' },
      provider: 'openai',
    });
    expect(mockGetReviewLLMService).toHaveBeenCalledWith(
      'azure-openai',
      expect.objectContaining({ invoker: 'mcp' }),
    );
  });
});
