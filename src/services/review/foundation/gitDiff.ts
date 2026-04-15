import { simpleGit } from 'simple-git';

export type ReviewDiffMode = 'git_diff' | 'worktree';

export async function getDiff(repoPath: string, mode: ReviewDiffMode): Promise<string> {
  const git = simpleGit(repoPath);

  if (mode === 'git_diff') {
    const staged = await git.diff(['--cached']);
    if (staged.trim()) return staged;

    const unstaged = await git.diff();
    if (unstaged.trim()) return unstaged;

    return '';
  }

  return git.diff(['HEAD']);
}
