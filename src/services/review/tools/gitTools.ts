import { simpleGit } from 'simple-git';
import type { ReviewerToolEntry } from './types.js';

const MAX_GIT_OUTPUT_LINES = 300;

export const gitDiffToolEntry: ReviewerToolEntry = {
  definition: {
    name: 'git_diff',
    description: '指定した ref 間の diff を取得します。',
    inputSchema: {
      type: 'object',
      properties: {
        base_ref: { type: 'string', description: '比較元 (default: HEAD~1)' },
        head_ref: { type: 'string', description: '比較先 (default: HEAD)' },
        file_paths: {
          type: 'array',
          items: { type: 'string' },
          description: '対象ファイルのリスト',
        },
      },
    },
  },
  async handler(args, ctx) {
    const git = simpleGit(ctx.repoPath);
    const base = String(args.base_ref ?? 'HEAD~1');
    const head = String(args.head_ref ?? 'HEAD');
    const files = Array.isArray(args.file_paths) ? (args.file_paths as string[]) : [];

    try {
      const diff = await git.diff([base, head, '--', ...files]);
      const lines = diff.split('\n');
      const sliced = lines.slice(0, MAX_GIT_OUTPUT_LINES);

      return `Diff: ${base}...${head}\n\n${sliced.join('\n')}${
        lines.length > MAX_GIT_OUTPUT_LINES
          ? `\n\n... (Total ${lines.length} lines, truncated)`
          : ''
      }`;
    } catch (error) {
      return `[Error git diff]: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};

export const gitLogToolEntry: ReviewerToolEntry = {
  definition: {
    name: 'git_log',
    description: 'コミット履歴を取得します。',
    inputSchema: {
      type: 'object',
      properties: {
        max_count: { type: 'integer', default: 10, maximum: 50 },
        file_path: { type: 'string', description: '対象ファイルのパス' },
      },
    },
  },
  async handler(args, ctx) {
    const git = simpleGit(ctx.repoPath);
    const limit = Math.min(Number(args.max_count ?? 10), 50);
    const gitArgs = [`-n${limit}`, '--pretty=format:%h %ad | %s [%an]', '--date=short'];

    if (args.file_path) {
      gitArgs.push('--', String(args.file_path));
    }

    try {
      const log = await git.raw(['log', ...gitArgs]);
      return `Git Log (last ${limit}):\n\n${log}`;
    } catch (error) {
      return `[Error git log]: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};

export const gitBlameToolEntry: ReviewerToolEntry = {
  definition: {
    name: 'git_blame',
    description: '指定したファイルの行ごとの最終コミット情報を取得します。',
    inputSchema: {
      type: 'object',
      required: ['file_path'],
      properties: {
        file_path: { type: 'string' },
        start_line: { type: 'integer', minimum: 1 },
        end_line: { type: 'integer', minimum: 1 },
      },
    },
  },
  async handler(args, ctx) {
    const git = simpleGit(ctx.repoPath);
    const filePath = String(args.file_path);
    const gitArgs = [filePath];

    if (args.start_line || args.end_line) {
      const L = `${args.start_line ?? 1},${args.end_line ?? ''}`;
      gitArgs.unshift('-L', L);
    }

    try {
      const blame = await git.raw(['blame', ...gitArgs]);
      return `Git Blame: ${filePath}\n\n${blame}`;
    } catch (error) {
      return `[Error git blame]: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};

export const gitShowToolEntry: ReviewerToolEntry = {
  definition: {
    name: 'git_show',
    description: '特定コミットや参照の内容を確認します。',
    inputSchema: {
      type: 'object',
      required: ['ref'],
      properties: {
        ref: {
          type: 'string',
          description: 'コミットハッシュ、タグ、ブランチ名、または file:path',
        },
      },
    },
  },
  async handler(args, ctx) {
    const git = simpleGit(ctx.repoPath);
    const ref = String(args.ref);

    try {
      const output = await git.show([ref]);
      const lines = output.split('\n');
      const sliced = lines.slice(0, MAX_GIT_OUTPUT_LINES);

      return `Git Show: ${ref}\n\n${sliced.join('\n')}${
        lines.length > MAX_GIT_OUTPUT_LINES
          ? `\n\n... (Total ${lines.length} lines, truncated)`
          : ''
      }`;
    } catch (error) {
      return `[Error git show]: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};
