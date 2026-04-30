import { describe, expect, test } from 'bun:test';
import { suggestFailureFirewallLearningCandidates } from '../src/services/failureFirewall/learningCandidates.js';

const cacheMissingDiff = [
  'diff --git a/src/users/hooks.ts b/src/users/hooks.ts',
  'index 0000000..1111111 100644',
  '--- a/src/users/hooks.ts',
  '+++ b/src/users/hooks.ts',
  '@@ -1,3 +1,10 @@',
  ' import { useMutation } from "@tanstack/react-query";',
  '+export function useSaveUser() {',
  '+  return useMutation({',
  '+    mutationFn: async (input: UserInput) => fetch("/api/users", { method: "POST" }),',
  '+  });',
  '+}',
].join('\n');

describe('failure firewall learning candidates', () => {
  test('does not generate candidates before verify passes', () => {
    const output = suggestFailureFirewallLearningCandidates({
      rawDiff: cacheMissingDiff,
      verifyCommand: 'bun run verify',
      verifyPassed: false,
      commitApprovedByUser: true,
    });

    expect(output.candidates).toEqual([]);
    expect(output.skippedReason).toBe('verify_not_passed');
  });

  test('does not generate candidates before user commit approval', () => {
    const output = suggestFailureFirewallLearningCandidates({
      rawDiff: cacheMissingDiff,
      verifyCommand: 'bun run verify',
      verifyPassed: true,
      commitApprovedByUser: false,
    });

    expect(output.candidates).toEqual([]);
    expect(output.skippedReason).toBe('commit_not_approved');
  });

  test('generates success and accepted failure candidates as needs_review', () => {
    const output = suggestFailureFirewallLearningCandidates({
      rawDiff: cacheMissingDiff,
      verifyCommand: 'bun run verify',
      verifyPassed: true,
      commitApprovedByUser: true,
      reviewFindings: [
        {
          title: 'Missing cache invalidation',
          severity: 'error',
          accepted: true,
          filePath: 'src/users/hooks.ts',
        },
      ],
    });

    expect(output.skippedReason).toBeUndefined();
    expect(output.candidates).toHaveLength(2);
    expect(output.candidates.every((candidate) => candidate.status === 'needs_review')).toBe(true);
    expect(output.candidates[0]?.successPattern?.goldenPath.riskSignals).toContain(
      'cache_invalidation',
    );
    expect(output.candidates[1]?.failurePattern?.failureFirewall.goldenPathCandidateId).toBe(
      output.candidates[0]?.candidateId,
    );
  });
});
