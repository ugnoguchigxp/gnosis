import { describe, expect, it } from 'bun:test';
import { classifyQueueFailureReason } from '../src/scripts/status-report';

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
});
