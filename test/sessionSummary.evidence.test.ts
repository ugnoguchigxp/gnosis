import { expect, test } from 'bun:test';
import { buildDeterministicEvidenceAndActions } from '../src/services/sessionSummary/evidence.js';
import type { SessionTurnBlock } from '../src/services/sessionSummary/types.js';

function makeTurn(content: string): SessionTurnBlock {
  return {
    turnIndex: 0,
    userMessageId: 'u1',
    userContent: 'request',
    messages: [{ id: 'm1', role: 'assistant', content, createdAt: '2026-05-02T00:00:00Z' }],
    deterministicIntent: 'request',
    deterministicActions: [],
    deterministicEvidence: [],
  };
}

test('buildDeterministicEvidenceAndActions extracts command, file, and error evidence', () => {
  const turn = makeTurn(
    'bun run typecheck failed Error: boom at src/services/foo.ts and docs/plan.md',
  );
  const built = buildDeterministicEvidenceAndActions(turn);

  expect(
    built.deterministicActions.some(
      (a) => a.kind === 'command' && a.label.includes('bun run typecheck'),
    ),
  ).toBeTrue();
  expect(
    built.deterministicActions.some(
      (a) => a.kind === 'file_change' && a.label.includes('src/services/foo.ts'),
    ),
  ).toBeTrue();
  expect(built.deterministicEvidence.some((e) => e.kind === 'error')).toBeTrue();
  expect(
    built.deterministicEvidence.some((e) => e.kind === 'file' && e.text.includes('docs/plan.md')),
  ).toBeTrue();
});
