import { simpleGit } from 'simple-git';
import type { ReviewerToolEntry } from './types.js';

export const searchCodeToolEntry: ReviewerToolEntry = {
  definition: {
    name: 'search_code',
    description: 'リポジトリ内をキーワードで検索します。',
    inputSchema: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: { type: 'string', description: '検索パターン' },
        include_glob: { type: 'string', description: '対象ファイルのglobパターン' },
        max_results: { type: 'integer', default: 50, maximum: 100 },
      },
    },
  },
  async handler(args, ctx) {
    const pattern = String(args.pattern);
    const git = simpleGit(ctx.repoPath);

    try {
      // Use git grep for speed and ignoring gitignore
      // --fixed-strings to avoid regex exploitation
      // -n for line numbers
      const grepArgs = ['--fixed-strings', '-n', '--', pattern];
      if (args.include_glob) {
        grepArgs.push(String(args.include_glob));
      }

      const result = await git.raw(['grep', ...grepArgs]);
      const lines = result.split('\n').filter(Boolean);
      const limit = Math.min(Number(args.max_results ?? 50), 100);

      const sliced = lines.slice(0, limit);
      const output = sliced.join('\n');

      return `Search results for "${pattern}":\n\n${output}${
        lines.length > limit
          ? `\n\n... (Total ${lines.length} matches, showing first ${limit})`
          : ''
      }`;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('exit code 1')) {
        return `No matches found for "${pattern}".`;
      }
      return `[Error searching code]: ${msg}`;
    }
  },
};
