import { expect, test } from 'bun:test';
import { buildDeterministicCandidates } from '../src/services/sessionSummary/candidate.js';
import type { SessionTurnBlock } from '../src/services/sessionSummary/types.js';

test('buildDeterministicCandidates marks reusable rules as keep', () => {
  const turn: SessionTurnBlock = {
    turnIndex: 0,
    userMessageId: 'u1',
    userContent: 'verify policy',
    messages: [],
    deterministicIntent: 'verify policy',
    deterministicEvidence: [
      { kind: 'decision', text: 'verify は常に実行する rule', sourceMessageId: 'm1' },
    ],
    deterministicActions: [{ kind: 'command', label: 'bun run verify:fast', status: 'unknown' }],
  };

  const candidates = buildDeterministicCandidates(turn);
  expect(candidates.length).toBeGreaterThan(0);
  expect(candidates.some((c) => c.keep)).toBeTrue();
  expect(candidates.some((c) => c.kind === 'rule' || c.kind === 'procedure')).toBeTrue();
});

test('buildDeterministicCandidates falls back to drop candidate when evidence empty', () => {
  const turn: SessionTurnBlock = {
    turnIndex: 1,
    userMessageId: 'u2',
    userContent: 'hello',
    messages: [],
    deterministicIntent: 'hello',
    deterministicEvidence: [],
    deterministicActions: [],
  };

  const candidates = buildDeterministicCandidates(turn);
  expect(candidates).toHaveLength(1);
  expect(candidates[0]?.keep).toBeFalse();
});
