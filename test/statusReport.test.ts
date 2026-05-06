import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildProjectValueEvidence,
  classifyQueueFailureReason,
  interpretQueueBacklog,
} from '../src/scripts/status-report';

describe('status report queue failure classification', () => {
  it('classifies provider failures separately from generic task failures', () => {
    expect(classifyQueueFailureReason('LLM task failed: All api attempts failed.')).toBe(
      'llm_provider_unavailable',
    );
    expect(
      classifyQueueFailureReason(
        'LLM task failed: All api attempts failed: LLM backend returned a tool/think block parse failure.',
      ),
    ).toBe('llm_control_parse_failure');
    expect(
      classifyQueueFailureReason(
        'LLM research_note output rejected: empty_output_sentinel. LLM research_note output matched empty-output sentinel: 回答を生成できませんでした。',
      ),
    ).toBe('llm_control_parse_failure');
    expect(classifyQueueFailureReason('OpenAI provider rate limit')).toBe(
      'llm_provider_unavailable',
    );
  });

  it('keeps operational failure categories actionable', () => {
    expect(classifyQueueFailureReason('Failed query: select from topic_tasks')).toBe(
      'db_connectivity',
    );
    expect(classifyQueueFailureReason('system:session_distillation requires sessionId')).toBe(
      'input_validation',
    );
    expect(classifyQueueFailureReason('Fetch failed for https://example.com')).toBe(
      'network_or_fetch',
    );
    expect(classifyQueueFailureReason('unexpected crash in worker loop')).toBe('worker_runtime');
  });

  it('separates clear backlog from failed backlog needing attention', () => {
    expect(
      interpretQueueBacklog({
        reachable: true,
        statuses: { pending: 0, running: 0, deferred: 0, failed: 0 },
        failedReasonClasses: [],
      }).status,
    ).toBe('clear');

    const failed = interpretQueueBacklog({
      reachable: true,
      statuses: { pending: 0, running: 0, deferred: 0, failed: 1 },
      failedReasonClasses: [
        {
          reason: 'OpenAI provider rate limit',
          count: 1,
          classification: 'llm_provider_unavailable',
        },
      ],
    });

    expect(failed.status).toBe('needs_attention');
    expect(failed.humanSummary).toContain('failed=1');
    expect(failed.nextCommand).toBe('bun run monitor:knowflow-failures -- --json');
  });

  it('keeps project value evidence conservative when live local review is missing', async () => {
    const previousCwd = process.cwd();
    const tempDir = await mkdtemp(join(tmpdir(), 'gnosis-status-report-'));
    await mkdir(join(tempDir, 'docs/examples'), { recursive: true });
    for (const fileName of [
      'agentic-search-success.md',
      'review-task-success.md',
      'failure-firewall-success.md',
    ]) {
      await writeFile(join(tempDir, 'docs/examples', fileName), '# example\n');
    }

    try {
      process.chdir(tempDir);
      const evidence = buildProjectValueEvidence(
        {
          mcpContract: {
            status: 'passed',
            updatedAt: '2026-05-06T00:00:00.000Z',
            message: 'ok',
          },
          freshCloneValueSmoke: {
            status: 'unknown',
            updatedAt: null,
            message: null,
          },
        },
        {
          reachable: true,
          statuses: { pending: 0, running: 0, deferred: 0, failed: 0 },
          failedReasonClasses: [],
        },
      );

      expect(evidence.reviewTaskLocal.claimAllowed).toBe('missing_evidence');
      expect(evidence.monitorBacklogInterpretation.claimAllowed).toBe('stable_ok');
      expect(evidence.successExamples.status).toBe('passed');
      expect(evidence.scoreReady).toBe(false);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('does not promote smoke artifacts that failed their value-evidence guard', async () => {
    const previousCwd = process.cwd();
    const tempDir = await mkdtemp(join(tmpdir(), 'gnosis-status-report-'));
    await mkdir(join(tempDir, 'docs/examples'), { recursive: true });
    await mkdir(join(tempDir, 'logs'), { recursive: true });
    for (const fileName of [
      'agentic-search-success.md',
      'review-task-success.md',
      'failure-firewall-success.md',
    ]) {
      await writeFile(join(tempDir, 'docs/examples', fileName), '# example\n');
    }
    await writeFile(
      join(tempDir, 'logs/review-task-local-smoke.json'),
      JSON.stringify({
        status: 'ok',
        passed: false,
        durationMs: 1000,
        consecutiveOkRuns: 3,
        reason: 'guard failed',
      }),
    );
    await writeFile(
      join(tempDir, 'logs/fresh-clone-value-smoke.json'),
      JSON.stringify({
        passed: false,
        totalDurationMs: 1000,
        failureReason: 'guard failed',
      }),
    );

    try {
      process.chdir(tempDir);
      const evidence = buildProjectValueEvidence(
        {
          mcpContract: {
            status: 'passed',
            updatedAt: '2026-05-06T00:00:00.000Z',
            message: 'ok',
          },
          freshCloneValueSmoke: {
            status: 'passed',
            updatedAt: '2026-05-06T00:00:00.000Z',
            message: 'ok',
          },
        },
        {
          reachable: true,
          statuses: { pending: 0, running: 0, deferred: 0, failed: 0 },
          failedReasonClasses: [],
        },
      );

      expect(evidence.reviewTaskLocal.claimAllowed).toBe('skipped_with_reason');
      expect(evidence.freshCloneValueArrival.claimAllowed).toBe('structured_degraded_only');
      expect(evidence.missingEvidence).toContain('reviewTaskLocalStableOk');
      expect(evidence.missingEvidence).toContain('freshCloneUnderFiveMinutes');
      expect(evidence.scoreReady).toBe(false);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('requires commit-backed resolution before claiming review finding success evidence', async () => {
    const previousCwd = process.cwd();
    const tempDir = await mkdtemp(join(tmpdir(), 'gnosis-status-report-'));
    await mkdir(join(tempDir, 'docs/examples'), { recursive: true });
    for (const fileName of [
      'agentic-search-success.md',
      'review-task-success.md',
      'failure-firewall-success.md',
    ]) {
      await writeFile(join(tempDir, 'docs/examples', fileName), '# example\n');
    }

    try {
      process.chdir(tempDir);
      const evidence = buildProjectValueEvidence(
        {
          mcpContract: {
            status: 'passed',
            updatedAt: '2026-05-06T00:00:00.000Z',
            message: 'ok',
          },
          freshCloneValueSmoke: {
            status: 'unknown',
            updatedAt: null,
            message: null,
          },
        },
        {
          reachable: true,
          statuses: { pending: 0, running: 0, deferred: 0, failed: 0 },
          failedReasonClasses: [],
        },
        {
          reachable: true,
          totalOutcomes: 2,
          pendingOutcomes: 1,
          adoptedWithoutResolution: 1,
          resolvedWithCommit: 0,
          falsePositiveCount: 0,
          latestResolvedAt: null,
        },
      );

      expect(evidence.reviewFindingResolution.status).toBe('degraded');
      expect(evidence.reviewFindingResolution.claimAllowed).toBe('structured_degraded_only');
      expect(evidence.missingEvidence).toContain('reviewFindingResolution');
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('allows review finding success claims only when all tracked outcomes are resolved or dismissed', async () => {
    const previousCwd = process.cwd();
    const tempDir = await mkdtemp(join(tmpdir(), 'gnosis-status-report-'));
    await mkdir(join(tempDir, 'docs/examples'), { recursive: true });
    await mkdir(join(tempDir, 'logs'), { recursive: true });
    for (const fileName of [
      'agentic-search-success.md',
      'review-task-success.md',
      'failure-firewall-success.md',
    ]) {
      await writeFile(join(tempDir, 'docs/examples', fileName), '# example\n');
    }
    await writeFile(
      join(tempDir, 'logs/review-task-local-smoke.json'),
      JSON.stringify({
        status: 'ok',
        passed: true,
        durationMs: 1000,
        consecutiveOkRuns: 3,
      }),
    );
    await writeFile(
      join(tempDir, 'logs/fresh-clone-value-smoke.json'),
      JSON.stringify({
        passed: true,
        totalDurationMs: 1000,
      }),
    );

    try {
      process.chdir(tempDir);
      const evidence = buildProjectValueEvidence(
        {
          mcpContract: {
            status: 'passed',
            updatedAt: '2026-05-06T00:00:00.000Z',
            message: 'ok',
          },
          freshCloneValueSmoke: {
            status: 'passed',
            updatedAt: '2026-05-06T00:00:00.000Z',
            message: 'ok',
          },
        },
        {
          reachable: true,
          statuses: { pending: 0, running: 0, deferred: 0, failed: 0 },
          failedReasonClasses: [],
        },
        {
          reachable: true,
          totalOutcomes: 2,
          pendingOutcomes: 0,
          adoptedWithoutResolution: 0,
          resolvedWithCommit: 2,
          falsePositiveCount: 0,
          latestResolvedAt: '2026-05-06T00:00:00.000Z',
        },
      );

      expect(evidence.reviewFindingResolution.claimAllowed).toBe('stable_ok');
      expect(evidence.missingEvidence).not.toContain('reviewFindingResolution');
      expect(evidence.scoreReady).toBe(true);
    } finally {
      process.chdir(previousCwd);
    }
  });
});
