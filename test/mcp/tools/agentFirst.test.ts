import { beforeEach, describe, expect, it, mock } from 'bun:test';

const mockBuildActivateProjectResult = mock();
const mockSearchKnowledgeV2 = mock();
const mockResolveStaleMetadataSignal = mock();
const mockBuildDoctorRuntimeHealth = mock();
const mockStartTaskTrace = mock();
const mockRecordTaskNote = mock();
const mockFinishTaskTrace = mock();
const mockGetReviewLLMService = mock();
const mockRunReviewStageB = mock();
const mockRunReviewStageD = mock();
const mockRunReviewStageE = mock();
const mockDispatchHookEvent = mock();
const mockReviewDocument = mock();
const mockGenerateImplementationPlan = mock();
const mockAnalyzePlanAlignment = mock();
const mockAnalyzeSpecAlignment = mock();

mock.module('../../../src/services/agentFirst.js', () => ({
  buildActivateProjectResult: mockBuildActivateProjectResult,
  searchKnowledgeV2: mockSearchKnowledgeV2,
  resolveStaleMetadataSignal: mockResolveStaleMetadataSignal,
  buildDoctorRuntimeHealth: mockBuildDoctorRuntimeHealth,
  startTaskTrace: mockStartTaskTrace,
  recordTaskNote: mockRecordTaskNote,
  finishTaskTrace: mockFinishTaskTrace,
}));
mock.module('../../../src/services/review/llm/reviewer.js', () => ({
  getReviewLLMService: mockGetReviewLLMService,
}));
mock.module('../../../src/services/review/orchestrator.js', () => ({
  runReviewStageB: mockRunReviewStageB,
  runReviewStageD: mockRunReviewStageD,
  runReviewStageE: mockRunReviewStageE,
}));
mock.module('../../../src/hooks/service.js', () => ({
  dispatchHookEvent: mockDispatchHookEvent,
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
    mockBuildActivateProjectResult.mockReset();
    mockSearchKnowledgeV2.mockReset();
    mockResolveStaleMetadataSignal.mockReset();
    mockBuildDoctorRuntimeHealth.mockReset();
    mockStartTaskTrace.mockReset();
    mockRecordTaskNote.mockReset();
    mockFinishTaskTrace.mockReset();
    mockGetReviewLLMService.mockReset();
    mockRunReviewStageB.mockReset();
    mockRunReviewStageD.mockReset();
    mockRunReviewStageE.mockReset();
    mockDispatchHookEvent.mockReset();
    mockReviewDocument.mockReset();
    mockGenerateImplementationPlan.mockReset();
    mockAnalyzePlanAlignment.mockReset();
    mockAnalyzeSpecAlignment.mockReset();
    if (originalReviewer === undefined) {
      process.env.GNOSIS_REVIEWER = undefined;
    } else {
      process.env.GNOSIS_REVIEWER = originalReviewer;
    }
    mockDispatchHookEvent.mockResolvedValue({
      blocked: false,
      guidance: [],
      warnings: [],
      riskTags: [],
      candidateIds: [],
      ruleResults: [],
    });
  });

  it('initial_instructions returns first-call guidance', async () => {
    const handler = getHandler('initial_instructions');
    const result = await handler({});
    const text = result.content[0]?.text ?? '';
    const payload = JSON.parse(text) as {
      firstCall?: string;
      alwaysRules?: string[];
      knowledgeLookupDecision?: {
        defaultAction?: string;
        useWhen?: string;
        requiredContext?: string[];
      };
      preImplementationRuleLookup?: { required?: string; tool?: string; preset?: string };
    };
    expect(payload.firstCall).toBe('activate_project');
    expect(payload.alwaysRules).toContain(
      'initial_instructions: once per session; again only before review flow.',
    );
    expect(payload.knowledgeLookupDecision?.defaultAction).toBe('skip_search_knowledge');
    expect(payload.knowledgeLookupDecision?.useWhen).toContain('non-trivial edit/review');
    expect(payload.knowledgeLookupDecision?.requiredContext).toContain('taskGoal');
    expect(payload.preImplementationRuleLookup?.required).toBe('conditional');
    expect(payload.preImplementationRuleLookup?.tool).toBe('search_knowledge');
    expect(payload.preImplementationRuleLookup?.preset).toBe('task_context');
  });

  it('activate_project delegates to buildActivateProjectResult', async () => {
    mockBuildActivateProjectResult.mockResolvedValue({ project: { name: 'gnosis' } });
    const handler = getHandler('activate_project');
    const result = await handler({ projectRoot: '/tmp/gnosis', mode: 'planning' });
    expect(mockBuildActivateProjectResult).toHaveBeenCalledWith('/tmp/gnosis', 'planning');
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as { project?: { name?: string } };
    expect(payload.project?.name).toBe('gnosis');
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

  it('start_task delegates to startTaskTrace', async () => {
    mockStartTaskTrace.mockResolvedValue({ taskId: 'task/1', status: 'started' });
    const handler = getHandler('start_task');
    const result = await handler({ title: 'Implement search' });
    expect(mockStartTaskTrace).toHaveBeenCalled();
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as { taskId?: string };
    expect(payload.taskId).toBe('task/1');
  });

  it('record_task_note delegates to recordTaskNote', async () => {
    mockRecordTaskNote.mockResolvedValue({ saved: true, entityId: 'rule/r1' });
    const handler = getHandler('record_task_note');
    const result = await handler({ content: 'Always run typecheck' });
    expect(mockRecordTaskNote).toHaveBeenCalled();
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as { saved?: boolean };
    expect(payload.saved).toBe(true);
  });

  it('finish_task delegates to finishTaskTrace', async () => {
    mockFinishTaskTrace.mockResolvedValue({ taskId: 'task/1', status: 'completed' });
    const handler = getHandler('finish_task');
    const result = await handler({ taskId: 'task/1', outcome: 'done' });
    expect(mockFinishTaskTrace).toHaveBeenCalled();
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as { status?: string };
    expect(payload.status).toBe('completed');
  });

  it('review_task returns wrapper response with knowledgeUsed', async () => {
    mockSearchKnowledgeV2.mockResolvedValue({
      groups: [
        {
          category: 'architecture',
          hits: [
            {
              slug: 'auth-rule',
              kind: 'rule',
              category: 'architecture',
              title: 'Auth rule',
              reason: 'Matched terms',
            },
          ],
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
    expect(mockDispatchHookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'task.ready_for_review' }),
    );
    expect(mockDispatchHookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'review.completed' }),
    );
    expect(payload.knowledgeUsed?.length).toBe(1);
    expect((payload as { findings?: unknown[] }).findings?.length).toBe(1);
  });

  it('review_task returns degraded implementation_plan result before MCP host timeout', async () => {
    mockSearchKnowledgeV2.mockResolvedValue({ groups: [] });
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
    };

    expect(mockGetReviewLLMService).toHaveBeenCalledWith(
      'local',
      expect.objectContaining({
        invoker: 'mcp',
        timeoutMs: 180000,
        disableFallback: true,
      }),
    );
    expect(payload.summary).toContain('LLM document review degraded');
    expect(payload.findings?.length).toBe(0);
    expect(mockGenerateImplementationPlan).not.toHaveBeenCalled();
  });

  it('review_task uses OpenAI as the default MCP reviewer', async () => {
    mockSearchKnowledgeV2.mockResolvedValue({ groups: [] });
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

    expect(payload.providerUsed).toBe('openai');
    expect(mockGetReviewLLMService).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        invoker: 'mcp',
        timeoutMs: 180000,
        disableFallback: true,
      }),
    );
  });

  it('review_task forwards explicit cloud provider selection', async () => {
    mockSearchKnowledgeV2.mockResolvedValue({ groups: [] });
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
      'openai',
      expect.objectContaining({ invoker: 'mcp' }),
    );
  });
});
