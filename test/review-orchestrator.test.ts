import { afterEach, describe, expect, it } from 'bun:test';
import { resolveCurrentBranch, runReviewAgentic } from '../src/services/review/orchestrator.js';

const envBackup = {
  GNOSIS_ALLOWED_ROOTS: process.env.GNOSIS_ALLOWED_ROOTS,
};

afterEach(() => {
  process.env.GNOSIS_ALLOWED_ROOTS = envBackup.GNOSIS_ALLOWED_ROOTS;
});

describe('review orchestrator wrappers', () => {
  it('returns a no-change result from the agentic entrypoint when diff is empty', async () => {
    process.env.GNOSIS_ALLOWED_ROOTS = '/tmp';

    const result = await runReviewAgentic(
      {
        taskId: 'task-agentic',
        repoPath: '/tmp',
        baseRef: 'main',
        headRef: 'HEAD',
        trigger: 'manual',
        sessionId: 'code-review-repo:main',
        mode: 'git_diff',
      },
      {
        diffProvider: async () => '',
      },
    );

    expect(result.summary).toBe('No changes detected');
    expect(result.review_status).toBe('no_major_findings');
  });

  it('resolves the current branch and falls back to HEAD on invalid paths', async () => {
    const current = await resolveCurrentBranch(process.cwd());
    const missing = await resolveCurrentBranch('/tmp/gnosis-missing-repo');

    expect(current.length).toBeGreaterThan(0);
    expect(missing).toBe('HEAD');
  });
});
