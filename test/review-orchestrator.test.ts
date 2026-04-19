import { afterEach, describe, expect, it } from 'bun:test';
import {
  resolveCurrentBranch,
  runReviewStageAFromRepo,
  runReviewStageBFromRepo,
  runReviewStageE,
} from '../src/services/review/orchestrator.js';

const envBackup = {
  GNOSIS_ALLOWED_ROOTS: process.env.GNOSIS_ALLOWED_ROOTS,
};

afterEach(() => {
  process.env.GNOSIS_ALLOWED_ROOTS = envBackup.GNOSIS_ALLOWED_ROOTS;
});

describe('review orchestrator wrappers', () => {
  it('returns no-change results from Stage A and Stage B wrappers', async () => {
    process.env.GNOSIS_ALLOWED_ROOTS = '/tmp';

    const stageA = await runReviewStageAFromRepo(
      '/tmp',
      {
        taskId: 'task-a',
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

    const stageB = await runReviewStageBFromRepo(
      '/tmp',
      {
        taskId: 'task-b',
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

    expect(stageA.summary).toBe('No changes detected');
    expect(stageA.review_status).toBe('no_major_findings');
    expect(stageB.summary).toBe('No changes detected');
    expect(stageB.review_status).toBe('no_major_findings');
  });

  it('returns a no-change result from Stage E when the diff is empty', async () => {
    process.env.GNOSIS_ALLOWED_ROOTS = '/tmp';

    const result = await runReviewStageE(
      {
        taskId: 'task-e',
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
    expect(result.findings).toEqual([]);
    expect(result.metadata.reviewed_files).toBe(0);
  });

  it('resolves the current branch and falls back to HEAD on invalid paths', async () => {
    const current = await resolveCurrentBranch(process.cwd());
    const missing = await resolveCurrentBranch('/tmp/gnosis-missing-repo');

    expect(current.length).toBeGreaterThan(0);
    expect(missing).toBe('HEAD');
  });
});
