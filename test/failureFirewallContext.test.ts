import { describe, expect, test } from 'bun:test';
import { lookupFailureFirewallContext } from '../src/services/failureFirewall/context.js';

const cacheMissingDiff = [
  'diff --git a/src/users/hooks.ts b/src/users/hooks.ts',
  'index 0000000..1111111 100644',
  '--- a/src/users/hooks.ts',
  '+++ b/src/users/hooks.ts',
  '@@ -1,3 +1,10 @@',
  ' import { useMutation } from "@tanstack/react-query";',
  '+export function useSaveUser() {',
  '+  return useMutation({',
  '+    mutationFn: async (input: UserInput) => {',
  '+      return fetch("/api/users", { method: "POST", body: JSON.stringify(input) });',
  '+    },',
  '+  });',
  '+}',
].join('\n');

describe('failure firewall context lookup', () => {
  test('skips docs-only changes', async () => {
    const context = await lookupFailureFirewallContext({
      files: ['docs/readme.md'],
      changeTypes: ['docs'],
      taskGoal: 'Update docs only',
    });

    expect(context.shouldUse).toBe(false);
    expect(context.suggestedUse).toBe('skip');
    expect(context.reason).toContain('Docs-only');
  });

  test('returns bounded golden path and failure candidates for risky diffs', async () => {
    const context = await lookupFailureFirewallContext({
      rawDiff: cacheMissingDiff,
      maxGoldenPaths: 2,
      maxFailurePatterns: 1,
    });

    expect(context.shouldUse).toBe(true);
    expect(context.riskSignals).toContain('cache_invalidation');
    expect(context.goldenPathCandidates.length).toBeLessThanOrEqual(2);
    expect(context.failurePatternCandidates.length).toBeLessThanOrEqual(1);
  });
});
